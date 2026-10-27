import { MutedCaption } from "./MutedCaption";
import { useInteractive } from "../store/interactive";
import type { CostUpdatePayload } from "../store/interactive";

/**
 * The session's cumulative USD figure, one line under the session name.
 *
 * Issue #87's renderer. It prints **exactly what the provider reported** (D4 —
 * never a figure computed from a price table) and it prints **nothing at all**
 * when no call this session ever reported a cost (D5 — "an unknown price renders
 * as nothing, never `$0.00`"). "Cumulative" means the sum of the frames the
 * provider sent, so the copy must never be re-labelled "what this session cost":
 * the summariser's own call is uncosted by design and a grandchild's money stops
 * at its own parent.
 *
 * It reads ONE store key and calls no IPC, which is what keeps it out of the
 * `lib/tauri` mock surface every pane test would otherwise have to carry.
 */

/**
 * The point below which `toFixed(4)` starts lying.
 *
 * `formatCost` (`src/lib/toolOutput.ts`) renders every non-zero figure under
 * `$0.00005` as the literal `"$0.0000"` — and T08's live-proxy probes put the
 * real per-call cost inside that band (`0.000011662`, `4.7597e-6`, `0.00001243`,
 * `2.122e-05`), so a fresh session would read `$0.0000` — "free" — for its first
 * dozen calls while money was genuinely being spent. `formatCost(v) || null`
 * does not save it: `"$0.0000"` is a truthy string.
 *
 * The seam sits at `0.00005` rather than `0.0001` because that is exactly where
 * `toFixed(4)` stops rounding to zero, which makes this rule **byte-identical to
 * `formatCost` across the whole interval `[0.00005, ∞)`** — measured, 0
 * mismatches over 20 000 samples in `[0.00005, 0.01)` and 0 in `[0.001, 20]` —
 * and different from it ONLY strictly below the cliff, where the shared helper
 * is wrong. A `0.0001` seam would create a band in which two surfaces print two
 * strings for the same money.
 *
 * Why the rule is LOCAL and not a `formatCost` change: this file owns it, so it
 * cannot regress anything else, and it is correct whether or not the shared
 * helper is patched. (The shared helper's own sub-cliff band is a separate
 * decision — seam S3b — landed separately, in `lib/toolOutput.ts`.)
 */
const SUB_CLIFF_CEILING = 0.00005;

/**
 * The line's money rule. Three rules, in this order:
 *
 * 1. `null` / non-finite / negative → `null` — no line. Never invent a figure.
 * 2. `0` → the literal `$0.00`. D5 verbatim: a real zero IS a figure, and
 *    routing it through `formatCost` would print nothing (`formatCost(0)` is
 *    `""`), collapsing "free" and "unknown" back into each other.
 * 3. otherwise, print something NON-ZERO. `>= 0.01` → `toFixed(2)`;
 *    `>= 0.00005` → `toFixed(4)` (byte-identical to `formatCost` wherever the
 *    shared helper is truthful); below `0.00005` → two significant digits, e.g.
 *    `$0.000012`; below `1e-6` → `<$0.000001`, a truthful inequality.
 *
 * The invariant this exists to hold: **a non-zero total NEVER renders as
 * `$0.0000`, `$0.00`, or nothing.** Pinned by the cliff cases in
 * `SessionCostLine.test.tsx`, at T08's real measured magnitudes.
 */
function moneyOf(total: number | null): string | null {
  if (total === null || !Number.isFinite(total) || total < 0) return null;
  if (total === 0) return "$0.00";
  if (total >= 0.01) return "$" + total.toFixed(2);
  if (total >= SUB_CLIFF_CEILING) return "$" + total.toFixed(4);
  if (total >= 1e-6) return "$" + Number(total).toPrecision(2);
  return "<$0.000001";
}

export function SessionCostLine({ sessionId }: { sessionId: string | null }) {
  // The same selector shape `SubagentDelegatingCard` uses. No `useSessions`
  // read: the figure lives with the frames that produced it.
  const entry = useInteractive((s) =>
    sessionId === null ? undefined : (s.cost[sessionId] as CostUpdatePayload | undefined),
  );

  // The store normalises every frame, so `costUsd` is either a number or
  // `null`, and it is present after the FIRST frame. There is deliberately no
  // `entry.costUsd ?? entry.cost` fallback here: normalisation is the store's
  // job, and a second fallback in the renderer would be a second source of
  // truth that keeps a store bug invisible.
  const money = moneyOf(entry?.costUsd ?? null);
  if (money === null) return null;

  // The wrapper exists exactly when there is a figure, so it is the element
  // that IS or IS NOT a child of the pane's `gap-4` column — which is what
  // makes the pane's "no phantom gap-child" assertion meaningful. It carries no
  // `className` (the type scale belongs to `MutedCaption`, and an
  // attribute-free wrapper keeps the `className` convention gate out of this
  // file); `MutedCaption` cannot carry the testid because it forwards only
  // `children` / `className` / `title` / `as`.
  return (
    <div data-testid="session-cost">
      <MutedCaption as="p">{money}</MutedCaption>
    </div>
  );
}
