import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, RefObject } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readClipboardImage, readFileBytes } from "../lib/tauri";
import { basenameOfPath } from "../lib/paths";
import { describeIpcError } from "../lib/ipcError";
import {
  addImageAttachments,
  imageMarker,
  insertAtCaret,
  MAX_CHAT_ATTACHMENTS,
  releaseAttachment,
  renumberImageMarkers,
  shiftImageMarkers,
  type ChatComposerAttachment,
} from "../lib/chatAttachments";
import {
  inferAttachmentMimeType,
  shouldPreferSpreadsheetClipboardText,
} from "../lib/chatAttachmentMetadata";

/**
 * The composer's **Attachment** lifecycle (issue #135 §1): the `attachments`
 * cell, the live `attachmentsRef` mirror, the held-for-send map, and the five
 * handlers `ChatStream` threads into `ComposerRow` (`stageFiles`, `handlePaste`,
 * `handleDrop`, `handleAttachClick`, `removeAttachment`) — all MOVED VERBATIM
 * out of `ChatStream.tsx`, comments and load-bearing details included. Nothing
 * here is improved: the WebKitGTK empty-paste clipboard fallback, the caret rule
 * ("CARET ONLY WHEN THE TEXTAREA ACTUALLY HAS FOCUS"), the whole-batch single
 * marker insert, `removeAttachment`'s revoke-outside-the-updater order and the
 * failed-send restore's marker shift are the code that shipped, re-pointed at
 * the hook's own state.
 *
 * The hook OWNS the attachments cell, `attachmentsRef` and `heldForSendRef`. It
 * OWNS NEITHER the draft NOR the composer ref: eleven sites in the caller write
 * the draft (`send` wipes it, the queue fork wipes it, `stageFiles` and
 * `removeAttachment` write the `[image #N]` markers into it), so no hook can own
 * it — the house precedent is `useMentionPicker`, whose header says the hook
 * never owns the draft. The draft is therefore read through the caller's
 * `draftRef` argument (never a render closure — the same reason `attachmentsRef`
 * exists) and written through its `setDraft`. `setError` is an argument for the
 * same reason: the composer's error line has one owner in `ChatStream` (send,
 * resume and the picker-read failure all write it), and `restoreHeldForSend`
 * takes it as a parameter for exactly that reason. `imageCapable` /
 * `composerEnabled` arrive as VALUES because both are derived inside
 * `useChatSessionDerivations` (wave 1) — this hook cannot recompute them and does
 * not read a store: the `lib` layer's no-`lib → store` rule and the "receive
 * what you gate on" boundary both hold here.
 *
 * THE HELD-MAP BOUNDARY CONTRACT (wave 3's seam — `send` / `flushHead` are the
 * only other callers): the map is keyed by **session id**; the sent subset LEAVES
 * `attachments` at send (`moveOutForSend`, held NOT released) and returns on
 * failure (`restoreHeldForSend`), which merges the held list IN FRONT of whatever
 * is staged now, de-dupes by `id`, respects `MAX_CHAT_ATTACHMENTS`, releases the
 * overflow, shifts the draft's markers by the number ACTUALLY restored, and lands
 * the error line in the SAME synchronous block (React 19 batching — an `await`
 * between the restore and `setError` lets a test observe the pre-restore DOM).
 * `releaseHeldForSend` is the success path and the session-switch / unmount
 * cleanup; `clearAll` is the session-switch staged clear; `clearStaged` is the
 * ADR-0069 queue fork's NON-revoking clear. The raw map and the raw
 * `setAttachments` are NOT returned: the "who may revoke an object URL" rule
 * lives inside this module, so no caller can grow a second path to the same
 * state.
 *
 * Called from `ChatStream`'s UNCONDITIONAL block, above the `!activeSessionId`
 * early return — the state, the ref and the unmount effect it replaces all ran
 * on the no-session path too.
 */
export interface UseChatAttachmentsArgs {
  setDraft: (value: string) => void;
  setError: (value: string | null) => void;
  draftRef: RefObject<string>;
  activeSessionIdRef: RefObject<string | null>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  imageCapable: boolean;
  composerEnabled: boolean;
}

export interface UseChatAttachmentsResult {
  /** The staged attachments — the strip renders from this state (moved verbatim). */
  attachments: ChatComposerAttachment[];
  /** The LIVE mirror of `attachments`, re-synced every render. Send's mid-async
   * reads (`liveIds` reconcile, the held move, the restore's merged list) use
   * this ref exactly as they did in `ChatStream`. */
  attachmentsRef: RefObject<ChatComposerAttachment[]>;
  stageFiles: (files: File[]) => void;
  handlePaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  handleDrop: (e: DragEvent) => void;
  handleAttachClick: () => Promise<void>;
  removeAttachment: (id: string) => void;
  /**
   * `send`'s `onCommitted`: move the SENT subset out of the live list into the
   * held map — the thumbnails leave the composer AT send, held not released
   * (a failed send puts them back). The caller already guards
   * `sentIds.size > 0 && activeSessionIdRef.current === targetSessionId`.
   */
  moveOutForSend: (targetSessionId: string, sentIds: Set<string>) => void;
  /**
   * `send`'s catch: restore the held list IN FRONT of whatever is staged now,
   * respecting `MAX_CHAT_ATTACHMENTS`, deduping by `id`, releasing the overflow,
   * shifting the draft's marker numbers by the number ACTUALLY restored, and
   * landing the error line in the SAME synchronous block (React 19 batching —
   * see the contract comment that moves verbatim with this block). The CALLER
   * calls this UNCONDITIONALLY after the catch's settle; the hook re-checks
   * `activeSessionIdRef.current === targetSessionId` internally for both the
   * restore and the error line, and always runs the map delete (a no-op once
   * the session-switch effect already released the entry).
   *
   * The `if (back.length > 0) { setDraft(shiftImageMarkers(...)) }` guard moves
   * VERBATIM: the shift runs ONLY inside the same `held && held.length > 0 &&
   * activeSessionIdRef.current === targetSessionId` block, exactly as in
   * `send()`'s catch. This is a MOVE, not an improvement: do NOT hoist the shift
   * out of the guard (it is redundant against `shiftImageMarkers`'s own `by ===
   * 0` no-op, and it stays anyway).
   */
  restoreHeldForSend: (
    targetSessionId: string,
    errorMsg: string,
    setError: (value: string | null) => void,
    setDraft: (value: string) => void,
  ) => void;
  /**
   * Release the held list for a session and drop its map entry (the send
   * SUCCESS path, and the session-switch / unmount cleanups). Never touches the
   * live list — the success path's composer is already clean, and the
   * session-switch path clears the staged list through `clearAll()` separately.
   */
  releaseHeldForSend: (targetSessionId: string) => void;
  /** Session switch: clear + release the STAGED list (the fail-closed guard —
   * the images staged in the session being LEFT must not leak into the next). */
  clearAll: () => void;
  /**
   * The ADR-0069 queue-fork's staged clear: empty the staged list (ref + state)
   * WITHOUT releasing the object URLs — the URLs MOVE with the text into the
   * queue entry (`QueuedPrompt.attachments` owns them from there; revoking
   * here would blank the queue row's preview and the later send). The caller
   * (`send`'s locked fork) reads `attachmentsRef.current` into the entry FIRST,
   * then calls this. The "who may revoke" rule therefore stays inside the hook:
   * no caller is handed the raw `setAttachments`.
   */
  clearStaged: () => void;
}

export function useChatAttachments(
  args: UseChatAttachmentsArgs,
): UseChatAttachmentsResult {
  const {
    draftRef,
    setDraft,
    setError,
    composerRef,
    imageCapable,
    composerEnabled,
    activeSessionIdRef,
  } = args;
  // Image attachments staged in the composer (CONTEXT.md: Attachment).
  const [attachments, setAttachments] = useState<ChatComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  /** Attachments handed to a send that has not settled yet, keyed by session id.
   * They are OUT of `attachments` (so their thumbnails leave the composer
   * immediately) but NOT released — a failed send puts them back. */
  const heldForSendRef = useRef<Map<string, ChatComposerAttachment[]>>(new Map());
  // Re-sync every render: the handlers read the CURRENT list from the ref
  // (a render closure would be stale for fast successive events — e.g.
  // pasting 8 files then a 9th in separate dispatches without a re-render
  // in between). Also read by the unmount-cleanup effect below (the effect
  // intentionally runs once, so the ref is the only live view it has).
  attachmentsRef.current = attachments;
  // Unmount cleanup: revoke the staged object URLs exactly once, on
  // unmount ONLY — revoking on every state change would leak/break live
  // previews (a revoked URL can no longer render the `img`). The held-for-send
  // map is walked too: an unmount while a turn is in flight leaves those
  // attachments in NO state the composer can reach again, so this is their
  // last chance to be released.
  useEffect(
    () => () => {
      attachmentsRef.current.forEach(releaseAttachment);
      heldForSendRef.current.forEach((held) => held.forEach(releaseAttachment));
    },
    [],
  );

  // --- Image-attachment handlers (plain functions, NOT hooks — their
  // placement is flexible; kept with the other handlers). ---
  const stageFiles = (files: File[]) => {
    // Read the CURRENT list from the ref — a render closure would be stale
    // for fast successive events (e.g. pasting 8 files then a 9th in
    // separate dispatches without a re-render in between).
    const stagedBefore = attachmentsRef.current;
    const { attachments: next, rejected } = addImageAttachments(
      stagedBefore,
      files,
    );
    if (next !== stagedBefore) {
      attachmentsRef.current = next;
      setAttachments(next);
      // ── The `[image #N]` markers, for EVERY staging path ────────────────
      // `stageFiles` is the single funnel for all four of them (paste with
      // file items, the WebKitGTK empty-paste clipboard fallback, drag-and-drop
      // and the `+` picker), so one insert here covers all four. Doing it in
      // the callers instead would number a mixed batch `#1, #3` and the number
      // would stop matching the strip.
      // `N` counts the attachments of THIS message (1-based, in staging
      // order) — see `imageMarker` for why a session-wide number would be
      // unresolvable by the model.
      // The count comes from the RETURNED list, never from `files.length`:
      // `addImageAttachments` can reject mid-batch (`continue` on a bad MIME
      // / an oversize file, `break` on the cap), so looping the input would
      // emit a marker for a rejected file and the numbers would then name the
      // wrong picture.
      // ONE string for the WHOLE batch, inserted ONCE (ascending `#k #k+1 …`):
      // inserting one at a time at the same caret would emit `#3 #2 #1` and
      // invert the marker→image mapping on every multi-file paste.
      const markers = next
        .slice(stagedBefore.length)
        .map((_, i) => imageMarker(stagedBefore.length + 1 + i))
        .join(" ");
      // CARET ONLY WHEN THE TEXTAREA ACTUALLY HAS FOCUS. `selectionStart` is
      // `0` for a textarea that has never been focused, and two of these four
      // paths (a drop, and the `+` picker — the native dialog holds focus)
      // routinely run that way, so the naive read would drop every marker at
      // the START of the user's sentence. This is a deliberate divergence from
      // the `selectionStart ?? draft.length` idiom in `handleDrop`'s backstop
      // and `selectMention`, which is safe there only because both are
      // reachable solely after typing (so the field is focused).
      // `draftRef` — not the render closure — for the same reason
      // `attachmentsRef` exists: a 9th paste in a fast sequence would
      // otherwise revert the draft to a stale value and drop the earlier
      // markers.
      const el = composerRef.current;
      const len = draftRef.current.length;
      const caret =
        el && document.activeElement === el ? (el.selectionStart ?? len) : len;
      const inserted = insertAtCaret(draftRef.current, caret, markers);
      setDraft(inserted.text);
      // Restore focus + caret after the controlled `setDraft` (which would
      // otherwise drop both) — the same block `selectMention` uses.
      const pos = inserted.caret;
      requestAnimationFrame(() => {
        const area = composerRef.current;
        if (!area) return;
        area.focus();
        area.setSelectionRange(pos, pos);
      });
    }
    // A successful stage also CLEARS a stale rejection line (null when
    // nothing was rejected) — otherwise a rejection stays visible after the
    // user successfully stages a different image.
    setError(rejected.length > 0 ? rejected.join("; ") : null);
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!imageCapable) return; // fall through: default text paste
    // Pasted images live in `clipboardData.items` (a `ClipboardItem` pulled via
    // `getAsFile()`); `clipboardData.files` is EMPTY in real webviews
    // (WebKit/WebKitGTK, WebView2/Chromium), so derive the file list from
    // `items` instead — keep only `kind === "file"` items, drop null results.
    const files: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    const text = e.clipboardData.getData("text/plain");
    const html = e.clipboardData.getData("text/html");
    // A spreadsheet paste carries TSV (or Excel HTML) alongside the
    // synthetic image — the TEXT wins, so the default paste is untouched.
    if (
      files.length > 0 &&
      !shouldPreferSpreadsheetClipboardText(text, html)
    ) {
      e.preventDefault();
      e.stopPropagation();
      stageFiles(files);
      return;
    }
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
  };

  // Staging attachments is allowed DURING A TURN on all three paths — paste,
  // drop and the `+` picker. The turn (`composerLocked`) is not a capability
  // check, and the three routes used to disagree about it: paste staged mid-turn
  // while drop and the picker refused, so a screenshot pasted mid-turn and a
  // prompt queued with Enter left the image stranded in the composer while the
  // words travelled to the queue row. `imageCapable` is the gate here and it is
  // fail-closed — an agent that does not advertise `promptCapabilities.image`
  // still takes no image on ANY route.
  // The invariant this keeps: a locked composer STAGES, it does not DISPATCH.
  // Enter while locked reaches `send()`, which moves the whole staged set (with
  // its object URLs) into the queue entry alongside the text — so a dropped file
  // never waits in the composer for the turn to end.
  const handleDrop = (e: DragEvent) => {
    if (!imageCapable) return;
    e.preventDefault();
    stageFiles(Array.from(e.dataTransfer.files));
  };

  // The `+` button (the native file picker): the dialog returns PATHS (a
  // webview `File` is not available for a picked file — no `fs` plugin),
  // so the bytes are read via `read_file_bytes` (the Rust command — the
  // image-extension allowlist + the 10 MiB cap re-validated server-side),
  // rebuilt into `File`s (the MIME inferred from the extension), and
  // staged through the SAME `stageFiles` path as a paste / drop (the
  // capability gate + the attachment caps apply identically).
  //
  // NO `composerLocked` term, on purpose: the picker stages, it does not
  // dispatch — see `handleDrop`'s comment for the invariant (staging is allowed
  // during a turn on all three paths; a locked Enter moves the staged set into
  // the queue row). `composerEnabled` DOES stay: a session that cannot be sent
  // to must not accumulate images.
  const handleAttachClick = async () => {
    if (!composerEnabled || !imageCapable) return;
    let raw: string | string[] | null;
    try {
      raw = await open({
        multiple: true,
        // The image allowlist (the SAME set as the backend command — the
        // dialog filters, the command re-validates, `stageFiles` re-validates
        // the MIME a third time).
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "gif", "webp"],
          },
        ],
      });
    } catch {
      return; // the dialog is unavailable (e.g. a non-Tauri context)
    }
    if (raw == null) return; // cancelled
    const paths = Array.isArray(raw) ? raw : [raw];
    const files: File[] = [];
    let readError: string | null = null;
    for (const path of paths) {
      try {
        const bytes = await readFileBytes(path);
        if (!bytes || bytes.length === 0) continue; // not an image (the backend allowlist)
        files.push(
          new File([new Uint8Array(bytes)], basenameOfPath(path), {
            type: inferAttachmentMimeType(path),
          }),
        );
      } catch (e) {
        // A read failure (e.g. the file over the 10 MiB cap — the command
        // rejects): keep the readable selections staged, surface the error
        // only when NOTHING was staged.
        readError = describeIpcError(e);
      }
    }
    if (files.length > 0) {
      stageFiles(files);
    } else if (readError) {
      setError(readError);
    }
  };

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

  // /// ── The held-for-send boundary (wave 3's seam) ─────────────────────────
  function moveOutForSend(targetSessionId: string, sentIds: Set<string>): void {
    const held = attachmentsRef.current.filter((a) => sentIds.has(a.id));
    heldForSendRef.current.set(targetSessionId, held);
    const staged = attachmentsRef.current.filter((a) => !sentIds.has(a.id));
    attachmentsRef.current = staged;
    setAttachments(staged);
  }

  // The failed-send restore. VERBATIM semantics of `send`'s catch block (the
  // comment block above it — the batching contract, the cap, the dedupe, the
  // release of the overflow, the marker shift — moves with it). `errorMsg` is
  // the ALREADY-formatted message; `setError`/`setDraft` are the CALLER's
  // setters, landed in this one synchronous call so the restore, the shift and
  // the error line stay in one React 19 batch, exactly as today.
  function restoreHeldForSend(
    targetSessionId: string,
    errorMsg: string,
    setError: (value: string | null) => void,
    setDraft: (value: string) => void,
  ): void {
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
    // below: the existing test waits on the error line, and it only passes
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
    // The text the user had typed when they pressed Send is still lost on
    // failure (`setDraft("")` ran at send, pre-existing behaviour): what
    // survives is whatever was typed AFTER that, and the shift above keeps
    // ITS markers honest about the restored list.
    //
    // The setError guard mirrors send()'s catch EXACTLY: the error line only
    // when this is still the send's session. The caller calls this
    // UNCONDITIONALLY after the catch's settle — the delete must always run
    // (a no-op once the session-switch effect already released the entry) and
    // the restore + error line stay in this one synchronous call (the React 19
    // batching contract the comment block above documents).
    if (activeSessionIdRef.current === targetSessionId) {
      setError(errorMsg);
    }
  }

  function releaseHeldForSend(targetSessionId: string): void {
    const held = heldForSendRef.current.get(targetSessionId);
    if (held) {
      held.forEach(releaseAttachment);
      heldForSendRef.current.delete(targetSessionId);
    }
  }

  function clearAll(): void {
    attachmentsRef.current.forEach(releaseAttachment);
    attachmentsRef.current = [];
    setAttachments([]);
  }

  function clearStaged(): void {
    // The ADR-0069 queue move: the URLs leave with the text, so NOTHING is
    // released here (releaseAttachment is deliberately NOT called). This is the
    // only surface name that can empty the staged list besides `clearAll`, and
    // it is the ONLY one that does so without revoking — a caller that needs
    // the revoke uses `clearAll`, never the raw setter.
    attachmentsRef.current = [];
    setAttachments([]);
  }

  return {
    attachments,
    attachmentsRef,
    stageFiles,
    handlePaste,
    handleDrop,
    handleAttachClick,
    removeAttachment,
    moveOutForSend,
    restoreHeldForSend,
    releaseHeldForSend,
    clearAll,
    clearStaged,
  };
}
