import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long the copy confirmation stays up before it resets. Declared ONCE here
 * — the three copy sites (`CodeBlock`, `AgentText`, `ToolCallCardHeader`) each
 * hard-coded their own `1500` literal before this hook existed.
 *
 * (`AskQuestionCard`'s queued-placeholder timer also waits 1500ms. It is an
 * unrelated machine and is deliberately NOT routed through this constant.)
 */
export const COPY_RESET_MS = 1500;

export interface UseCopyButton {
  /** True from a successful write until `COPY_RESET_MS` later. */
  copied: boolean;
  /** True from a REJECTED write until `COPY_RESET_MS` later. */
  failed: boolean;
  /** Write the text; a no-op when there is nothing to write. */
  copy: () => void;
}

/**
 * The copy→confirm machine: click → write to the clipboard → confirm for
 * `COPY_RESET_MS` → back to idle. One implementation for the three sites that
 * each carried their own `useState` + timer `useRef` + unmount cleanup.
 *
 * Semantics, all of them pinned by a test somewhere:
 * - `copy()` is a NO-OP for nullish/empty text (the failure-tooltip site has no
 *   failure text to copy and must not confirm a copy that never happened).
 * - `navigator.clipboard?.writeText` keeps its optional chain: jsdom and any
 *   non-secure context have no `clipboard`, and a desktop webview can lose it.
 * - A second click REPLACES the pending reset rather than stacking one, so the
 *   confirmation is `COPY_RESET_MS` from the LAST click.
 * - A rejected write sets `failed` and leaves `copied` false; the same reset
 *   timer clears `failed`. This is the one behaviour ADDED by the extraction —
 *   all three copies did `?.then(...)` and therefore silently no-opped on a
 *   rejection. No call site renders `failed` yet; it is state, not an
 *   affordance.
 * - Unmount clears the pending timer, so nothing calls `setState` on a dead tree.
 *
 * **The button markup stays at each call site. Do not "finish the job" by
 * returning a `CopyButton` element from here.** Two independent reasons:
 * 1. The accessible names differ per site (`Copy code` / `Copy response` /
 *    `Copy error`, confirming to `Copied` / `Error copied`) and
 *    `data-testid="copy-response"` must survive — those names are what every
 *    render test scopes its queries by.
 * 2. `ToolCallCardHeader`'s copy button carries a `text-foreground-subtle`
 *    utility that `src/lib/themeTokens.test.ts` counts as one of the 18
 *    de-emphasis text utilities across the three row-consumer files. Moving the
 *    button into a component outside that file list would drop the total and
 *    redden a colour gate for the crime of a refactor. A shared `CopyButton`
 *    is Phase C's decision (C6/C8), made together with that count.
 */
export function useCopyButton(text: string | undefined | null): UseCopyButton {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  // The pending reset, so a second click clears it instead of adding a second.
  const resetRef = useRef<number | null>(null);

  const copy = useCallback(() => {
    if (!text) return;
    void navigator.clipboard?.writeText(text)?.then(
      () => {
        setFailed(false);
        setCopied(true);
        if (resetRef.current !== null) window.clearTimeout(resetRef.current);
        resetRef.current = window.setTimeout(() => setCopied(false), COPY_RESET_MS);
      },
      () => {
        setCopied(false);
        setFailed(true);
        if (resetRef.current !== null) window.clearTimeout(resetRef.current);
        resetRef.current = window.setTimeout(() => setFailed(false), COPY_RESET_MS);
      },
    );
  }, [text]);

  // Unmount cleanup: clears whatever reset is pending (no `setState` on an
  // unmounted component). Runs once on unmount, not per `text` change.
  useEffect(
    () => () => {
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    },
    [],
  );

  return { copied, failed, copy };
}
