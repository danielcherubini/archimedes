import { create } from "zustand";

interface SubagentSelectionState {
  /** The subagent session id open in the transcript SHEET (`null` = closed).
   * The sheet is `SubagentDetailHost` — the only other reader is
   * `SubagentModals`, which asks whether a sheet is painted before moving its
   * own card panel and never writes here. */
  selectedSessionId: string | null;
  /** Open (or close, with `null`) the transcript sheet for a subagent. THREE
   * writers, and that is the full list: the two rows that OPEN a sheet — a
   * child's row under the "Delegating" card (`SubagentDelegatingCard`) and a
   * child's todo block in the side pane (`TodoBoardPanel`) — plus
   * `SubagentDetailHost` itself, which writes `null` to close the sheet it owns
   * (Esc). Closing is this and nothing more — the `SubagentEntry` stays in
   * `useSubagents`, so the row under the "Delegating" card survives it. */
  select: (sessionId: string | null) => void;
}

export const useSubagentSelection = create<SubagentSelectionState>((set) => ({
  selectedSessionId: null,
  select: (sessionId) => set({ selectedSessionId: sessionId }),
}));
