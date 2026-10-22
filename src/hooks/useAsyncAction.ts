import { useCallback, useState } from "react";
import { describeIpcError } from "../lib/ipcError";

/**
 * The busy/error machine every IPC-writing component carried by hand
 * (finding 11b): set busy → clear the old error → await the call → on rejection
 * store `describeIpcError(err)` → always clear busy. Six components had their
 * own copy of those five steps (`PermissionPrompt`, `SudoConfirmModal`,
 * `SudoPasswordModal`, `AskQuestionCard`, `NewSpaceDialog`,
 * `SessionConfigSelect`), each spelling `useState<boolean>` + `useState<string
 * | null>` + a `try/catch/finally`, and each therefore free to drift — the two
 * sudo modals guard re-entry and the other four do not, and nothing in the code
 * said which was deliberate.
 *
 * **The guard is opt-in, and that is the whole design.** Four of the six sites
 * have NO re-entrancy protection today: a fast double click fires the IPC call
 * twice, and that is their shipped behaviour. Adding re-entrancy protection to a
 * refactor is a behaviour change wearing a refactor's clothes, so the default
 * `run` does not self-guard; `SudoPasswordModal` (and `SessionConfigSelect`, if
 * it is ever migrated) passes `{ guard: true }`. See the three guard tests —
 * the unguarded overlap and the render-time read of the flag are both pinned,
 * so a later "improvement" has to be a decision with a commit of its own.
 *
 * `run` never rejects. Every call site writes `void respond(...)`, which is only
 * safe because the hand-written handler swallowed the error into `error`; a
 * rejecting `run` would turn all of them into unhandled rejections.
 *
 * Two deliberate omissions:
 * - **No unmount guard.** No site has one today (`finally { setBusy(false) }`
 *   lands on a dead tree, which React 19 ignores), and adding a cancellation
 *   flag would change what a late resolve does.
 * - **No `success` flag / no callback.** The post-success work (`removePrompt`,
 *   `removeRequest`, `onClose`, `addSession`) stays at each site — it is the
 *   part that differs, and it is what the extraction was never supposed to eat.
 */
export interface UseAsyncAction {
  /** True from the start of a `run` until that run's promise settles. */
  busy: boolean;
  /** The `describeIpcError` sentence from the LAST failed run, else `null`. */
  error: string | null;
  /**
   * Run `fn` under the machine. Resolves (never rejects) once `fn`'s promise
   * settles; with `guard: true` a call made while a rendered `busy` is `true`
   * does nothing at all.
   */
  run: (fn: () => Promise<unknown>) => Promise<void>;
  /** Drop the error message without touching `busy` (a caller's own timer). */
  clearError: () => void;
}

export interface UseAsyncActionOptions {
  /**
   * Refuse a `run` while the RENDERED `busy` is `true`. Mirrors today's
   * `if (busy) return` / `if (pending) return` exactly — including the fact that
   * it reads state, not a ref, so two clicks delivered inside one batch both
   * get through.
   */
  guard?: boolean;
}

export function useAsyncAction(
  options: UseAsyncActionOptions = {},
): UseAsyncAction {
  const { guard = false } = options;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `busy` is in these deps because the GUARD branch reads it — and it reads the
  // value from the RENDER, deliberately, because that is what today's
  // `if (busy) return` / `if (pending) return` read. A `useRef` would be a
  // strictly better guard and a behaviour change, so it is not one. The deps
  // array cannot be conditional, so an UNGUARDED `run` re-identifies on a `busy`
  // flip too; harmless, and stated rather than hidden — no call site depends on a
  // stable `run`, because every one wraps it in a fresh inline handler anyway.
  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      if (guard && busy) return;
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (err) {
        // The ONE place the wire error becomes a sentence: `describeIpcError`
        // reads a plain `Err(String)`, a typed envelope's `message`/`kind`, a
        // real `Error`, and anything unstringifiable, and always returns a
        // string.
        setError(describeIpcError(err));
      } finally {
        setBusy(false);
      }
    },
    [guard, busy],
  );

  const clearError = useCallback(() => setError(null), []);

  return { busy, error, run, clearError };
}
