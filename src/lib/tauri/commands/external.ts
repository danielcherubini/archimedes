/**
 * External open (ADR 0051 — the policy is Rust's, this is only the wire).
 *
 * `describeIpcError` is this module's ONE dependency outside the IPC shape
 * modules, and the only reason the barrel is not the sole importer of it: the
 * swallow below renders the typed refusal, so the wire error text has to be
 * readable. `ipcError.ts` keeps its own no-imports contract (`ipcError.ts:21`) —
 * the direction is one-way, and `src/lib/tauriBarrel.test.ts` pins that too.
 */

import { invoke } from "@tauri-apps/api/core";
import { describeIpcError } from "../../ipcError";


// ---------------------------------------------------------------------------
// External open (ADR 0051 — the policy is Rust's, this is only the wire)
// ---------------------------------------------------------------------------

/** External open (ADR 0051): hand `href` to the OS default handler. A relative
 * href is a path resolved against `cwd` (the active Session's `cwd`, i.e. its
 * **Space**); with no `cwd` a relative href is refused. NEVER rejects — a
 * refusal or an OS failure lands in `console.warn` with the typed reason. */
export async function externalOpen(
  href: string,
  cwd?: string | null,
): Promise<void> {
  // The classification, the scheme denylist and the path join are ALL in
  // `crate::open` (Rust owns path semantics — a Windows join is not a `/`), so
  // nothing is decided here beyond the wire shape: the command NAME and the two
  // arg KEYS are pinned in `src/lib/tauri.test.ts`, and `cwd` is normalised to
  // an explicit `null` (never an absent key) so the Rust `Option<String>` sees
  // one shape. The swallow is deliberate: every caller is a click handler with
  // no `catch`, and the wire error IS the `OpenError` envelope (ADR 0063,
  // task14) whose `message` is the typed refusal code verbatim
  // (`denied-scheme:…`, `relative-without-cwd`, `os-error:…`);
  // `describeIpcError` renders the message, `OpenErrorKind` in `@/lib/errors`
  // mirrors the frozen kind table.
  try {
    await invoke("external_open", { href, cwd: cwd ?? null });
  } catch (err) {
    console.warn(`external open refused: ${describeIpcError(err)}`, href);
  }
}
