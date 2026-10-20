---
status: live
last-verified: 2026-10-16
verified-by: feature/subagent-liveness-bound — cargo test 1067 + clippy 0 warnings + fmt; pnpm test 1979 + tsc; ADR 0055
---

# Subagent sessions

> **Stale below this line (parts of the Rust half).** The stamp above covers
> the **liveness** rule (ADR 0055 — the drive's race, the `SubagentLiveness`
> signal, the gate-close and failure-`reason` wiring) and the client half; it
> does NOT redeem the **pre-ADR 0025** driver prose below. The intro paragraph,
> the numbered list in "The driver task", the "Metrics are real" paragraph and
> the "Trust inheritance" section still describe the IN-PROCESS driver — a
> throwaway
> `:memory:` `Db`, the `TempFileGuard`, `NativeDeps`, `ExternalClose`,
> `agent/interactive.rs` — none of which exist under `src-tauri/src` any more
> since the drive moved Supervisor-side into `WorkerManager` (ADR 0025). Read
> them as history; the fix is a separate pass — history in git.

A **Subagent session** is a native `AgentLoop` child the desktop spawns **in
process** — the SAME in-process runtime (the main tokio runtime) and the
same shared `SessionDriver` machinery as the parent session (ADR 0011/0022) —
the external `pi` embodiment is removed (ADR 0022), so a subagent session is
always an in-process native child. The `subagent` tool's dispatch
(`dispatch_native` on the `SubagentSessionManager`) `tokio::spawn`s a driver
task that builds the child, drives its single task turn, and resolves with
the final output + metrics. Subagent sessions are **ephemeral** (the driver's `db` is `None` —
the child's `native_messages` writes go to a throwaway `Db` discarded on
teardown) and are excluded from the one-live policy by definition. A
subagent cannot dispatch subagents (the `subagent` tool is stripped from the
child's tool set — the recursion guard).

## Config resolution (layered: explicit > override > frontmatter > parent defaults)

The main agent's `subagent` tool takes `task` (required) + optional
`agentName` / `model` / `systemPrompt` / `tools` / `thinking` (`launch`
params). `agentName` is resolved **case-insensitively against the discovered
Agent definitions** (ADR 0020 — flat `*.md` files, space-level
`.agents/agents` + `.pi/agents` walked up to the repo root, user-level
`~/.agents/agents` + `~/.pi/agent/agents`; advertised by the `list_agents`
tool). An **unknown or omitted `agentName` is a config-less label-only
dispatch** — never an error. The layers:

- **`model`**: the explicit param, else the **settings override** (the
  `settings.json` `agentOverrides` entry for the agent's name — ADR 0066, the
  trio map that replaced ADR 0023's single-field `subagentModels` map (legacy,
  folded into it on read); read at dispatch time; a stale value degrades to the
  next layer, like the frontmatter), else the frontmatter `model`, else the
  parent's model.
  Resolved **at dispatch time against the effective catalog**
  (`EffectiveCatalog::resolve` — the base catalog + the settings' providers
  + live discovery; `NativeDeps` carries a catalog *supplier*, NOT a startup
  snapshot — the base catalog is empty after the pi-config seeding removal,
  so a named agent's `model:` must resolve against user providers). An
  explicit unknown model **fails** the dispatch (`unknown model: …`); a
  frontmatter model that resolves to nothing **degrades** to the next layer
  (a stale user file must not break a dispatch). A trailing `:<level>`
  suffix is stripped for resolution and becomes a thinking-level candidate.
- **`thinking`**: the explicit param, else the model key's `:<level>` suffix,
  else the frontmatter `thinking` (a native extension of the pi agent
  format). Validated against the model's `thinking_levels` (an empty set
  soft-passes; a mismatch is DROPPED — never sent upstream as a bogus
  `reasoning_effort`).
- **`tools`**: the explicit param VERBATIM (a non-empty set that empties out
  after the minus yields NO tools — not re-expanded), else the frontmatter
  `tools` (unknown names dropped; a list that empties out is treated as
  absent), else the parent's `enabled_tools` (the `[]` = all harness
  convention) — **always minus `subagent` AND `list_agents`**.
- **system prompt**: the explicit `systemPrompt`, else the frontmatter body
  (an empty body means "no system prompt"), plus the todo-guidance line when
  the child has `manage_todo_list` (ADR 0017); `None` → no system message.

## The driver task (settle / cancel / teardown)

`dispatch_native` (and the test-only
`dispatch_native_force_temp_file`) call `dispatch_native_inner`, which
`tokio::spawn`s ONE driver task on the **main runtime** (in-process — the
oneshot is the observation point; the `JoinHandle` is detached). The task:

1. Resolves the effective catalog (step 0 — at dispatch time),
2. Opens the **throwaway child `Db`** — `:memory:` first, a temp-file
   fallback (`open_temp_db`), guarded by a `TempFileGuard` held for the
   WHOLE task (the temp file is removed on ANY exit — happy OR
   panic/early-return; the `Arc<Db>` is released FIRST so the SQLite
   connection closes before the file is removed — safe on Windows),
3. Records the child session in the throwaway `Db` (the `native_messages`
   FK — the child is ephemeral, never archived, ADR 0016),
4. Builds the child `AgentLoop` with FRESH channels / tokens (NOT the
   parent's), the `CapturingSink`, the manager's **SHARED `pending_*` maps**
   (the UI's `respond_*` searches the shared maps — fresh maps would park the
   child on a gate nobody can answer, which the liveness rule below then reads
   as a perfectly **Active** child), and `trust_db` threaded from
   `NativeDeps` (below),
5. Seeds the system message, spawns the loop, emits
   `subagent-session-started` on the parent's REAL sink (NOT the
   `CapturingSink` — the resolved `model` / `thinkingLevel` /
   `enabledTools` make the child's config observable), and sends the task
   prompt (a `SendError` preflight failure = the child died before the turn
   started → `Failed`),
6. Races: the child's **settle** vs the **Dead bound** (`dead_bound` /
   `DEFAULT_SUBAGENT_DEAD_BOUND`, `src-tauri/src/agent/worker/manager.rs`) vs
   the **`SubagentCancel`** handle vs the child Worker process **exiting**
   unexpectedly (→ `Failed { reason: Crashed }`; a `settle_tx` drop → `Failed`,
   NOT `Completed`). The bound is a **self-rearming silence clock**, not a
   ceiling on the delegation: it is rearmed on EVERY frame the pump sees for
   the child and is NOT armed at all while a `tool_call_id` is outstanding, so
   an **Active Subagent** is never reaped and only a **Dead** one — silent with
   nothing in flight — is torn down and reported `Failed { reason:
   Unresponsive }` with its partial output + real usage (ADR 0055 — see
   **Liveness: Active vs Dead** below),
7. Tears down **unconditionally on EVERY exit** (session + turn tokens,
   `abort()` — the belt-and-braces for a child hung inside a provider HTTP
   read that ignores cancellation, the `events_rx` drain, the throwaway
   `Db` / temp file via the `TempFileGuard`),
8. Resolves the `SubagentOutcome` (`Completed { output, metrics }` /
   `Failed { reason, error, output, metrics }` — a cancel is
   `Failed { reason: Cancelled }`, and EVERY `Failed` carries the
   `SubagentCapture`'s partial output + real usage) and emits
   `subagent-closed` on the parent's real sink.

**Steps 1–8 are the PRE-ADR 0025 driver:** the drive now runs **Supervisor-side**
in `WorkerManager` (`dispatch_subagent` → `drive_subagent`) against a Worker
PROCESS — no throwaway `Db`, no `TempFileGuard`, no `dispatch_native_inner`. Only
step 6's race survived the move; **Liveness: Active vs Dead** below documents it.

**Cancel — the `SubagentCancel` / `ExternalClose` pair:** despite the
`ExternalClose` type name (a harness-neutral rename survivor, ADR 0022),
this is the **native** cancel plumbing: `SubagentCancel::new_external_close`
builds one `watch` flag + one first-set-wins `CloseKind` (kind `User` set
before the flag flips); `cancel()` (idempotent) is the caller's path — a
parent turn cancel, a parent session close, or an app exit cancels the
in-flight dispatch, and the driver task's select arm sees the flipped flag
and tears the child down. A pre-aborted signal short-circuits the dispatch
before it starts.

**Metrics are real.** The child self-emits a per-turn `cost_update` (source
`"main"`, from the model's `turn_end` usage — per-turn deltas, `reasoning`
excluded as an `output` subset); the driver accumulates the subagent's
`cost_update` payloads (sum, not last-payload) into `SubagentMetrics` (token
/ cost fields are real when the session pushed usage, 0 otherwise;
`durationMs` is the desktop's wall clock). The wire metrics shape is
unchanged: `{ output, inputTokens, outputTokens, cost, durationMs }` (the
cache fields flow in the payload but are not in the wire shape — YAGNI). The
`subagent` tool's result to the main agent is the `Completed` output (or
`subagent failed: {error}` / `cancelled`). A failed child TURN (an
exhausted-retry model call) settles "successfully" via a bare
`agent_settled` and reports `Completed { output: "" }` — a documented
follow-up, not a bug to fix here.

## Liveness: Active vs Dead

A **Subagent session** is **Active** — NO timeout of any kind — while it produces
frames OR holds an outstanding `tool_call_id`, and **Dead** only after
`DEFAULT_SUBAGENT_DEAD_BOUND` of silence with NOTHING in flight: only a Dead
child is reaped, as `Failed { reason: Unresponsive }` with its partial output +
REAL usage (ADR 0055, whose rationale stays there).

Four legitimately-silent states, each covered by a frame the pump already sees:

| Silent because the child is… | What keeps it **Active** |
| --- | --- |
| inside a tool (`bash` / `edit` / an MCP call) | its `tool_execution_start` has no matching `tool_execution_end` — the id is outstanding |
| parked on an `ask` | the `InteractiveRequest`'s id IS that tool-call id, open for the whole human wait |
| parked on a **Permission prompt** or a sudo `:confirm` / `:password` prompt | `gate_tool` blocks INSIDE the announced call; a prompt's `requestId` is recorded VERBATIM (`p1`, or the derived `t2:confirm`), which is the same announced call it blocks inside |
| awaiting a nested **Subagent** | `tool_execution_start { tool_name: "subagent" }` would stay open across the whole nested run, whose frames the pump already relays into the parent's stream — DEFENSIVE today: the recursion guard (`subagent_enabled: false` on a child's `StartEnv`, pinned by `a_child_excludes_subagent_and_list_agents_tools`) means a child cannot dispatch one, so this row documents the invariant a future un-guard would need, not a reachable state |

A gate is ALWAYS an outstanding id: `tool_execution_start` fires at ANNOUNCE time
while the Provider still streams the `toolCall` (`loop.rs`), and `gate_tool`
blocks later inside that SAME call. The wiring: the pump's `feed_capture` bumps
`SubagentLiveness::seq` on every frame + maintains `in_flight` / `open_gates`
under the one `drives` lock → the drive's race re-arms on `liveness_rx.changed()`
→ the sleep arm is guarded off (`if !in_flight`) while `in_flight` is non-empty —
there, the bound is not longer, it does not run.

**Accepted non-goal:** a child deadlocked INSIDE a tool holds an outstanding id,
so it is Active forever and never reaped — deliberately: reaping it re-arms a
ceiling over an Active child, the removed defect. `bash` bounds itself (300 s),
so the exposure is a hung MCP tool call, and that bound belongs in the tool layer.

**Operators:** `subagentDeadBoundSecs` (`settings.json`, default **1800**) is the
Dead bound; no value cuts a working child. A torn-down child closes its OWN gate
cards (`finish_subagent` drains `open_gates` into child-id-keyed
`interactive-request-close` frames; `App.tsx`'s listener clears both the
`useInteractive` and `usePermissions` stores). The drained ids are the gate's
`requestId` VERBATIM — including the sudo flow's derived `:confirm` / `:password`
forms, which is what the Client filed the card under — and a record is retired
only by the ANSWER (`WorkerManager::note_gate_answered`, relayed from
`respond_permission` / `respond_interactive_request`), never by the gate's
`tool_execution_end`: a cancelled gate closes its tool call too, while its card
stays on screen. Failure cards carry a structured `reason`
(`unresponsive` / `crashed` / `cancelled` / `other`) instead of string-matched `error`.

## Trust inheritance

`NativeDeps.trust_db` is the TRUST lookup source threaded onto the child
(ADR 0010): a subagent in a **Trusted Space** inherits the parent's trust —
the in-process permission gate auto-approves the gated tools
(`bash`/`edit`/`write`), so the child does not prompt; `sudo_exec` (its own
confirm + password modal) and `ask` (a `select` request, not a confirm) are
unaffected. `None` = fail-closed (the gate prompts on every `bash` /
`edit` / `write` in the child). It is SEPARATE from the driver's `db`
(transcript persistence — always `None` for subagents): threading the full
db here would make subagent updates attempt transcript inserts into a
`sessions` row that does not exist (a FK failure) — the lookup and the
persistence are deliberately decoupled.

## Interactive tools (ask, sudo_exec)

The subagent's interactive tools run in the desktop's **in-process
interactive channel** (`agent/interactive.rs`): their prompts
(`interactive-request` / permission / sudo `:confirm` / `:password`
sub-prompts) go **directly to the Client** — without relaying through the
main agent. `SubagentSessionManager::respond_interactive_request` /
`respond_permission` resolve them from the driver's shared `pending_bridge`
/ `pending_sudo` / `pending_permissions` maps (keyed
`"{session_id}/{request_id}"`, `:confirm` / `:password` suffixes for the
sudo sub-prompts); awaiting the answer carries **no deadline** — it ends
when the PERSON answers or the session close / teardown cancels the waiter
(a timer that expires on a human wait is not a timeout, it is a lost
answer: the caps this used to carry — 330 s interactive, 300 s `ask` /
permission — resolved as a cancel, which the UI showed as
"User cancelled the question." and the permission gate mapped to a silent
DENY). Only the `sudo` RUN that follows is time-bounded, by the caller's
`timeoutMs`. The drive-side bound now AGREES with that: a child parked on a gate
holds its tool call open, so it is an **Active Subagent** and the **Dead bound**
never runs on a human wait (ADR 0055).

## Presentation

Subagents live under the "Delegating" tool card in the main chat view
(`SubagentDelegatingCard` — one row per subagent: status icon + agent name +
task + a live one-line activity preview; open by default); clicking a row
opens a dedicated right-side transcript SHEET (`SubagentDetailHost`). The
sidebar Subagents panel is removed (`SidePane` is a todo-board surface: its
auto open is driven by todo boards only — a Subagent session opens it through
its own **board**, on the same 0 → >0 edge as the parent's list, while its
merely STARTING with no board yet opens nothing, which a test pins — and the
pane mounts NO gate host of any kind). That surface opens itself and never
closes itself (ADR 0042): a board completing leaves the frame open, the Todos
section gone with it (data-gated) and the session title still there — only the
user's own toggle collapses the pane. Grouping is session-level: every
`SubagentDelegatingCard` in a session lists all of that session's subagent
rows (the `subagent-session-started` payload carries no `toolCallId`), while
the activity preview resolves only from each card's own `rawOutput.details`.

### Side pane todo boards

Every **Session** owns exactly ONE **Todo board** — its own
`manage_todo_list` list — held in `useInteractive.todos` under THAT session's
id, never under the frame's `source` label (which is the constant `"native"`
for a main session and a child alike —
`docs/decisions/0041-todo-boards-are-keyed-by-session-not-by-source.md`). A
child's board is therefore found by joining `useSubagents` on
`parentSessionId` (`todoBoardsOf` / `useTodoBoards`), and the pane renders the
active Session's board FIRST, then one labelled block per child:

- **The parent yields to its children** (`CONTEXT.md`: **Current todo** /
  **Reduced board**). With no child board the parent shows its FULL list; once
  any child board shows it shows its ONE Current todo (its `in_progress` item,
  else its first OPEN one — and NO row at all when it has nothing open). One
  child block gets that child's full list; two or more reduce EACH to one row.
  Density is a render choice — the store always holds the full list, so every
  header still counts its whole board (`2/3`).
- **Which children get a block**: only `status === "running"` entries whose
  list has an OPEN item (an all-completed list holds no block open, exactly as
  a fully-completed parent list hides its own), ordered by `startedAt` — child
  ARRIVAL — and labelled with the agent name, disambiguated `researcher 2`,
  `researcher 3`… in arrival order ONLY when a visible sibling shares the name.
- **The block's header IS the accessible control** (`aria-label`
  `Open <label> transcript`, focusable, `Enter`/`Space`), while the WHOLE block
  is the MOUSE target: a click anywhere on it — a row body included — opens that
  child's transcript sheet (`useSubagentSelection.select` →
  `SubagentDetailHost`), with ONE exception: a click that ENDS a text selection
  inside the block is the release of a select-drag, not an activation, so it
  opens nothing — on the block surface OR on the header line, whose own label and
  count are selectable text (both handlers read one `endsSelection` predicate).
  The exception is exactly as wide as that predicate and no wider: it fires only
  on a LIVE range, so a DOUBLE-CLICK that selects a WORD still opens the sheet —
  by the time that first click lands the mousedown has collapsed the selection to
  a caret, which is not a range, and the click is indistinguishable from pointing
  AT the board (which is what a double-click on a board is)
  The rows sit as SIBLINGS of the control rather than
  inside it, so assistive tech still reads the child's checklist instead of one
  opaque button name — and each checklist is a NAMED list region (`Todos` for
  the parent's, `<label> checklist` for a child's), because the pane can present
  three anonymous `list`s at once and "list" alone never says which board they
  belong to.
- **A child's board is freed at `subagent-closed`** (`App.tsx`), and narrowly:
  `applyTodoClear(childSessionId)` — todos only, never its gates or permission
  prompts (those are closed by `finish_subagent`'s own child-id-keyed
  `interactive-request-close` frames, ADR 0055, never by the todo handler). No
  `session-closed`
  ever names a child id and `src-tauri/src/` emits no `todos_clear` frame, so
  that handler is the ONLY thing that reclaims a child's slice.
- **Collapsed, the rail draws ONE MARK PER BOARD** (`TodoRail`, the **Todo
  rail** in `CONTEXT.md`): the parent's mark first (only when it HAS a list),
  then one per running child THAT HAS A BOARD, in board order — the rail
  iterates `boards`, not the subagent entries, so a running child whose list
  has no open item draws no mark (rule 4 of `todoBoardsOf`). A mark's state is
  its whole board's — `active` if ANY item is `in_progress`, `done` if every
  item is `completed`, else `waiting`. It replaced one mark per item, which a
  long list turned into an ungroupable strip of dots.
- **The frame opens itself on any open board and never collapses itself**
  (`docs/decisions/0042-the-side-pane-opens-itself-but-never-closes-itself.md`):
  the trigger is the 0 → >0 edge of `useBoardOpenCount` — the parent's open
  items PLUS every running child's, the SAME derivation the section's own gate
  reads, so the frame can never open on a section that renders nothing — and a
  CHILD-ONLY board opens it with the parent having written no list at all. A
  board finishing leaves the frame open with the section gone; the pane's own
  toggle is the only thing that collapses it. A SESSION SWITCH is NOT an edge:
  the edge ref is re-baselined onto the session the user landed on, because
  "has an open board" is per-Session while the collapsed flag is app-global
  (pinned in `src/components/SidePane.test.tsx`).

The click-through is deliberately asymmetric: the sheet is a TRANSCRIPT, and
`SubagentTranscript` (inside `SubagentDetailHost`) renders the child's
`manage_todo_list` calls as ordinary collapsed tool cards — the pane's block is
the only place a child's list reads as a board.

**The render-site partition (load-bearing):** a Subagent session's four
gates (`ask`, `confirm`, `password`, Permission prompt) are answerable in
exactly ONE place per gate, split on ONE question — **is this gate's parent
the ACTIVE session** — with the derivation in one place (`childGatesOf` /
`useChildGates`, `src/hooks/useChildGates.ts`) and the contract stated on
`SubagentModals`:

- `ask` / Permission prompt of a child whose parent IS active → **inline** at
  the bottom of that parent's transcript (`MessageList`, fed by
  `useChildGates(activeSessionId)` in `ChatStream`), below the parent's own
  cards and labelled `↳ <agentName>` — that is the conversation the user is
  already reading, so answering there is the point.
- `ask` / Permission prompt of a child whose parent is NOT active → the
  **`SubagentModals` overlay** (a right-anchored `fixed` panel). `ChatStream`
  renders only `activeSessionId`, so there is no transcript for it to render
  into.
- `confirm` / `password` of EVERY child, active parent or not → the overlay,
  always. `SudoConfirmModal` / `SudoPasswordModal` are Radix `Dialog`s and
  modal by nature; inlining a `Dialog` into a scrolling transcript is not on
  the menu, so these two kinds never move.

Exactly one site draws any one gate: never twice (two live copies would mean
divergent typed-but-unsubmitted `ask` drafts and an Esc that closes only one),
and never nowhere **while the workspace view is mounted**. The one accepted
exception is the Settings view with the gate's parent the active Session — the
hole the accepted-geometry list below names, pinned by `App.test.tsx`'s
`KNOWN HOLE (accepted, documented)` test.

**The never-nowhere invariant (the guarantee is unchanged; nothing rescues a
breach).** A gate MUST be rendered by a mounted component — while the
workspace view is mounted, with the one accepted Settings-view exception the
list below records. The interactive
wait carries no deadline (above), and neither does the drive: a child parked on
an unrendered gate holds its `tool_call_id` open, so it is an **Active
Subagent** and NO clock resolves it — the child is stranded **indefinitely**,
still running and still costing tokens, until something else ends the
delegation. The escape is not a timer: leave Settings (the gate becomes
renderable and answerable again) or Stop the parent (a `SubagentCancel` →
`Failed { reason: Cancelled }`, carrying the partial output). This is the
intended trade for ADR 0055 — the question is no longer silently killed after 30
minutes and reported as a dead child, it waits as long as the user takes — and
`App.test.tsx`'s `KNOWN HOLE (accepted, documented)` pin still records the hole
rather than closing it. The old design held this
by mounting EVERY child's `SubagentTranscript` and keeping the unselected
ones hidden; that host is deleted, because the guarantee now comes from the
partition instead: the overlay is mounted at the `App` root as a SIBLING of
the whole `view === "settings" ? … : …` ternary — so it is up whenever the
workspace is not — and covers every parent that is not the active Session (the
active parent's own cards are the transcript's half), so
a child of a Session you navigated away from is still on screen — and
`SubagentTranscript` renders no gate at all, so a gate appearing inside the
sheet would be a THIRD site (`App.test.tsx`: `opening the gate-holding child's
OWN sheet still renders the card EXACTLY ONCE (the sheet is not a third site)`).
Closing the sheet (X / Esc) still only clears the selection; the entry
stays in `useSubagents`.

**Escape.** The sheet's `onKeyDown` Esc handler is a React handler on the
sheet (NOT a window-level handler), so it stops the native event before
`ChatStream`'s window-level Escape-cancel fires: closing a child's transcript
never cancels the PARENT's turn (accepted limitation: it fires only while
focus is inside the sheet). The two gate wrappers stop `Escape` the same way,
non-dismissibly, because `ChatStream`'s listener would otherwise kill the
parent's turn. What used to be pinned in the sheet — an Esc consumed by a
nested `AskQuestionCard` staying with that card — cannot happen there any
more, since the sheet renders no cards; that guarantee now lives in
`src/components/ChatStream.test.tsx` (`an Escape INSIDE the inline child card
answers the CHILD and does NOT cancel the parent`), with the overlay's half
pinned in `src/components/SubagentModals.test.tsx`.

**Accepted geometry and stacking** (deliberate, and each pinned where it is
named):

- The overlay panel is `z-40` and the sheet is `fixed … z-50` and one width
  wide, so a
  right-anchored panel sits entirely UNDER an open child sheet — including the
  card the attention alert just pointed at. The panel therefore shifts to the
  sheet's left edge, but only from a viewport width where that leaves a usable
  card: the dodge is the breakpoint variant of 760 applied to a 480 offset and a
  viewport-minus-480 cap, with the corner geometry as the unconditional base
  (760 = the sheet's 480 +
  the 280px floor a card needs — `src/lib/subagentSheetLayout.ts`). Below it the
  dodge is the WORSE option: `min(480, 100vw − 480)` is a 120px strip at 600px
  and, at ≤ 480px, a zero-width box placed off-viewport — a gate that is mounted
  and UNREACHABLE, which since ADR 0055 strands the child FOREVER (a
  gate-parked child is an **Active Subagent**, so no clock ends the delegation):
  worse
  than buried-behind-the-sheet, which is at least recoverable (close the sheet,
  the card is
  there). Those classes live as literals in `src/lib/subagentSheetLayout.ts`
  alone — the sheet's width class and the dodge pair — and both surfaces
  interpolate them, so the two cannot be widened independently; each literal is
  type-annotated against the number it names (widening `SUBAGENT_SHEET_WIDTH`
  without it is a `tsc` error), `src/lib/subagentSheetLayout.test.ts` pins that
  no other file spells a geometry class, and
  `src/components/SubagentModals.test.tsx` re-pins the rendered pair along with
  the variant and the fallback, since jsdom runs no layout. The panel is also
  `pointer-events-none` with `pointer-events-auto` per card, so it is
  click-transparent outside its cards and its rect steals no clicks from the
  panes underneath it — at the cost of the frame's own scrollbar not being
  draggable and a text drag not starting in a gap, both named and accepted on the
  component. Opening Settings UNMOUNTS the sheet (`SubagentDetailHost` is inside
  the view ternary, this host is not) but keeps the SELECTION, and tells the
  overlay which view is mounted (`sheetMounted`): the panel stops dodging a sheet
  that is not painted, and Back from Settings re-opens the transcript the user
  had open. `App.test.tsx` pins both halves; clearing the selection instead was
  the earlier fix and threw the user's sheet away to repair a geometry the
  overlay could simply be told about.
- While a sudo `Dialog` is open, Radix's `hideOthers` +
  `disableOutsidePointerEvents` make everything outside it inert — so an
  `ask` / Permission prompt is NOT answerable then, in the overlay panel AND
  inline in the parent's transcript (pre-existing for the parent's own cards).
  The gate stays mounted and pending and is answerable again the moment the
  modal settles; `App.test.tsx` pins the overlay half.
- Opening the **Settings** view unmounts the workspace (`ChatStream`
  included), so an ACTIVE parent's inline `ask` / Permission prompt has no
  transcript to render into, and the overlay stands down for it rather than
  hosting the active session's own cards. Accepted: it is the pre-existing
  main-session hole, reachable by the same two clicks and escaped the same
  way — leave Settings, which re-mounts the transcript. Nothing closes the gate
  in the meantime: since ADR 0055 there is NO bound on an unanswered one at all
  (a gate-parked child is an **Active Subagent**, so the **Dead bound** is not
  armed), and the delegation simply waits. The card finally disappears only at
  teardown, where `finish_subagent` drains `open_gates` into a child-id-keyed
  `interactive-request-close`. The overlay's
  own half — every NON-active parent's gates — is pinned answerable with
  Settings open, which is why it lives outside that ternary.
- Navigating away from the active parent moves its child's `ask` to a
  different component instance, so a typed-but-unsubmitted draft is lost
  (`AskQuestionCard` keeps drafts in component state). The price of one site
  per gate.

## Follow-ups

- **`source` is one value on today's transport: two `AskQuestionCard` branches
  are unreachable.** Every
  `interactive-request` the desktop builds carries `"native"`:
  `ask_flow` (`src-tauri/src/agent/harness/ask.rs`) emits it
  verbatim, and the `sudo_run_flow` core
  (`src-tauri/src/agent/interactive/mod.rs`) is handed it as its `source`
  argument by the `AgentLoop`'s tool dispatch
  (`src-tauri/src/agent/harness/loop.rs`) — which passes the same literal to
  `todo_apply` — for a MAIN session and a Subagent session alike. So the card's
  `source === "main"` anchoring path never fires: nothing anchors, a main `ask`
  included, since `ask_flow` sends `toolCallId: null` too — and that is why the
  two lifted child sites pass `autoFocus={false}` (an unanchored card takes
  focus on mount). Its `subagent:` label never renders either. `"main"` and
  `"sudo"` exist only in Rust fixtures, `bin/fake_worker.rs` and
  the frontend's own test seeds.
  **The todo-board half of this follow-up is RESOLVED by ADR 0041** (boards are
  keyed by SESSION id and `source` is not read at all). It used to be the worse
  half because it was not dead code: `todo_apply` pushed `todos_update` with
  that same `"native"`, so `useInteractive.applyTodoUpdate` took its `else` arm
  and filed a MAIN session's board in `todos[sessionId].subagents["native"]`
  while `column.main` stayed `[]`; `useMainTodoItems`'s
  `column?.main ?? rawTodos` fallback could not fire on an EMPTY array (only
  `undefined` reaches the `??`), so the `rawInput` seed never rescued it,
  `useMainOpenTodoCount` read 0, and the `SidePane` — whose auto open/close was
  that count THEN (the count is `useBoardOpenCount` today, and ADR 0042 made
  the auto behaviour OPEN-only) — never opened for a session that had an open
  todo list.
  `applyTodoClear` mirrored the same branch (it deleted
  `subagents["native"]`, leaving `main`), though nothing in `src-tauri/src`
  emits a `todos_clear` frame at all today. Both writes now land on
  `todos[sessionId]`; `applyTodoClear` takes ONE argument (a clear names a
  Session, never a label) and drops that session's whole board; and the
  `subagent-closed` handler frees a child's slice — todos only, so that handler
  still never touches a gate card; the card itself is now closed by
  `finish_subagent`'s child-id-keyed `interactive-request-close` (ADR 0055)
  rather than lingering until the entry is evicted, as ADR 0040 used to record.
  Rendering followed, so the half this entry left as
  remaining work is closed: a child's board lands in the CHILD's own slice
  while `TodoBoardPanel` draws only the session it is handed, and the pane's
  child blocks come from `useTodoBoards` (see **Side pane todo boards**
  above).
  The label branch and the fixtures that drive it are deliberately KEPT (they
  exercise a live code path a future emitter would
  use), so the fix here is a decision, not a deletion: either make the emitter
  name the child (and give a main `ask` a real `toolCallId` so it can anchor),
  or delete the two branches and the seeds with them.
- **A child's `interactive-request-close` frames are mis-keyed.** **RESOLVED by
  ADR 0055.** The defect was real: the pump relays a Subagent's frames under the
  PARENT's delivery id (`delivery_id` in
  `src-tauri/src/agent/worker/manager.rs`, routed into `route_event`, which is
  what `track_modal` records), so any close frame emitted that way carried
  `sessionId = parent` and reached `App`'s `interactive-request-close`
  listener as `removeRequest(parent, <the child's request id>)` — a no-op on the
  child's slice, leaving the card mounted with nothing behind it. ADR 0040
  recorded it as a known upstream defect with the 30-minute bound as the
  backstop; ADR 0055 removed the backstop, so the emitter had to be fixed.
  `finish_subagent` now drains the drive's `open_gates` and emits
  `interactive-request-close` keyed to the CHILD id for every gate still
  unanswered, and `App.tsx`'s one listener clears BOTH stores
  (`useInteractive.removeRequest` + `usePermissions.removePrompt` — the
  permission store previously had NO listener for this event at all, so a
  Permission card was unclosable by every emitter, including
  `cleanup_pending_modals`). `track_modal` / `cleanup_pending_modals` stay out of
  it: a child's `Exited` never reaches them. `SudoPromptCleanup`
  (`src-tauri/src/agent/interactive/sudo_exec.rs`) still keys its own closes for
  a DROPPED sudo flow correctly.
- **A tool deadlocked INSIDE a tool call is Active forever — a hung MCP tool
  call needs its own bound in the tool layer (ADR 0055 non-goal).** Such a child
  holds an outstanding `tool_call_id`, so the **Dead bound** is never armed and
  no Supervisor-side value can end it; `bash` already bounds itself (300 s) and
  the MCP call does not. The fix belongs where the hang is — re-arming any
  ceiling in the drive would recreate the defect ADR 0055 removed. Stop on the
  parent (`SubagentCancel` → `cancel_drive` → reap) is the escape hatch today.
- 2026-09-15 hang (two concurrent sessions on one tokio runtime):
  **no longer reproduces** on current versions (resolved 2026-09-22 — root
  cause never confirmed, likely version/environment-specific); the one-live
  cap is lifted (subagents run on the main runtime alongside the parent). If
  it reappears, root-cause before re-tightening.
