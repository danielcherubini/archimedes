---
status: accepted
date: 2026-10-13
superseded-by:
---

# Todo boards are attributed by session id, never by the `source` label

`useInteractive` used to hold one `TodoColumn { main, subagents }` per session and route
a `todos_update` push by `payload.source` — `main` to the main list, anything else to
`subagents[source]`. Every frame the desktop emits carries `source: "native"`: the
`AgentLoop`'s tool dispatch hands that one literal to `todo_apply`
(`src-tauri/src/agent/harness/loop.rs`) for a **Main session** and a **Subagent session**
alike, so the branch's `else` arm filed a Main session's own board under
`subagents["native"]` — the sidebar rendered the word `native` above the parent's list,
and because `column.main` was then an EMPTY array rather than `undefined`, the
`rawInput` seed in `useMainTodoItems` could not fire, `useMainOpenTodoCount` read 0, and
the **Side pane** never opened for a session that had an open list. We decided to key
boards by the **Session** id that already rides every frame
(`todos: Record<sessionId, TodoItem[]>`) and to STOP READING `source` at all: one
**Session** runs exactly one **Agent harness**, so it produces exactly one **Todo board**,
and the id is the thing that is actually true on the wire.

## Considered options

- **Fix the emitter instead** (`todo_apply` sends `"main"` / `subagent:<agent>:<id>`).
  Rejected: the router re-emits a **Subagent session**'s `SinkFrame`s VERBATIM, so the
  payload keeps the CHILD id (`src-tauri/src/agent/session/router.rs`) while the board renders
  the ACTIVE parent's slice, so this option STILL needs the frontend to join
  `useSubagents` on `parentSessionId` — and if it instead re-keyed the payload onto the
  parent, it would collide with the child's other slices, whose keys are the child id on
  purpose (`useChildGates`, ADR 0040). A Rust change plus a frontend join, and the string
  coupling that produced this bug survives.
- **Keep `TodoColumn` and fill `subagents[agentName]` in the frontend.** Rejected: it
  preserves a shape whose premise — one session's harness pushes several sources — has
  never been true, and the next reader inherits the same trap.

## Consequences

`source` is still on the wire (`InteractiveRequestData.source`, the Rust fixtures,
`bin/fake_worker.rs`) and is now inert for todos. `AskQuestionCard`'s `source === "main"`
branch stays unreachable for the same reason it always was — that is the separate
follow-up recorded in `docs/features/subagent-sessions.md`, not something this closes. A
future real `source` would have to arrive as a SESSION identity the Client can join
(child id → parent, `agentName`), which is exactly what `useSubagents` already provides;
a prettier string is not enough. `applyTodoClear` no longer consults its payload (a clear
drops the whole board), and a **Subagent session**'s slice is freed by the
`subagent-closed` handler — narrowly, todos only, so ADR 0040's documented "a closed
child keeps its gate card until eviction" is untouched.
