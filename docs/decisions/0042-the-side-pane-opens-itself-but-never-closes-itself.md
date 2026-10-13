---
status: accepted
date: 2026-10-13
superseded-by:
---

# The Side pane opens itself, and never closes itself

The **Side pane**'s auto behavior was symmetric: `SidePane` watched the open-todo count and
wrote `setSidePaneCollapsed(!visible)` on ANY edge, so a **Todo board** completing
(`visible` 1 → 0) — or the count merely dipping between two `manage_todo_list` writes —
collapsed the frame out from under the user mid-run. Now that a **Subagent session**'s
board counts toward `visible` too (ADR 0041 makes it visible at all), that dip is routine:
a child finishing while its siblings work would close the pane on the exact work still in
flight. We decided the frame may open itself and never close itself — the edge trigger
keeps its `!was && visible` arm and its collapse arm is deleted, so the user's own toggle
is the ONLY thing that collapses the pane.

**Consequences.** A run that finishes leaves the frame open and empty (the Todos section
is data-gated and simply disappears, the session title remains) — the accepted price of
"the surface never disappears on its own". The `prevVisible` ref survives solely to stop a
re-expand on a count change without the 0 → 1 edge, which is what keeps a MANUAL collapse
while work is in flight from being undone. Anything that later wants a "tidy up when the
run ends" rule must be driven by the turn settling, not by the todo count.
