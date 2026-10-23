/**
 * Space BOOKKEEPING: boot's listing, the new-session dialog's folder check, the
 * trusted flag, and "forget this space" (which deletes the row and leaves the
 * conversations stored).
 *
 * The per-Space CATALOG fetchers deliberately do NOT live here — see
 * `./catalogs.ts` for why they are their own domain.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  SpaceCheck,
  SpaceRow,
} from "../types";


// ---------------------------------------------------------------------------
// Spaces commands (boot, the new-session dialog, "forget this space")
// ---------------------------------------------------------------------------

/** All spaces, most recently opened first. */
export async function listSpaces(): Promise<SpaceRow[]> {
  return invoke<SpaceRow[]>("list_spaces");
}


/** "Forget this space": delete the bookkeeping row (conversations stay stored). */
export async function deleteSpace(path: string): Promise<void> {
  return invoke("delete_space", { path });
}


/** Flip a space's trusted flag (no-op for a missing row). */
export async function setSpaceTrusted(path: string, trusted: boolean): Promise<void> {
  return invoke("set_space_trusted", { path, trusted });
}


/** Canonicalize a folder and say whether a space row already exists for it. */
export async function spaceForPath(path: string): Promise<SpaceCheck> {
  return invoke<SpaceCheck>("space_for_path", { path });
}
