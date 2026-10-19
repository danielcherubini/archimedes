import type { SessionConfigOption, SessionInfo } from "./tauri";

/** The rows the walk touches — only these three fields of `SessionInfo` are
 *  read, and naming them (instead of `SessionInfo[]`) lets a caller pass the
 *  real lists AND lets a test build a row without inventing `capabilities` /
 *  `archived` it does not care about. Structurally compatible with the store's
 *  `SessionInfo[]`, so the call sites pass `s.sessions` unchanged. */
type SessionRow = Pick<SessionInfo, "sessionId" | "configOptions" | "contextUsage">;

/**
 * The SHARED derivation behind the session's config controls (the model
 * picker, the thinking-level picker, the context bar), lifted out of
 * `ChatStream` verbatim so BOTH consumers can run it inside their own zustand
 * selector: the composer used to own these three lines, and they now live at
 * the bottom of the side pane (`SessionConfigBlock`).
 *
 * WHY plain functions over the state shape rather than a hook: the two
 * consumers read DIFFERENT slices for different reasons, and the fallback they
 * share is a walk over the three session lists. A hook would force the pane to
 * subscribe to `activeSessionId` + every list it does not otherwise show; a
 * free function is called inside the selector, so each component subscribes to
 * exactly the VALUE it renders — and only re-renders when that value changes.
 * That is the whole point of the move: the pane's selectors read stores and not
 * the composer's `draft`, so typing cannot re-render the selectors at all (see
 * the memo note in `SessionConfigSelect.tsx` for the cost this replaces).
 *
 * The three lists are walked because a session can live in any of them:
 * `sessions` (live this app run), `historySessions` (stored, archived flag
 * off) and `archivedSessions` (stored, archived flag on — opened from the
 * Archived section). Missing the last one is the bug where an archived
 * session's bar reads 0% and its selectors fall back to empty stubs.
 */

/** The slice of `useSessions` state these derivations walk. Structural (not
 *  `SessionsState`, which the store does not export): a component passes its
 *  whole state object from inside a selector, and a test can build a plain one. */
export interface SessionConfigSource {
  configOptions: Record<string, SessionConfigOption[]>;
  contextUsage: Record<string, { used: number; window: number } | undefined>;
  sessions: SessionRow[];
  historySessions: SessionRow[];
  archivedSessions: SessionRow[];
}

/**
 * The session's config options (model / thinking-level): the store's map
 * FIRST (the freshest — the live frames; a session closed in this app session
 * keeps its last known entry, the close no longer drops it), falling back to
 * the session row's `configOptions` (the Rust `list_sessions` shape —
 * synthesized from the stored `model` / `thinkingLevel`): a STORED session's
 * config block is POPULATED (the selectors render disabled — a stored session
 * can't set config; a resume re-emits the fresh values).
 *
 * `null` (not `[]`) when nothing knows the id, so "no config" stays
 * distinguishable from "config with zero options".
 */
export function sessionConfigOptionsOf(
  s: SessionConfigSource,
  id: string | null,
): SessionConfigOption[] | null {
  if (!id) return null;
  return (
    s.configOptions[id] ??
    s.sessions.find((x) => x.sessionId === id)?.configOptions ??
    s.historySessions.find((x) => x.sessionId === id)?.configOptions ??
    s.archivedSessions.find((x) => x.sessionId === id)?.configOptions ??
    null
  );
}

/**
 * The session's context usage (the context-percentage display — from the
 * harness's `context_usage_update` frames; the store's map first, falling back
 * to the session row's `contextUsage` — a STORED session's last known usage,
 * persisted on every frame): `undefined` until the first frame, so a fresh
 * session shows no percentage.
 *
 * The `??` chain deliberately falls THROUGH an entry that exists but holds
 * `undefined` (the map's value type allows it) — which is also the behaviour
 * these functions were lifted from.
 */
export function contextUsageOf(
  s: SessionConfigSource,
  id: string | null,
): { used: number; window: number } | undefined {
  if (!id) return undefined;
  return (
    s.contextUsage[id] ??
    s.sessions.find((x) => x.sessionId === id)?.contextUsage ??
    s.historySessions.find((x) => x.sessionId === id)?.contextUsage ??
    s.archivedSessions.find((x) => x.sessionId === id)?.contextUsage
  );
}

/**
 * The bar's percentage: `undefined` when there is nothing to show (no usage
 * yet) OR when the window is 0 — the guard is load-bearing, a 0 window would
 * otherwise print `NaN%`. Clamped at 100 (a usage over an under-reported
 * window would otherwise print a bar wider than the bar).
 */
export function contextPercentOf(
  usage: { used: number; window: number } | undefined,
): number | undefined {
  return usage && usage.window > 0
    ? Math.min(100, Math.round((usage.used / usage.window) * 100))
    : undefined;
}

/**
 * The context bar's color ramp (the traffic-light scheme — the label follows
 * the fill's color): green at 0–49%, caution at 50–69%, warning at 70–89%, the
 * destructive red at 90–100%. Context pressure IS a status ramp, so every band
 * rides a semantic token (no raw hue to stand beside a Palette's own yellow);
 * `caution` is the band `success` and `warning` have no room for.
 *
 * An UNKNOWN percentage rides the first band: the bar is always rendered (the
 * fill appears as the session grows), so it has to wear a color before the
 * first frame arrives.
 */
export function contextRampFor(
  percent: number | undefined,
): { fill: string; label: string } {
  return percent === undefined
    ? { fill: "bg-success", label: "text-success" }
    : percent < 50
      ? { fill: "bg-success", label: "text-success" }
      : percent < 70
        ? { fill: "bg-caution", label: "text-caution" }
        : percent < 90
          ? { fill: "bg-warning", label: "text-warning" }
          : { fill: "bg-destructive", label: "text-destructive" };
}

/**
 * The MODEL / THINKING option out of the session's config list: matched by
 * `category` OR by `id` (the ACP spec puts `category` on newer agents' frames
 * and older ones carry only the id), and only a `select` WITH options counts —
 * an empty select is a control with nothing in it, and the call site then
 * renders the disabled stub instead.
 *
 * Takes `null` (the "no config options" value `sessionConfigOptionsOf`
 * returns) so the call site does not need its own guard.
 */
export function findConfigOption(
  options: SessionConfigOption[] | null | undefined,
  category: string,
  id: string,
): SessionConfigOption | undefined {
  return options?.find(
    (o) =>
      (o.category === category || o.id === id) &&
      o.type === "select" &&
      (o.options?.length ?? 0) > 0,
  );
}
