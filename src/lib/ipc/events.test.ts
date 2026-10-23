import { describe, expect, it } from "vitest";
import {
  INTERACTIVE_EVENTS,
  IPC_EVENTS,
  type InteractiveEventName,
  type IpcEventName,
} from "./events";

/**
 * `ipc/events.ts` is the ONE owner of every IPC event-name string.
 *
 * What this file pins, and what it deliberately does NOT pin:
 *
 * 1. **The VALUES are the wire contract.** Every constant must equal the exact
 *    string the Rust side emits / the browser expects. A rename that keeps the
 *    key but changes the value is a wire break, and it must fail here. Nothing
 *    else can see that drift: the component tests mock the `listen*` wrappers
 *    wholesale (so they cannot see which event name a wrapper asked for), and
 *    a drift passes every test on both sides and fails only at runtime, in the
 *    desktop app — the same reasoning `lib/tauri.test.ts:4-11` and
 *    `lib/update.test.ts:3-11` give for pinning their own strings.
 *
 * 2. **The SET is closed on the frontend side.** `Object.values` compared as a
 *    sorted set, so adding a constant nobody consumes — or deleting one still
 *    listened to — is a failure, not a silent pass.
 *
 * 3. **What is NOT pinned: parity with the Rust source text.** There is no
 *    `readFileSync("src-tauri/…")` grep for `emit(` here, and there must never
 *    be one. It would be unsound three ways: four of the five
 *    `INTERACTIVE_EVENTS` have NO Rust emitter at all (`todos_clear` is a
 *    consumer-only match in `persist.rs`, and ADR 0046 records `cost_update` as
 *    having no native emitter, so the test would fail on correct code on day
 *    one); the `COST_UPDATE` / `archimedes:`-prefix-strip "mapping rule" that
 *    two frontend comments describe appears NOWHERE in `src-tauri`; and event
 *    names flow DYNAMICALLY through the sink
 *    (`session/router.rs`'s `sink.emit(&event, payload)` forwards arbitrary
 *    frame names), so a literal grep is incomplete by construction. This is
 *    exactly the source-text pin `src/lib/skills.test.ts:16-24` records the
 *    repo already RETIRING — a landmine with no detection value. If real parity
 *    is ever wanted, the fix is Rust as the single source of truth that both
 *    sides derive from, not a grep.
 */

/** The 12 Tauri event names, in the order the wrappers appear in `src/lib/`. */
const TAURI_EVENT_NAMES = [
  "session-update",
  "session-closed",
  "session-stalled",
  "session-titled",
  "permission-request",
  "interactive-request",
  "interactive-request-close",
  "interactive-event",
  "subagent-session-started",
  "subagent-closed",
  "window-state-changed",
  "update://progress",
] as const;

describe("IPC_EVENTS — the Tauri event names (wire values, exact)", () => {
  it.each([
    ["sessionUpdate", "session-update"],
    ["sessionClosed", "session-closed"],
    ["sessionStalled", "session-stalled"],
    ["sessionTitled", "session-titled"],
    ["permissionRequest", "permission-request"],
    ["interactiveRequest", "interactive-request"],
    ["interactiveRequestClose", "interactive-request-close"],
    ["interactiveEvent", "interactive-event"],
    ["subagentSessionStarted", "subagent-session-started"],
    ["subagentClosed", "subagent-closed"],
    ["windowStateChanged", "window-state-changed"],
  ] as const)(
    "%s is the wire string %s",
    (key, wire) => {
      expect(IPC_EVENTS[key]).toBe(wire);
    },
  );

  it("the 12th wrapper, in lib/update.ts, is `update://progress`", () => {
    // NOT kebab-case like the other eleven — the updater plugin's own scheme,
    // so it is the one name a "consistency" rename would break.
    expect(IPC_EVENTS.updateProgress).toBe("update://progress");
  });

  it("holds every Tauri event name and nothing else", () => {
    expect(Object.values(IPC_EVENTS).sort()).toEqual(
      [...TAURI_EVENT_NAMES, IPC_EVENTS.insertSkill].sort(),
    );
  });
});

describe("IPC_EVENTS.insertSkill — a window CustomEvent, not a Tauri event", () => {
  it("is the exact event type SkillsDialog dispatches and ChatStream listens for", () => {
    // Duplicated byte-identically across two components (and 8 test sites)
    // before this module existed; a one-sided rename means the button silently
    // stops inserting, with no error anywhere.
    expect(IPC_EVENTS.insertSkill).toBe("archimedes:insert-skill");
  });

  it("is reachable through the same const (one owner covers both kinds)", () => {
    expect(TAURI_EVENT_NAMES as readonly string[]).not.toContain(
      IPC_EVENTS.insertSkill,
    );
  });
});

describe("INTERACTIVE_EVENTS — the `interactive-event` payload discriminants", () => {
  it.each([
    ["todosUpdate", "todos_update"],
    ["todosClear", "todos_clear"],
    ["state", "state"],
    ["costUpdate", "cost_update"],
    ["session", "session"],
  ] as const)("%s is the wire string %s", (key, wire) => {
    expect(INTERACTIVE_EVENTS[key]).toBe(wire);
  });

  it("uses snake_case, and `costUpdate` is NOT the shorter `cost`", () => {
    // The trap this whole group exists for: the bus's `COST_UPDATE` maps to
    // `cost_update` on the wire. `tauri.ts`'s payload comment apologises for
    // exactly this, which is the class of bug a shared union removes.
    expect(INTERACTIVE_EVENTS.costUpdate).toBe("cost_update");
    expect(INTERACTIVE_EVENTS.costUpdate).not.toBe("cost");
    expect(Object.values(INTERACTIVE_EVENTS)).toEqual([
      "todos_update",
      "todos_clear",
      "state",
      "cost_update",
      "session",
    ]);
  });
});

describe("the exported types describe the wire names", () => {
  it("every value is assignable to its union (the union is not narrower)", () => {
    const names: IpcEventName[] = Object.values(IPC_EVENTS);
    const interactive: InteractiveEventName[] = Object.values(
      INTERACTIVE_EVENTS,
    );
    expect(names).toHaveLength(13);
    expect(interactive).toHaveLength(5);
  });
});
