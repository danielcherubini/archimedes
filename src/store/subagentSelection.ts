import { create } from "zustand";

interface SubagentSelectionState {
  /** The subagent session id open in the transcript SHEET (`null` = closed).
   * The sheet is `SubagentDetailHost`; this store is ITS state, and the only
   * other reader is `SubagentModals`, which asks whether a sheet is painted
   * before moving its own card panel — it never writes here. */
  selectedSessionId: string | null;
  /** Open (or close, with `null`) the transcript sheet for a subagent. Closing
   * the sheet is this and nothing more — the `SubagentEntry` stays in
   * `useSubagents`, so its row under the "Delegating" card
   * (`SubagentDelegatingCard`, the other writer of this store) survives. */
  select: (sessionId: string | null) => void;
}

export const useSubagentSelection = create<SubagentSelectionState>((set) => ({
  selectedSessionId: null,
  select: (sessionId) => set({ selectedSessionId: sessionId }),
}));
