/**
 * Typed wrappers over the updater IPC seam (ADR 0053).
 *
 * The thin-half of a deliberately split feature: the plugin lives in Rust
 * (`src-tauri/src/commands/update.rs`) and the webview holds NO updater or
 * restart rights — no `updater:default`, no `process:default`, no capability
 * entry at all (the same arrangement as `tauri-plugin-notification`). So the
 * renderer's whole surface is these four functions: three commands and one
 * event, and this module decides nothing beyond the wire shape. The names
 * below are the contract; they are pinned in `update.test.ts` because nothing
 * else can see a drift (`tauri.ts:926`'s `listenSessionUpdate` is the listen
 * shape this copies).
 *
 * Two shapes worth reading before using them:
 *
 * * [`CheckOutcome`] has THREE possible outcomes, and the third is a
 *   rejection. `upToDate` is an ANSWER — the endpoint said nothing is newer —
 *   while a failed check REJECTS with the Rust typed code (`release-not-found`,
 *   `network:…`). A 404 on `latest.json` arrives as `release-not-found` and NOT
 *   as `upToDate`, so a caller must never collapse the rejection into "current":
 *   that is how every installed client would read a broken endpoint as being up
 *   to date forever.
 * * [`UpdateProgress`]'s `total` is the download's `Content-Length` when the
 *   server reported one and `null` otherwise (a chunked or gzipped response
 *   reports nothing). It is NOT a running total — `downloaded` already is, the
 *   Rust throttle sums the plugin's per-chunk increments.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IPC_EVENTS } from "./ipc/events";

/** What `check_update` answers: current, or here is what is newer. */
export type CheckOutcome =
  | { state: "upToDate" }
  | {
      state: "available";
      version: string;
      notes: string | null;
      date: string | null;
    };

/** One `update://progress` frame (the Rust side rate-limits these). */
export type UpdateProgress = {
  /** Bytes received so far (the running total, not this chunk's count). */
  downloaded: number;
  /** The download's `Content-Length`, or `null` when the server sent none. */
  total: number | null;
};

/** Ask the configured endpoint whether there is anything newer. */
export async function checkUpdate(): Promise<CheckOutcome> {
  return invoke<CheckOutcome>("check_update");
}

/**
 * Download the newest release and install it.
 *
 * **On Windows this promise NEVER resolves** — the installer is launched and
 * the process exits inside the Rust command, so a caller must paint its
 * "this window is about to close" state BEFORE awaiting, and treat the
 * missing resolution as the success path. On macOS/Linux it resolves once the
 * install is done, and the user still has to relaunch.
 */
export async function installUpdate(): Promise<void> {
  return invoke<void>("install_update");
}

/** Restart into the freshly installed build (never returns — `-> !` in Rust). */
export async function relaunchApp(): Promise<void> {
  return invoke<void>("relaunch_app");
}

/**
 * Subscribe to install progress; returns the unlisten fn (the caller owns it).
 * The event name lives in `ipc/events.ts` with every other name the renderer
 * subscribes to — this module is the 12th `listen*` wrapper, and the only one
 * outside `lib/tauri.ts`.
 */
export function listenUpdateProgress(
  callback: (payload: UpdateProgress) => void,
): Promise<UnlistenFn> {
  return listen<UpdateProgress>(IPC_EVENTS.updateProgress, (event) =>
    callback(event.payload),
  );
}
