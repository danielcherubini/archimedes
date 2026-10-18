/**
 * The one renderer for every rejected Tauri command.
 *
 * A Tauri command rejects with either a plain string (the `Err(String)`
 * commands, still the majority of the surface) or, when the Rust side returns
 * a typed error, a plain OBJECT — `{"kind", "message", …variant fields}`. The
 * old per-site idiom `x instanceof Error ? x.message : String(x)` printed the
 * object case as `[object Object]`, which is why a failed Space start read as
 * `[object Object]`. Every `catch` that shows a rejection to the user calls
 * this instead.
 *
 * Zero imports on purpose: it is used by Settings components that never touch
 * `lib/tauri`, and a formatting helper must not drag `@tauri-apps/api` in.
 *
 * Total — never throws, always returns a string, never returns
 * `[object Object]`. It localizes nothing, prefixes nothing, adds no
 * punctuation: it only chooses which of the available strings to show.
 */

/** The sentinel this function exists to stop printing. */
const OBJECT_SENTINEL = "[object Object]";
const UNKNOWN = "unknown error";

/**
 * Rule 5 — the last resort, and the only step that can throw: `String()`
 * raises `TypeError: Cannot convert object to primitive value` on
 * `Object.create(null)` and on `{ toString: null }`. Unreachable from a real
 * Tauri rejection (the wire is JSON, so plain objects), but the function is
 * documented as total.
 */
function stringify(value: unknown): string {
  try {
    const text = String(value);
    return text === OBJECT_SENTINEL ? UNKNOWN : text;
  } catch {
    return UNKNOWN;
  }
}

/** Read a property without letting a hostile getter throw through the caller. */
function readStringProp(value: object, key: string): string | null {
  try {
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === "string" ? raw : null;
  } catch {
    return null;
  }
}

/** Render a rejected Tauri command as the sentence the user should read. */
export function describeIpcError(err: unknown): string {
  // 1. `Err(String)` — the wire error IS the message.
  if (typeof err === "string") return err;

  // 2. A real `Error` (a JS-side throw, not the IPC path).
  if (err instanceof Error) return err.message;

  if (err !== null && typeof err === "object") {
    // 3. The typed envelope from Rust: `message` is guaranteed to be present
    //    and to be a string. This is the mechanism that fixes the report.
    const message = readStringProp(err, "message");
    if (message !== null) return message;

    // 4. A payload with no usable `message` (an older backend behind a newer
    //    webview): the code is still more readable than the fallback.
    const kind = readStringProp(err, "kind");
    if (kind !== null) return kind;
  }

  // 5. Nothing left to read.
  return stringify(err);
}
