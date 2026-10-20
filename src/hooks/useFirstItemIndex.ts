import { useState } from "react";
import type { RenderUnit } from "../lib/toolGroups";
import { messageKey, prependedUnitCount } from "../lib/transcript/unitKeys";

export const START_INDEX = 100_000;

function firstKeyOf(units: RenderUnit[]): string | undefined {
  const first = units[0];
  if (!first) return undefined;
  const msg = first.kind === "changes-group" ? first.messages[0] : first.message;
  return msg ? messageKey(msg) : undefined;
}

/**
 * Derives Virtuoso's `firstItemIndex` to anchor scroll position on prepend.
 *
 * Known rarities:
 * - Unit-shrink: a retraction removes the first unit: the old first key is
 *   gone, `prependedUnitCount` returns 0 and the index is deliberately left unchanged.
 */
export function useFirstItemIndex(
  units: RenderUnit[],
  sessionId: string,
  generation: number,
): number {
  const [state, setState] = useState(() => ({
    sessionId,
    generation,
    firstKey: firstKeyOf(units),
    index: START_INDEX,
  }));

  if (state.sessionId !== sessionId || state.generation !== generation) {
    const nextKey = firstKeyOf(units);
    setState({
      sessionId,
      generation,
      firstKey: nextKey,
      index: START_INDEX,
    });
    return START_INDEX;
  }

  const currentFirstKey = firstKeyOf(units);
  if (currentFirstKey !== state.firstKey) {
    const prepended = prependedUnitCount(state.firstKey, units);
    const nextIndex = state.index - prepended;
    setState({
      sessionId,
      generation,
      firstKey: currentFirstKey,
      index: nextIndex,
    });
    return nextIndex;
  }

  return state.index;
}
