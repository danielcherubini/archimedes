import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, renderHook, waitFor } from "@testing-library/react";
import { useAttentionAlert } from "./useAttentionAlert";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSessions } from "../store/sessions";
import { useSettings } from "../store/settings";
import { useSubagents } from "../store/subagents";
import {
  attentionArm,
  attentionDisarm,
  type AppSettings,
  type SessionInfo,
} from "../lib/tauri";

/**
 * The hook is the ONLY impure shell of the attention-alert feature: the rule
 * itself is specified in `src/lib/attention.test.ts`, so everything asserted
 * here is about the WIRING — which store facts reach the snapshot, and which
 * commands leave the hook. The two invariants the design rests on each get a
 * dedicated case: an armed countdown survives an unrelated store write (no
 * re-arm, no disarm), and idle input crosses no IPC at all. ADR 0038/0039.
 *
 * REAL TIMERS ON PURPOSE: the hook owns no timer (Rust owns the clock, ADR
 * 0039), so there is nothing to advance — and `vi.useFakeTimers()` makes
 * Testing Library's `waitFor` hang, because its polling timer never runs.
 */

/**
 * The commands the hook sent, in the ORDER it sent them. Several rules here are
 * about ORDER rather than counts — a boot `disarm` must precede the first
 * `arm`, or it cancels the countdown it was supposed to protect — and
 * `toHaveBeenCalledTimes` cannot see that, so both mocks log into one array.
 */
const { ipc } = vi.hoisted(() => ({ ipc: [] as ("arm" | "disarm")[] }));

// Mock the two IPC wrappers (the `importActual` pattern, as in
// `../components/SpacesList.test.tsx`): the hook is the only consumer, and the
// wire contract itself is pinned in `src/lib/tauri.test.ts`.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  const logged = (name: "arm" | "disarm") =>
    vi.fn(() => {
      ipc.push(name);
      return Promise.resolve(undefined);
    });
  return {
    ...actual,
    attentionArm: logged("arm"),
    attentionDisarm: logged("disarm"),
  };
});

const arm = vi.mocked(attentionArm);
const disarm = vi.mocked(attentionDisarm);

// ------------------------------------------------------------- fixtures

const settingsFixture = (over: Partial<AppSettings> = {}): AppSettings => ({
  theme: "dark",
  palette: null,
  paneLayout: {},
  defaultTrustNewSpaces: false,
  defaultModel: null,
  defaultThinkingLevel: null,
  enabledTools: [],
  providers: [],
  mcpServers: {},
  font: { sizePx: 14, uiFamily: null, codeFamily: null },
  defaultThinkingLevels: {},
  agentOverrides: {},
  spinnerStyle: null,
  filePolicy: { reads: "allow", writes: "allow", shell: "allow" },
  web: {
    braveApiKey: "",
    tavilyApiKey: "",
    perplexityApiKey: "",
    searxngUrl: "",
    defaultProvider: "auto",
    proxy: "",
  },
  mcpMentionsEnabled: false,
  sessionNamingEnabled: true,
  sessionNamingModel: null,
  sessionNamingReasoning: null,
  attentionAlertsEnabled: true,
  attentionAlertDelaySecs: 15,
  ...over,
});

const row = (sessionId: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId,
  // `/tmp/s1` → the label `s1` (`basenameOfPath`), so every body assertion below
  // reads as the session's own name unless a `title` is set.
  cwd: `/tmp/${sessionId}`,
  capabilities: {},
  archived: false,
  ...over,
});

/** One live, in-turn session, and the user sitting in it. */
const mountRunning = (sessionId = "s1") => {
  useSessions.setState({
    sessions: [row(sessionId)],
    activeSessionId: sessionId,
    inTurn: { [sessionId]: true },
  });
  return renderHook(() => useAttentionAlert());
};

/**
 * Disarms sent AFTER the one command every mount sends. The boot disarm is
 * asserted by name and by ORDER in its own block below, so the other cases here
 * count from after boot — they pin what a STORE WRITE or an INPUT did, and the
 * mount is not part of that answer. It subtracts, it does not hide: the boot
 * command is still in `ipc` for the order tests to see.
 */
const disarmsAfterBoot = () => Math.max(0, ipc.filter((c) => c === "disarm").length - 1);

const addGate = (sessionId: string, requestId: string, source = "main") =>
  useInteractive.getState().addRequest(sessionId, {
    requestId,
    method: "ask",
    params: {},
    source,
  });

/** The user answering an open gate (the store removes it; nothing re-delivers). */
const answer = (sessionId: string, requestId: string) =>
  useInteractive.getState().removeRequest(sessionId, requestId);

/** The user answering an open Permission prompt. */
const answerPrompt = (sessionId: string, requestId: string) =>
  usePermissions.getState().removePrompt(sessionId, requestId);

/**
 * Register a child `SubagentEntry`. Written straight into `entries` rather than
 * through `addSession`, because `addSession` stamps `startedAt` with
 * `Date.now()`: the sibling-rank tests need explicit, ordered arrival stamps
 * (the store spreads the map, so this is the same shape `addSession` produces).
 */
const addEntry = (childSessionId: string, parentSessionId: string, startedAt = 1000) =>
  useSubagents.setState((s) => ({
    entries: {
      ...s.entries,
      [childSessionId]: {
        sessionId: childSessionId,
        parentSessionId,
        agentName: `agent-${childSessionId}`,
        task: "review",
        status: "running" as const,
        startedAt,
      },
    },
  }));

beforeEach(() => {
  // EVERY field the snapshot reads — `useHasPendingRequest.test.ts`'s list
  // omits `inTurn`/`stopReasons`/`stalled`, and leaking turn state between
  // cases here would fabricate (or swallow) a settled pulse.
  useSessions.setState({
    sessions: [],
    historySessions: [],
    archivedSessions: [],
    activeSessionId: null,
    activeSpacePath: null,
    spaces: [],
    closeReasons: {},
    messages: {},
    configOptions: {},
    inTurn: {},
    stopReasons: {},
    stalled: {},
  });
  usePermissions.setState({ prompts: {} });
  useInteractive.setState({
    requests: {},
    todos: {},
    agentState: {},
    cost: {},
    session: {},
  });
  for (const id of Object.keys(useSubagents.getState().entries)) {
    useSubagents.getState().dismiss(id);
  }
  useSettings.setState({ settings: settingsFixture(), loaded: true });
  vi.clearAllMocks();
  ipc.length = 0;
});

afterEach(() => {
  // Unmount between cases: `armed`/`spent` live in a ref, so a hook left
  // mounted would carry its memory into the next case.
  cleanup();
  configure({ reactStrictMode: false });
  document.body.innerHTML = "";
});

describe("useAttentionAlert — the mount disarms the Supervisor", () => {
  /**
   * A page reload runs NO React cleanup (ADR 0039 states this outright), so the
   * unmount disarm further down cannot cover a reload: Ctrl-R leaves an armed
   * countdown ringing in the Supervisor, firing up to `delaySecs` later with
   * text about a Session the new renderer knows nothing about — and it cannot be
   * cancelled from there, because a fresh memory starts `armed: null`, so
   * `attentionActivityStep` yields `none` and the user's own typing sends
   * nothing. Only a mount-time disarm can reach that orphan.
   */
  const gateOpenAtMount = () => {
    useSessions.setState({ sessions: [row("s1")], activeSessionId: "s1" });
    addGate("s1", "g1");
  };

  it("disarms at mount, and does it BEFORE the first arm", async () => {
    // The gate is ALREADY open at mount, so the first pass arms immediately —
    // which is what makes the ORDER the whole fix: a disarm that ran after that
    // arm would cancel the countdown this renderer just booked. The sequence is
    // disarm-then-arm, never arm-then-disarm.
    gateOpenAtMount();
    renderHook(() => useAttentionAlert());
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    // The whole transcript, in order: exactly one boot disarm, then the arm.
    expect(disarm).toHaveBeenCalledTimes(1);
    expect(ipc).toEqual(["disarm", "arm"]);
  });

  it("ends ARMED under a StrictMode double-invoke (the extra disarm is harmless)", async () => {
    // StrictMode mounts, unmounts and re-mounts, so the transcript is
    // disarm, arm, [cleanup]disarm, disarm, arm. Only the FINAL state matters: a
    // countdown must still be live at the end, or the transient disarms would
    // have cancelled the alert for the very question still on screen.
    //
    // What this pins is that the two extra disarms cost IPC and not an alert —
    // and the LAST-command assertion is a second pair of eyes on the effect
    // order, because declaring the boot disarm below the pass effect makes the
    // double-invoked transcript end on a `disarm` (an orphan-proof arm that Rust
    // has been told to forget, with the memory still claiming it is armed).
    gateOpenAtMount();
    // The `wrapper` option does NOT double-invoke effects; RTL's own StrictMode
    // wrapper is what reproduces the dev-mode mount/unmount/mount.
    configure({ reactStrictMode: true });
    renderHook(() => useAttentionAlert());
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(2));
    // Rust's LAST word is an arm, so the slot really is counting at the end.
    expect(ipc[ipc.length - 1]).toBe("arm");
    // Proof of "armed" that is behavioural rather than a count: the activity
    // path sends a disarm ONLY while a countdown is live, so this input is what
    // shows one survived the double-invoke — and no third arm follows it.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true })));
    await waitFor(() => expect(ipc[ipc.length - 1]).toBe("disarm"));
    expect(arm).toHaveBeenCalledTimes(2);
  });
});

describe("useAttentionAlert — arming", () => {
  it("arms once when a turn falls with nothing waiting", async () => {
    mountRunning("s1");
    act(() => useSessions.getState().turnCompleted("s1", "end_turn"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    expect(arm).toHaveBeenCalledWith(15, "Archimedes", "s1 finished — waiting for you");
    expect(disarmsAfterBoot()).toBe(0);
  });

  it("arms once when a gate appears, with the needs-your-answer body", async () => {
    useSessions.setState({ sessions: [row("s1", { title: "Refactor auth" })], activeSessionId: "s1" });
    renderHook(() => useAttentionAlert());
    act(() => addGate("s1", "g1"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    expect(arm).toHaveBeenCalledWith(15, "Archimedes", "Refactor auth needs your answer");
  });

  it("passes the configured delay through to Rust unchanged", async () => {
    useSettings.setState({ settings: settingsFixture({ attentionAlertDelaySecs: 60 }) });
    mountRunning("s1");
    act(() => useSessions.getState().turnCompleted("s1", "end_turn"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    expect(arm).toHaveBeenCalledWith(60, "Archimedes", "s1 finished — waiting for you");
  });

  it("prefers waiting over settled when both land in one pass", async () => {
    mountRunning("s1");
    act(() => {
      addGate("s1", "g1");
      useSessions.getState().turnCompleted("s1", "end_turn");
    });
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    expect(arm).toHaveBeenCalledWith(15, "Archimedes", "s1 needs your answer");
  });

  it("never arms for a stalled session's fall (a crash did not finish)", async () => {
    mountRunning("s1");
    act(() => useSessions.getState().markStalled("s1", 1, null));
    act(() => useSessions.getState().turnCompleted("s1", "end_turn"));
    expect(arm).not.toHaveBeenCalled();
    expect(disarmsAfterBoot()).toBe(0);
  });

  it("never arms for a cancelled stopReason (a user Stop did not finish)", async () => {
    mountRunning("s1");
    act(() => useSessions.getState().turnCompleted("s1", "cancelled"));
    expect(arm).not.toHaveBeenCalled();
    expect(disarmsAfterBoot()).toBe(0);
  });

  it("sends nothing while the settings are still null (fail-safe: off)", async () => {
    useSettings.setState({ settings: null, loaded: false });
    mountRunning("s1");
    act(() => useSessions.getState().turnCompleted("s1", "end_turn"));
    // The off/fail-safe direction governs the PASS path only. The boot disarm is
    // deliberately unconditional — the countdown it cancels may have been armed
    // while the setting was on, and `attention_disarm` is a no-op if not.
    expect(arm).not.toHaveBeenCalled();
    expect(disarmsAfterBoot()).toBe(0);
  });

  it("sends nothing when the setting is off", async () => {
    useSettings.setState({ settings: settingsFixture({ attentionAlertsEnabled: false }) });
    mountRunning("s1");
    act(() => useSessions.getState().turnCompleted("s1", "end_turn"));
    expect(arm).not.toHaveBeenCalled();
    expect(disarmsAfterBoot()).toBe(0);
  });

  it("disarms when the setting is switched off under a live countdown", async () => {
    mountRunning("s1");
    act(() => useSessions.getState().turnCompleted("s1", "end_turn"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    act(() =>
      useSettings.setState({ settings: settingsFixture({ attentionAlertsEnabled: false }) }),
    );
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
  });

  it("arms for a subagent's gate while the user sits in an unrelated session, naming the PARENT", async () => {
    // The parent lives in `historySessions` (the child's gate is the pause, but
    // the child id means nothing to the user — `parentSessionId` is the ONLY
    // parent source, so a parent absent from both lists would label "A session").
    useSessions.setState({
      sessions: [row("other")],
      historySessions: [row("main1", { title: "Investigate flaky test" })],
      activeSessionId: "other",
    });
    renderHook(() => useAttentionAlert());
    act(() => {
      useSubagents.getState().addSession({
        sessionId: "sub1",
        parentSessionId: "main1",
        agentName: "reviewer",
        task: "review",
        status: "running",
      });
      addGate("sub1", "g1");
    });
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    expect(arm).toHaveBeenCalledWith(
      15,
      "Archimedes",
      "Investigate flaky test needs your answer",
    );
  });
});

describe("useAttentionAlert — a child's gate IS its parent's pause (the snapshot re-key)", () => {
  /**
   * The re-key: a child's gate joins `waitingIds[entry.parentSessionId]` (with a
   * COMPOSITE `gateId`) and the parent — not the child — joins
   * `candidateOrder`. Which gate of ONE parent holds the slot is invisible in the
   * alert TEXT (every one of them names the parent), so these cases pin it
   * BEHAVIOURALLY: the slot changes hands only when the closure touches the gate
   * that is actually armed, and R5 re-arms the next-ranked gate on that same
   * pass (`arm` subsumes the owed `disarm`, so a hand-over is ONE command).
   */

  it("treats two children holding the same gateway tool-call id as TWO pauses", async () => {
    // The composite `gateId` (`childSessionId:requestId`), and the reason it is
    // load-bearing: some OpenAI-compatible gateways index tool-call ids per
    // response, so `call_0` RECURS — here, in two children of one parent (the
    // `AttentionTrigger` doc comment, `attention.ts`). Trigger identity is
    // `(kind, sessionId, gateId)`
    // (`sameAttentionTrigger`), and the sessionId half is now the SAME parent,
    // so a bare `requestId` collapses both gates into one trigger: the first is
    // announced, `spent` mutes the survivor forever, and the second child never
    // alerts. This is the test that fails with a bare `requestId`.
    useSessions.setState({
      sessions: [row("other"), row("main1")],
      activeSessionId: "other",
    });
    renderHook(() => useAttentionAlert());
    act(() => {
      addEntry("sub1", "main1", 1000);
      addEntry("sub2", "main1", 1001);
      addGate("sub1", "call_0", "subagent:reviewer");
      addGate("sub2", "call_0", "subagent:reviewer");
    });
    // One command: the highest-ranked pause holds the single slot.
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));

    // The user answers the FIRST child. That pause's evidence is gone, so the
    // countdown is disarmed and the second child's gate — a DIFFERENT trigger,
    // which `spent` has never seen — arms on the same pass.
    act(() => answer("sub1", "call_0"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(2));
    expect(arm).toHaveBeenLastCalledWith(15, "Archimedes", "main1 needs your answer");
  });

  it("orders a parent's own gates fully ahead of its children's, whichever store key was inserted first", async () => {
    // `waitingIds` used to be filled by iterating `Object.entries(requests)` —
    // KEY-INSERTION order — so simply re-mapping that key puts a child's gate
    // BEFORE the parent's own whenever the child's key landed first, silently
    // inverting ADR 0040's within-Session arrival rule. The snapshot therefore
    // fills the parent's array in two passes: every NON-child session's gates
    // (`requests`, then `prompts`) first, then the child gates in
    // `childGatesOf` order. The stores below are seeded in the order a naive
    // single pass would read the child's key first.
    useSessions.setState({ sessions: [row("main1")], activeSessionId: "main1" });
    renderHook(() => useAttentionAlert());
    act(() => {
      addEntry("sub1", "main1", 1000);
      addGate("sub1", "call_0", "subagent:reviewer"); // child's key inserted FIRST
      addGate("main1", "own1"); // the parent's own `ask`
      usePermissions.getState().addPrompt("main1", "own_p", {
        requestId: "own_p",
        toolTitle: "bash",
        options: [],
      }); // …and its own Permission prompt
    });
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));

    // Draining the parent's own gates one at a time must hand the slot DOWN the
    // ladder own ask → own prompt → child gate: three arms, and each hand-over is
    // one command because `arm` subsumes the owed `disarm`.
    act(() => answer("main1", "own1"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(2));
    act(() => answerPrompt("main1", "own_p"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(3));
    expect(disarmsAfterBoot()).toBe(0);

    // The third arm IS the child's gate: closing it leaves nothing, so the count
    // freezes and exactly one disarm goes out.
    act(() => answer("sub1", "call_0"));
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
    expect(arm).toHaveBeenCalledTimes(3);
  });

  it("announces a child of a parent that lives ONLY in historySessions (never unannounceable)", async () => {
    // `attentionCandidates` visits ONLY the ids in `candidateOrder`, which is
    // active + LIVE `sessions` — `historySessions` never enters it. So the parent
    // must be registered there explicitly from the entries; without that, every
    // child of a Session the user navigated away from (this feature's motivating
    // case) would be silently unannouncable.
    useSessions.setState({ historySessions: [row("main1", { title: "Investigate flaky test" })] });
    renderHook(() => useAttentionAlert());
    act(() => {
      addEntry("sub1", "main1");
      addGate("sub1", "g1", "subagent:reviewer");
    });
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    expect(arm).toHaveBeenCalledWith(
      15,
      "Archimedes",
      "Investigate flaky test needs your answer",
    );
    // And the armed trigger really is a live candidate of that parent: closing
    // the gate retires the countdown exactly once.
    act(() => answer("sub1", "g1"));
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it("disarms exactly once when the child's entry disappears, and never re-arms", async () => {
    // PRESERVATION, not a change. With no `SubagentEntry` the snapshot no longer
    // recognises the id as a child, so the gate keys back to `waitingIds[child]`
    // — and the CHILD id is absent from `candidateOrder` both before this change
    // (it was pushed from `subagentEntries`, which just lost the key) and after
    // (only parents of LIVE entries are pushed). So `attentionCandidates` never
    // visits it and R3's `!candidateOrder.includes(id)` arm disarms: one command,
    // then silence. A re-arm naming `"A session"` here means a child id is still
    // sitting in `candidateOrder`.
    //
    // Note the asymmetry with `childGatesOf`, which DROPS the same gate:
    // an inline card needs a parent transcript to sit in, whereas the alert can
    // still name an owner it cannot resolve.
    useSessions.setState({ sessions: [row("main1")], activeSessionId: "main1" });
    renderHook(() => useAttentionAlert());
    act(() => {
      addEntry("sub1", "main1");
      addGate("sub1", "g1", "subagent:reviewer");
    });
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    act(() => useSubagents.getState().dismiss("sub1"));
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
    // The gate is still open in `useInteractive`, so a later pass re-derives it —
    // and must still send nothing.
    act(() => useSessions.getState().titleSession("main1", "Renamed"));
    expect(arm).toHaveBeenCalledTimes(1);
    expect(disarmsAfterBoot()).toBe(1);
  });

  it("ranks a child's gate at its PARENT's position, not last", async () => {
    // Subagent ids used to be appended to `candidateOrder` after every live
    // Session, so a child's gate ranked behind every other Session's question in
    // the whole app. It now rides at its parent's rank — here, `main1` is a live
    // Session listed BEFORE `B`, so the child's gate outranks B's own question.
    useSessions.setState({ sessions: [row("main1"), row("B")] });
    renderHook(() => useAttentionAlert());
    act(() => {
      addEntry("sub1", "main1");
      addGate("sub1", "gS", "subagent:reviewer");
      addGate("B", "gB");
    });
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    expect(arm).toHaveBeenCalledWith(15, "Archimedes", "main1 needs your answer");
    // The ladder underneath still holds: answering the winner hands the slot to
    // B's question (one command — `arm` subsumes the owed `disarm`).
    act(() => answer("sub1", "gS"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(2));
    expect(arm).toHaveBeenLastCalledWith(15, "Archimedes", "B needs your answer");
    expect(disarmsAfterBoot()).toBe(0);
  });

  it("arms for a child gate and its competing unrelated-Session gate independently (no shared id)", async () => {
    // The re-key moves a child's gate into the PARENT's array, so a bare
    // `requestId` could also collide with a DIFFERENT Session's gate that the
    // rule compares against. Two open pauses in two Sessions must stay two
    // triggers, each with its own evidence.
    useSessions.setState({ sessions: [row("main1"), row("B")] });
    renderHook(() => useAttentionAlert());
    act(() => {
      addEntry("sub1", "main1");
      addGate("sub1", "call_0", "subagent:reviewer");
      addGate("B", "call_0");
    });
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    expect(arm).toHaveBeenLastCalledWith(15, "Archimedes", "main1 needs your answer");
    // Answering the child's gate must not count as answering B's identically
    // named one: B's question arms next.
    act(() => answer("sub1", "call_0"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(2));
    expect(arm).toHaveBeenLastCalledWith(15, "Archimedes", "B needs your answer");
  });
});

describe("useAttentionAlert — an armed countdown survives unrelated writes", () => {
  /** Arm on a settled pulse, then return the mounted hook. */
  const armedSettled = async (sessionId = "s1") => {
    const hook = mountRunning(sessionId);
    act(() => useSessions.getState().turnCompleted(sessionId, "end_turn"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    return hook;
  };

  it("does not re-arm or disarm when the naming pass re-titles the session", async () => {
    // THE regression case for the self-disarming bug: `handleSessionTitled`
    // rewrites `sessions` a couple of seconds after the first exchange, and the
    // settled pulse that armed the countdown is long gone by then. The label
    // change must neither restart Rust's clock nor cancel it.
    await armedSettled("s1");
    act(() => useSessions.getState().titleSession("s1", "Fix the parser"));
    expect(arm).toHaveBeenCalledTimes(1);
    expect(disarmsAfterBoot()).toBe(0);
  });

  it("does not re-arm or disarm on unrelated store writes", async () => {
    await armedSettled("s1");
    act(() => {
      useSessions.setState({ messages: { s1: [] } });
      usePermissions.getState().addPrompt("unrelated", "r", { requestId: "r" });
    });
    act(() => useSessions.getState().beginTurn("other"));
    expect(arm).toHaveBeenCalledTimes(1);
    expect(disarmsAfterBoot()).toBe(0);
  });

  it("disarms exactly once when the stall lands after arming", async () => {
    await armedSettled("s1");
    act(() => useSessions.getState().markStalled("s1", 1, null));
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
    act(() => useSessions.getState().markStalled("s1", 2, null));
    expect(disarmsAfterBoot()).toBe(1);
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it("disarms exactly once when the armed session is paused (leaves the live list)", async () => {
    await armedSettled("s1");
    act(() => useSessions.getState().handleSessionClosed("s1", "user"));
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm or re-time a live countdown when the delay setting changes", async () => {
    // The delay travels with the `arm` and is then FORGOTTEN by the renderer
    // (Rust owns the clock, ADR 0039), so moving the setting mid-countdown must
    // leave the running countdown alone: no second `attentionArm` (which would
    // restart Rust's timer at the new delay) and no `attentionDisarm`.
    useSessions.setState({ sessions: [row("s1")], activeSessionId: "s1" });
    renderHook(() => useAttentionAlert());
    act(() => addGate("s1", "g1"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    expect(arm).toHaveBeenCalledWith(15, "Archimedes", "s1 needs your answer");
    // The evidence is untouched — the gate is still open — only the setting moved.
    act(() =>
      useSettings.setState({ settings: settingsFixture({ attentionAlertDelaySecs: 60 }) }),
    );
    expect(arm).toHaveBeenCalledTimes(1);
    expect(disarmsAfterBoot()).toBe(0);
  });
});

describe("useAttentionAlert — activity signals", () => {
  /** Arm on a WAITING gate: the candidate is a state, so it survives to be
   * re-produced on a later snapshot (a settled pulse is one snapshot wide). */
  const armedGate = async () => {
    useSessions.setState({ sessions: [row("s1")], activeSessionId: "s1" });
    const hook = renderHook(() => useAttentionAlert());
    act(() => addGate("s1", "g1"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    return hook;
  };

  it("a keydown disarms exactly once while armed", async () => {
    await armedGate();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
      // A key REPEAT (held key) must not double the command: the pause is
      // already spent, so `attentionActivityStep` yields `none`.
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    });
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
  });

  it("a pointerdown disarms exactly once while armed", async () => {
    await armedGate();
    act(() => window.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
    act(() => window.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(disarmsAfterBoot()).toBe(1);
  });

  it("a wheel disarms exactly once while armed", async () => {
    await armedGate();
    act(() => window.dispatchEvent(new Event("wheel", { bubbles: true })));
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
    act(() => window.dispatchEvent(new Event("wheel", { bubbles: true })));
    expect(disarmsAfterBoot()).toBe(1);
  });

  it("costs no IPC at all when nothing is armed", () => {
    useSessions.setState({ sessions: [row("s1")], activeSessionId: "s1" });
    renderHook(() => useAttentionAlert());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
      window.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      window.dispatchEvent(new Event("wheel", { bubbles: true }));
    });
    // The WHOLE transcript: the one boot disarm, and nothing the input added —
    // ADR 0039's reason for existing is that idle typing crosses no IPC.
    expect(ipc).toEqual(["disarm"]);
  });

  it("spends the pause it disarms: the same candidate never re-arms", async () => {
    await armedGate();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true })));
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
    // The gate is still open, so the SAME candidate is re-derived on the next
    // snapshot — and `spent` is what keeps it from arming a second time.
    act(() => useSessions.getState().titleSession("s1", "Renamed"));
    expect(arm).toHaveBeenCalledTimes(1);
    expect(disarmsAfterBoot()).toBe(1);
  });

  it("arms again for a DIFFERENT candidate after a spend", async () => {
    useSessions.setState({ sessions: [row("s1"), row("other")], activeSessionId: "s1" });
    renderHook(() => useAttentionAlert());
    act(() => addGate("s1", "g1"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true })));
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
    // A new gate elsewhere IS a new pause: `spent` names the OLD gate, and R4
    // forgets it the moment that gate closes, so this candidate arms.
    act(() => {
      useInteractive.getState().removeRequest("s1", "g1");
      addGate("other", "g9");
    });
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(2));
    expect(arm).toHaveBeenLastCalledWith(15, "Archimedes", "other needs your answer");
  });

  it("ignores a pointerdown inside the window controls (the chrome exemption)", async () => {
    // The Minimize button is not attention: "run finishes → click Minimize →
    // walk away" is this feature's main use case (ADR 0038).
    const shell = document.createElement("div");
    shell.setAttribute("data-window-control", "");
    const button = document.createElement("button");
    shell.appendChild(button);
    document.body.appendChild(shell);
    await armedGate();
    act(() => button.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(disarmsAfterBoot()).toBe(0);
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it("ignores blur (the user leaving is the alert's reason to exist)", async () => {
    await armedGate();
    act(() => window.dispatchEvent(new Event("blur")));
    expect(disarmsAfterBoot()).toBe(0);
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it("unmount unregisters the listeners and disarms an armed countdown", async () => {
    const hook = await armedGate();
    act(() => hook.unmount());
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
    // A real unmount must leave nothing ringing in the Supervisor, and the
    // handlers must be gone with the component (a leaked listener would fire a
    // SECOND disarm from a hook that no longer exists). A RELOAD is a different
    // case entirely — it runs no cleanup, which is what the mount disarm above
    // is for.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true })));
    expect(disarmsAfterBoot()).toBe(1);
  });
});

describe("useAttentionAlert — a spent pause must not mute the pause underneath it", () => {
  it("arms a session that finished while an OLD unanswered question sits spent in another", async () => {
    // The user-visible statement of the bug: "A finished, and nobody told me,
    // because an old unanswered question in another session muted it." The
    // question is still open (an `ask` has no timeout), so it is still the
    // highest-ranking candidate — but it is spent, so it must be skipped rather
    // than allowed to veto the pulse underneath it.
    useSessions.setState({
      sessions: [row("A"), row("B")],
      activeSessionId: "A",
      inTurn: { A: true, B: false },
    });
    renderHook(() => useAttentionAlert());
    act(() => addGate("B", "g1"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    expect(arm).toHaveBeenCalledWith(15, "Archimedes", "B needs your answer");

    // The user comes back and types: the countdown is disarmed and that pause is
    // SPENT. The gate itself stays open — that is the steady state.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true })));
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));

    // Now A's run finishes. That pulse is one snapshot wide, so if the spent
    // gate vetoes the snapshot, A's alert is lost permanently.
    act(() => useSessions.getState().turnCompleted("A", "end_turn"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(2));
    expect(arm).toHaveBeenLastCalledWith(15, "Archimedes", "A finished — waiting for you");
  });
});

describe("useAttentionAlert — the announced pauses are a SET, not a slot", () => {
  /**
   * Drive one pass with the hook's monotonic clock moved forward, then restore
   * it. The hook owns no timer (Rust owns the clock), so the only way to reach
   * rule R2 — "retire the countdown whose deadline has passed" — is the clock it
   * reads, which is `performance.now()`. Nothing is faked about the pass itself:
   * the same store write, the same effect, the same rule run, only later.
   */
  const passLater = (ms: number, write: () => void) => {
    const target = performance.now() + ms;
    const spy = vi.spyOn(performance, "now").mockReturnValue(target);
    try {
      act(write);
    } finally {
      spy.mockRestore();
    }
  };

  it("REGRESSION: retiring the second announced pause does not re-arm the first", async () => {
    // The hook-level twin of the rule test of the same name. `spent` was ONE
    // trigger and three paths OVERWROTE it, so the second retirement erased the
    // record of the first and the still-unanswered question underneath it armed
    // again — a third OS notification for a pause already announced (ADR 0038).
    useSessions.setState({
      sessions: [row("A"), row("B")],
      activeSessionId: "A",
      inTurn: { A: false, B: true },
    });
    renderHook(() => useAttentionAlert());

    // 1. A's gate opens → armed (notification #1).
    act(() => addGate("A", "gA"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));

    // 2. The user comes back and types: A's pause is ANNOUNCED, and its gate
    //    stays open — an `ask` has no timeout, so that is the steady state.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true })));
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));

    // 3. B's run finishes: a NEW pause, so it arms (notification #2 — correct).
    act(() => useSessions.getState().turnCompleted("B", "end_turn"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(2));
    expect(arm).toHaveBeenLastCalledWith(15, "Archimedes", "B finished — waiting for you");

    // 4. B's countdown elapses. Announcing B must ADD to the record, not replace
    //    A's — and A's gate is still open, so A must stay muted.
    passLater(20_000, () => useSessions.getState().titleSession("A", "Renamed"));
    expect(arm).toHaveBeenCalledTimes(2);
    expect(disarmsAfterBoot()).toBe(1);

    // 5. And the storm is broken: another unrelated write, another pass, still
    //    nothing. The single slot ping-ponged A→B→A→B one notification per
    //    `delaySecs` for as long as store writes landed.
    act(() => useSessions.getState().titleSession("B", "Also renamed"));
    expect(arm).toHaveBeenCalledTimes(2);
    expect(disarmsAfterBoot()).toBe(1);
  });
});

describe("useAttentionAlert — the snapshot reaches the rule", () => {
  it("arms for a pending permission prompt (the other gate family)", async () => {
    useSessions.setState({ sessions: [row("s1")], activeSessionId: "s1" });
    renderHook(() => useAttentionAlert());
    act(() =>
      usePermissions.getState().addPrompt("s1", "p1", {
        requestId: "p1",
        toolTitle: "bash",
        options: [],
      }),
    );
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    expect(arm).toHaveBeenCalledWith(15, "Archimedes", "s1 needs your answer");
  });

  it("labels the alert from the title when there is one, else the folder name", async () => {
    useSessions.setState({
      sessions: [row("s1", { cwd: "/work/widgets" })],
      activeSessionId: "s1",
      inTurn: { s1: true },
    });
    renderHook(() => useAttentionAlert());
    act(() => useSessions.getState().turnCompleted("s1", "end_turn"));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    expect(arm).toHaveBeenCalledWith(15, "Archimedes", "widgets finished — waiting for you");
  });
});

describe("useAttentionAlert — a stalled PARENT re-times its children's countdown", () => {
  /**
   * The accepted consequence of the re-key, stated honestly and measured (NOT
   * "once": see the comment on the `stalled` clause in `attention.ts` and ADR
   * 0040's amendment). R3's stall clause reads `stalled[armed.sessionId]`, and a
   * child trigger's sessionId is now its PARENT — so while the parent stays
   * stalled, every pass whose deps changed disarms the child's countdown and has
   * R5 re-arm the SAME trigger in the same pass, each re-arm restarting Rust's
   * clock at the full delay. The alert therefore arrives only after `delaySecs`
   * of total dependency quiet. The rule's semantics are deliberately NOT
   * changed here (R3/R5 are ADR-level rules); this pins what they cost.
   *
   * The shape is reachable: `handle_crash`
   * (`src-tauri/src/agent/session/router.rs`) marks the crashed session
   * stalled and calls `cleanup_pending_modals` for THAT session alone,
   * so a crashed parent leaves its child's `ask` open and announceable while
   * unrelated churn elsewhere keeps re-timing the alert that would name it.
   */
  const childGateArmed = async () => {
    useSessions.setState({ sessions: [row("main1"), row("B")], activeSessionId: "main1" });
    renderHook(() => useAttentionAlert());
    act(() => {
      addEntry("sub1", "main1", 1000);
      addGate("sub1", "call_0", "subagent:reviewer");
    });
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
  };

  it("re-times the SAME child countdown on EVERY pass while its parent stays stalled", async () => {
    await childGateArmed();
    // The parent's Worker crashes. R3 disarms the armed child countdown (it
    // reads the PARENT's stall flag) and R5 re-arms the same gate on the same
    // pass — so one command leaves the hook, and it is the `arm`.
    act(() => useSessions.getState().markStalled("main1", 1, null));
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(2));

    // And NOT once. Three further passes, each changing a dep and NONE of them
    // touching the parent, the child or its gate: each re-arms the identical
    // trigger, so Rust restarts its countdown from scratch every time and the
    // deadline the first `arm` booked is never reached.
    act(() => addGate("B", "gB")); // a gate opens in another Session
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(3));
    act(() =>
      usePermissions.getState().addPrompt("B", "pB", {
        requestId: "pB",
        toolTitle: "bash",
        options: [],
      }),
    ); // …then a Permission prompt
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(4));
    act(() => useSessions.getState().titleSession("B", "Renamed")); // …then a mere re-title
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(5));

    // Five commands, all the SAME pause with the SAME delay: the parked child's
    // alert is never cancelled (`arm` subsumes the owed `disarm`, so Rust hears
    // no disarm at all), only pushed back — it fires after `delaySecs` of quiet
    // over every store the snapshot reads.
    expect(arm.mock.calls).toEqual(
      Array.from({ length: 5 }, () => [15, "Archimedes", "main1 needs your answer"]),
    );
    expect(disarmsAfterBoot()).toBe(0);
  });

  it("only the gate leaving waitingIds disarms it — the CHILD's own stall disarms nothing", async () => {
    // The JS-side rule, and nothing more. Because the gate is keyed to the
    // parent, `stalled[child]` no longer reaches its own gate's evidence at all
    // (`attention.ts`: R3 tests `next.stalled[armed.sessionId]`, and that id is
    // the parent), so a child's stall lands a pass that says nothing. What DOES
    // disarm it is the gate leaving `waitingIds[parent]` — R3's MEMBERSHIP arm —
    // which is why the second half of this test drives `removeRequest` DIRECTLY.
    // That is a MANUFACTURED close frame: this test pins how the Client reacts
    // when a gate goes away, NOT a promise that Rust emits one for a crashed
    // child. It does not: `cleanup_pending_modals` needs a `live` entry, which
    // only the main-session start path creates (`establish_worker_session`,
    // `src-tauri/src/agent/session/mod.rs`), and a child's relayed ids are
    // tracked under the delivery id — the PARENT — so any frame that IS emitted
    // arrives as `removeRequest(parent, …)` and is a no-op here (ADR 0040's
    // amendment records the mis-keying as a known upstream defect). A crashed
    // child's open `ask` therefore stays on screen: the delegation ends at the
    // Worker's exit, and for a child merely PARKED on an unanswered gate the
    // delegation ends on NO clock at all (ADR 0055 makes a gate-parked child an
    // Active Subagent). Either way it is never because a close frame arrived.
    useSessions.setState({ sessions: [row("main1")], activeSessionId: "main1" });
    renderHook(() => useAttentionAlert());
    act(() => {
      addEntry("sub1", "main1", 1000);
      addGate("sub1", "call_0", "subagent:reviewer");
    });
    await waitFor(() => expect(arm).toHaveBeenCalledTimes(1));
    // The child's stall DOES land a pass (the `stalled` map is a snapshot dep),
    // and it says nothing: the countdown stands, deadline untouched.
    act(() => useSessions.getState().markStalled("sub1", 1, null));
    expect(arm).toHaveBeenCalledTimes(1);
    expect(disarmsAfterBoot()).toBe(0);
    // The gate going away is what retires the alert — exactly once, and no re-arm.
    // (The test supplies that removal itself; see the doc above.)
    act(() => useInteractive.getState().removeRequest("sub1", "call_0"));
    await waitFor(() => expect(disarmsAfterBoot()).toBe(1));
    expect(arm).toHaveBeenCalledTimes(1);
  });
});
