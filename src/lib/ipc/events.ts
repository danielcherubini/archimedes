/**
 * The ONE owner of every IPC event-name string, and of the `interactive-event`
 * payload's `event` discriminants.
 *
 * Before this module, each of the twelve `listen*` wrappers carried its own
 * bare string (`lib/tauri.ts` held eleven, `lib/update.ts` the twelfth), and
 * the five `interactive-event` names were string literals inside `App.tsx`'s
 * handler with a comment apologising that the wire name is `cost_update` and
 * not `cost`. That is the shape in which a rename goes half-done: the invoke
 * boundary was already respected (zero `invoke` call sites outside
 * `lib/tauri.ts`) — the EVENT side had no owner.
 *
 * Two rules for anyone adding to this file:
 *
 * 1. **A constant's VALUE is the wire contract.** Never change one to satisfy
 *    a style preference. `events.test.ts` pins every value byte-for-byte for
 *    exactly that reason, and nothing else can see the drift: component tests
 *    mock the wrappers wholesale, so a renamed string passes every test on
 *    both sides and fails only at runtime, in the desktop app.
 *
 * 2. **There is no Rust-parity test here, and there must never be one.**
 *    Grepping `src-tauri/src` for `emit(` and asserting each constant has an
 *    emitter is unsound: several of these names have no Rust emitter at all
 *    (`todos_clear` is a consumer-only match, and ADR 0046 records
 *    `cost_update` as having no native emitter), and names flow DYNAMICALLY
 *    through the sink (`session/router.rs`'s `sink.emit(&event, payload)`
 *    forwards arbitrary frame names), so the grep is incomplete by
 *    construction. It is the same retired mistake `lib/skills.test.ts:16-24`
 *    documents. Real parity would need Rust as the shared source of truth both
 *    sides generate from — a different change, not a grep.
 */

/**
 * Every event name the renderer subscribes to (or dispatches, in
 * [`IPC_EVENTS.insertSkill`]'s case), keyed by the wrapper that consumes it.
 *
 * The eleven from `lib/tauri.ts` in file order, then the twelfth from
 * `lib/update.ts`, then the one non-Tauri name.
 */
export const IPC_EVENTS = {
  sessionUpdate: "session-update",
  sessionClosed: "session-closed",
  sessionStalled: "session-stalled",
  sessionTitled: "session-titled",
  permissionRequest: "permission-request",
  interactiveRequest: "interactive-request",
  interactiveRequestClose: "interactive-request-close",
  interactiveEvent: "interactive-event",
  subagentSessionStarted: "subagent-session-started",
  subagentClosed: "subagent-closed",
  windowStateChanged: "window-state-changed",
  /**
   * The updater plugin's install-progress event (`lib/update.ts`). Deliberately
   * NOT kebab-case like the eleven above — it is the plugin's own
   * scheme-prefixed name, not one of ours.
   */
  updateProgress: "update://progress",
  /**
   * A `window` `CustomEvent`, NOT a Tauri event: `SkillsDialog` dispatches it,
   * `ChatStream`'s composer listens (the two subtrees are otherwise
   * decoupled). It lives here anyway because the point of this module is one
   * owner per name, and this one was duplicated byte-identically across both
   * components — a one-sided rename makes the dialog's insert button stop
   * working with no error anywhere.
   */
  insertSkill: "archimedes:insert-skill",
} as const;

/** The union of every event name above. */
export type IpcEventName = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS];

/**
 * The `interactive-event` payload's `event` discriminants — the WIRE names
 * (snake_case, unlike the hyphenated channel names above).
 *
 * These are built by the worker, and Rust keeps NO closed set for them, so a
 * frame carrying an unlisted name is possible. That is why `App.tsx`'s
 * exhaustive switch has a default branch that LOGS AND RETURNS rather than
 * throwing: an `assertNever` default would convert today's silent frame drop
 * into a runtime exception inside the event listener. Compile-time
 * exhaustiveness comes from `InteractiveEventPayload.event` being typed as
 * this union, not from a throw.
 */
export const INTERACTIVE_EVENTS = {
  todosUpdate: "todos_update",
  todosClear: "todos_clear",
  state: "state",
  /**
   * The bus's `COST_UPDATE` maps to `cost_update` on the wire — NOT `cost`.
   * The name this module exists to stop anyone re-deriving.
   */
  costUpdate: "cost_update",
  session: "session",
} as const;

/** The union of `interactive-event` names a handler must cover. */
export type InteractiveEventName =
  (typeof INTERACTIVE_EVENTS)[keyof typeof INTERACTIVE_EVENTS];
