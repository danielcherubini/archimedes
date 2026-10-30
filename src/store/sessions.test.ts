import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../test/resetStores";
import {
  archivedInSpace,
  autoSelectActive,
  detachedSessions,
  discardSessionMessages,
  INITIAL_HISTORY_PAGE,
  liveSessionsInSpace,
  mostRecentLiveInSpace,
  OLDER_HISTORY_PAGE,
  spaceViewFor,
  useSessions,
  type Message,
} from "./sessions";
// The reducer helpers and the ACP frame type come from their OWN modules — the
// store's re-export barrel is gone (finding 13b).
import {
  applySessionUpdate,
  finalizeSessionMessages,
  rowToMessages,
} from "../lib/transcript/reducer";
import type { AcpSessionUpdate } from "../lib/tauri";
import { useInteractive } from "./interactive";
import { useSubagents } from "./subagents";
// Driven (not mocked) by the close-path tests below: the figure has to be read
// off `useInteractive.cost` BEFORE `dismissSession` deletes it, so the test must
// run the real dismiss-then-file ORDER rather than call the reducer directly.
import { onSessionClosed } from "../lib/sessionLifecycle";
import { expandMentions } from "../lib/skills";
import type { AgentDefinitionDto, HistoryPage, McpServerInfo } from "../lib/tauri";
import {
  loadHistory,
  setSessionArchived,
  setSpaceTrusted,
  deleteSpace,
  closeSession,
  cancelSession,
  resumeSession,
  startSession,
  reorderSessions as reorderSessionsCommand,
  reorderSpaces as reorderSpacesCommand,
} from "../lib/tauri";
import {
  getNewSpaceDialogOpen,
  setNewSpaceDialogOpen,
} from "../lib/newSpaceDialogState";
import type {
  CloseReasonStr,
  MessageRow,
  SessionInfo,
  SpaceRow,
} from "../lib/tauri";
import type { RecencyEvidence } from "../lib/sessionRecency";

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    resumeSession: vi.fn().mockResolvedValue({
      sessionId: "s1",
      cwd: "/x",
      capabilities: {},
      archived: false,
      configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "gpt-4" }],
    }),
    loadHistory: vi.fn().mockResolvedValue({ rows: [], hasMore: false, todos: null }),
    // The store's `archiveSession` / `unarchiveSession` / `deleteSession` call
    // these: mock them (the REAL wrappers would `invoke` and reject in
    // jsdom — no global Tauri mock exists).
    setSessionArchived: vi.fn().mockResolvedValue(true),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    deleteSpace: vi.fn().mockResolvedValue(undefined),
    setSpaceTrusted: vi.fn().mockResolvedValue(undefined),
    // The store's `closeSpace` stops the Space's live sessions with this.
    closeSession: vi.fn().mockResolvedValue(undefined),
    // `stopSession` cancels an in-flight turn with this.
    cancelSession: vi.fn().mockResolvedValue(undefined),
    // `startSessionInActiveSpace` starts the native session with this.
    startSession: vi.fn().mockResolvedValue({
      sessionId: "new1",
      cwd: "/tmp/ws",
      capabilities: {},
      archived: false,
    }),
    // The store's `reorderSessions` / `reorderSpaces` write the manual order with
    // these (ADR 0075). Mock them for the same reason as the commands above: the
    // REAL wrappers would `invoke` and reject in jsdom — no global Tauri mock
    // exists — so an un-mocked reorder failure would look nothing like its cause.
    reorderSessions: vi.fn().mockResolvedValue(undefined),
    reorderSpaces: vi.fn().mockResolvedValue(undefined),
  };
});

/**
 * Fixtures use EXACTLY the five `SessionInfo` wire fields — `SessionInfo`
 * over IPC has NO `createdAt` (see the ordering note in `sessions.ts`), so
 * the pure helpers must rely on input order, not invented timestamps.
 */
const info = (sessionId: string, cwd: string): SessionInfo => ({
  sessionId,
  cwd,
  capabilities: {},
  archived: false,
});

/**
 * `SpaceRow` carries `createdAt`/`lastOpenedAt` — these are the bookkeeping
 * timestamps of the `spaces` table itself (not of individual sessions). The
 * helpers never read `createdAt`, only `path`; the timestamps exist on the
 * fixture so the shape is full and it'd be obvious if a helper started
 * sorting on them (it must not — see the ordering note in `sessions.ts`).
 */
const row = (path: string, lastOpenedAt: number): SpaceRow => ({
  path,
  createdAt: lastOpenedAt - 86_400_000,
  lastOpenedAt,
  trusted: false,
});

/**
 * The recency evidence bag (ADR 0075). Empty by default: these fixtures are about
 * membership and live order, and an empty map makes every id equally unevidenced,
 * which is what the pre-T03 assertions were written against.
 */
const recencyEvidence = (
  recency: Record<string, number> = {},
  messages?: Record<string, Message[] | undefined>,
): RecencyEvidence => ({ recency, ...(messages ? { messages } : {}) });

/** The boot order map. EMPTY by default, and that default is load-bearing, not lazy:
 *  with no entries every id is unknown, every id ties, and `sortByManualOrder` falls
 *  through to input order — i.e. `[...live, ...stored]`, byte-for-byte the pre-T03
 *  sequence. A pre-existing fixture that did not care about order keeps its expected
 *  answer for the right reason. */
const noOrder = (): Record<string, number> => ({});

/**
 * `MessageRow` helper: override for `MessageRow` fixtures, to distinguish
 * it from the `SpaceRow` helper `row` above.
 */
const msgRow = (
  overrides: Partial<MessageRow> & { kind: MessageRow["kind"] },
): MessageRow => ({
  id: 1,
  sessionId: "s1",
  messageKey: null,
  payloadJson: "{}",
  createdAt: 1000,
  ...overrides,
});

const chunk = (messageId: string, text: string): AcpSessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
  messageId,
});

describe("applySessionUpdate — agent_message_chunk", () => {
  const thought = (messageId: string, text: string): AcpSessionUpdate => ({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
    messageId,
  });

  it("accumulates contiguous agent_thought_chunk chunks into one agent-thought message", () => {
    let messages: Message[] = [];
    messages = applySessionUpdate(messages, thought("m1", "think"), 1);
    messages = applySessionUpdate(messages, thought("m1", "ing"), 2);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "agent-thought",
      messageId: "m1",
      text: "thinking",
    });
  });

  it("starts a new agent-thought message when messageId changes", () => {
    let messages: Message[] = [];
    messages = applySessionUpdate(messages, thought("m1", "think"), 1);
    messages = applySessionUpdate(messages, thought("m2", "ing"), 2);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ kind: "agent-thought", messageId: "m1", text: "think" });
    expect(messages[1]).toMatchObject({ kind: "agent-thought", messageId: "m2", text: "ing" });
  });

  it("starts a new agent-thought message after an intervening text chunk", () => {
    let messages: Message[] = [];
    messages = applySessionUpdate(messages, thought("m1", "t1"), 1);
    messages = applySessionUpdate(messages, chunk("m1", "text"), 2);
    messages = applySessionUpdate(messages, thought("m1", "t2"), 3);
    const thoughts = messages.filter((m) => m.kind === "agent-thought");
    expect(thoughts).toHaveLength(2);
    expect(thoughts[0]).toMatchObject({ text: "t1" });
    expect(thoughts[1]).toMatchObject({ text: "t2" });
  });

  it("ignores non-text or empty thought chunks", () => {
    let messages: Message[] = [];
    messages = applySessionUpdate(
      messages,
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "image", data: "x" },
        messageId: "m1",
      },
      1,
    );
    expect(messages).toHaveLength(0);
    messages = applySessionUpdate(messages, thought("m1", ""), 2);
    expect(messages).toHaveLength(0);
  });
});

describe("rowToMessages — agent-thought", () => {
  it("maps an agent-thought row to an agent-thought message", () => {
    const [msg] = rowToMessages(
      msgRow({
        kind: "agent-thought",
        messageKey: "m9#1",
        payloadJson: JSON.stringify({ text: "recalled" }),
        createdAt: 123,
      }),
    );
    expect(msg).toEqual({
      kind: "agent-thought",
      messageId: "m9#1",
      text: "recalled",
      at: 123,
    });
  });

  it("returns empty for an agent-thought row with a non-string payload.text", () => {
    const messages = rowToMessages(
      msgRow({
        kind: "agent-thought",
        payloadJson: JSON.stringify({ text: 123 }),
      }),
    );
    expect(messages).toHaveLength(0);
  });
});

describe("applySessionUpdate — agent_message_chunk", () => {
  it("appends a chunk to the agent-text message with the same messageId", () => {
    let messages: Message[] = [];
    messages = applySessionUpdate(messages, chunk("m1", "hello"), 1);
    messages = applySessionUpdate(messages, chunk("m1", " world"), 2);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "agent-text",
      messageId: "m1",
      text: "hello world",
    });
  });

  it("starts a new message when the messageId changes", () => {
    let messages: Message[] = [];
    messages = applySessionUpdate(messages, chunk("m1", "hello"), 1);
    messages = applySessionUpdate(messages, chunk("m2", "second"), 2);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ kind: "agent-text", text: "hello" });
    expect(messages[1]).toMatchObject({
      kind: "agent-text",
      messageId: "m2",
      text: "second",
    });
  });

  it("does not merge chunks across a tool call with the same messageId", () => {
    let messages: Message[] = [];
    messages = applySessionUpdate(messages, chunk("m1", "pre"), 1);
    messages = applySessionUpdate(
      messages,
      { sessionUpdate: "tool_call", toolCallId: "tc1", title: "tool" },
      2,
    );
    messages = applySessionUpdate(messages, chunk("m1", "post"), 3);
    // The tool call in between breaks the run: a new agent-text message is
    // created rather than appending to the earlier one.
    const texts = messages.filter((m) => m.kind === "agent-text");
    expect(texts).toHaveLength(2);
    expect(texts[1]).toMatchObject({ text: "post" });
  });

  it("ignores non-text chunk content", () => {
    const messages = applySessionUpdate(
      [],
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "x" },
        messageId: "m1",
      },
      1,
    );
    expect(messages).toHaveLength(0);
  });
});

describe("applySessionUpdate — tool calls", () => {
  it("creates a tool-call message on tool_call", () => {
    const messages = applySessionUpdate(
      [],
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "edit file",
        status: "in_progress",
      },
      1,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "tool-call",
      id: "tc1",
      title: "edit file",
      status: "pending",
    });
  });

  it("updates the existing tool call on tool_call_update", () => {
    let messages = applySessionUpdate(
      [],
      { sessionUpdate: "tool_call", toolCallId: "tc1", title: "edit" },
      1,
    );
    messages = applySessionUpdate(
      messages,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
      },
      2,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "tool-call", status: "completed" });
  });

  it("updates the title when the update carries one", () => {
    let messages = applySessionUpdate(
      [],
      { sessionUpdate: "tool_call", toolCallId: "tc1", title: "edit" },
      1,
    );
    messages = applySessionUpdate(
      messages,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        title: "edit (done)",
      },
      2,
    );
    expect(messages[0]).toMatchObject({ title: "edit (done)" });
  });

  it("keeps rawInput on the tool-call message", () => {
    const messages = applySessionUpdate(
      [],
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "manage_todo_list",
        rawInput: { operation: "write", todoList: [{ content: "a", status: "pending" }] },
      },
      1,
    );
    const toolCall = messages.find((m) => m.kind === "tool-call");
    if (toolCall?.kind !== "tool-call") throw new Error("no tool-call message");
    expect(toolCall.rawInput).toEqual({
      operation: "write",
      todoList: [{ content: "a", status: "pending" }],
    });
  });

  it("keeps the rawInput from a tool_call_update when the update carries one", () => {
    let messages = applySessionUpdate(
      [],
      { sessionUpdate: "tool_call", toolCallId: "tc1", title: "manage_todo_list" },
      1,
    );
    messages = applySessionUpdate(
      messages,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        rawInput: { operation: "write", todoList: [{ content: "b", status: "completed" }] },
      },
      2,
    );
    const toolCall = messages.find((m) => m.kind === "tool-call");
    if (toolCall?.kind !== "tool-call") throw new Error("no tool-call message");
    expect(toolCall.rawInput).toEqual({
      operation: "write",
      todoList: [{ content: "b", status: "completed" }],
    });
  });

  it("preserves an earlier rawInput when a later update carries none", () => {
    let messages = applySessionUpdate(
      [],
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "manage_todo_list",
        rawInput: { operation: "write", todoList: [{ content: "a", status: "pending" }] },
      },
      1,
    );
    messages = applySessionUpdate(
      messages,
      { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" },
      2,
    );
    const toolCall = messages.find((m) => m.kind === "tool-call");
    if (toolCall?.kind !== "tool-call") throw new Error("no tool-call message");
    expect(toolCall.rawInput).toEqual({
      operation: "write",
      todoList: [{ content: "a", status: "pending" }],
    });
  });

  it("keeps rawOutput on the tool-call message", () => {
    const messages = applySessionUpdate(
      [],
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "bash",
        rawOutput: { content: [{ type: "text", text: "hello" }] },
      },
      1,
    );
    const toolCall = messages.find((m) => m.kind === "tool-call");
    if (toolCall?.kind !== "tool-call") throw new Error("no tool-call message");
    expect(toolCall.rawOutput).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("keeps the rawOutput from a tool_call_update", () => {
    let messages = applySessionUpdate(
      [],
      { sessionUpdate: "tool_call", toolCallId: "tc1", title: "bash" },
      1,
    );
    messages = applySessionUpdate(
      messages,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        rawOutput: { content: [{ type: "text", text: "world" }] },
      },
      2,
    );
    const toolCall = messages.find((m) => m.kind === "tool-call");
    if (toolCall?.kind !== "tool-call") throw new Error("no tool-call message");
    expect(toolCall.rawOutput).toEqual({ content: [{ type: "text", text: "world" }] });
  });

  it("preserves an earlier rawOutput when a later update carries none", () => {
    let messages = applySessionUpdate(
      [],
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "bash",
        rawOutput: { content: [{ type: "text", text: "hello" }] },
      },
      1,
    );
    messages = applySessionUpdate(
      messages,
      { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" },
      2,
    );
    const toolCall = messages.find((m) => m.kind === "tool-call");
    if (toolCall?.kind !== "tool-call") throw new Error("no tool-call message");
    expect(toolCall.rawOutput).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("stores rawOutput when a tool_call_update arrives for a tool call we never saw", () => {
    const messages = applySessionUpdate(
      [],
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        rawOutput: { content: [{ type: "text", text: "late" }] },
      },
      1,
    );
    const toolCall = messages.find((m) => m.kind === "tool-call");
    if (toolCall?.kind !== "tool-call") throw new Error("no tool-call message");
    expect(toolCall.rawOutput).toEqual({ content: [{ type: "text", text: "late" }] });
  });

  it("extracts a diff from a tool_call's content into a diff message", () => {
    const messages = applySessionUpdate(
      [],
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "edit",
        content: [
          {
            type: "diff",
            path: "/tmp/x.txt",
            oldText: "a\nb\n",
            newText: "a\nc\n",
          },
        ],
      },
      1,
    );
    const diff = messages.find((m) => m.kind === "diff");
    expect(diff).toBeDefined();
    if (diff?.kind !== "diff") throw new Error("no diff message");
    expect(diff.path).toBe("/tmp/x.txt");
    expect(diff.patch).toContain("-b");
    expect(diff.patch).toContain("+c");
    const toolCall = messages.find((m) => m.kind === "tool-call");
    if (toolCall?.kind !== "tool-call") throw new Error("no tool-call message");
    expect(toolCall.diff?.path).toBe("/tmp/x.txt");
  });

  it("extracts diffs from tool_call_update content", () => {
    let messages = applySessionUpdate(
      [],
      { sessionUpdate: "tool_call", toolCallId: "tc1", title: "edit" },
      1,
    );
    messages = applySessionUpdate(
      messages,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        content: [
          { type: "diff", path: "/tmp/y.txt", newText: "new\n" },
        ],
      },
      2,
    );
    const diff = messages.find((m) => m.kind === "diff");
    expect(diff).toBeDefined();
    if (diff?.kind !== "diff") throw new Error("no diff message");
    expect(diff.path).toBe("/tmp/y.txt");
    expect(diff.patch).toContain("+new");
  });

  it("ignores unknown update types", () => {
    const messages = applySessionUpdate(
      [],
      { sessionUpdate: "plan", plan: [] } as unknown as AcpSessionUpdate,
      1,
    );
    expect(messages).toHaveLength(0);
  });
});

// (ADR 0048) An Abandoned attempt's reply is RetRACTED by protocol, so the
// Client must erase it. The live reducer APPENDS same-`messageId` chunks (that
// is the welding hazard), so the Retraction removes instead — and it removes
// thought as well as text, because a live thought message carries the bare
// message id (the `#n` suffix exists only in the persisted row key).
describe("applySessionUpdate — message_retracted (ADR 0048)", () => {
  it("removes every message carrying the retracted messageId", () => {
    const before: Message[] = [
      { kind: "user", text: "go", at: 1 },
      { kind: "agent-thought", messageId: "m1", text: "th", at: 2 },
      { kind: "agent-text", messageId: "m1", text: "parti", at: 3 },
    ];
    expect(
      applySessionUpdate(
        before,
        { sessionUpdate: "message_retracted", messageId: "m1" },
        4,
      ),
    ).toEqual([{ kind: "user", text: "go", at: 1 }]);
  });

  it("is silent when nothing was streamed under that messageId", () => {
    // The common pre-stream retry emits a Retraction that matches nothing.
    // SAME reference back, or the batch reducer's `next !== sessionMessages`
    // changed-sentinel would read silence as a change and re-render.
    const before: Message[] = [
      { kind: "agent-text", messageId: "m1", text: "kept", at: 1 },
    ];
    expect(
      applySessionUpdate(
        before,
        { sessionUpdate: "message_retracted", messageId: "m9" },
        2,
      ),
    ).toBe(before);
  });

  it("leaves the discard line and the tool cards alone", () => {
    // The bookkeeping ids are never the abandoned id: `system` is the harness's
    // own line key, `retract:N` is the discard line's unique id (the Retraction
    // frame and its line are separate frames, so the line survives its own
    // erasure), and a tool card is keyed by `toolCallId`, not `messageId`.
    const before: Message[] = [
      {
        kind: "agent-text",
        messageId: "system",
        text: "Retrying (attempt 1/3…)",
        at: 1,
      },
      {
        kind: "agent-text",
        messageId: "retract:1",
        text: "Discarded an incomplete reply",
        at: 2,
      },
      { kind: "tool-call", id: "tc1", title: "bash", status: "pending", at: 3 },
      { kind: "agent-text", messageId: "m1", text: "parti", at: 4 },
    ];
    expect(
      applySessionUpdate(
        before,
        { sessionUpdate: "message_retracted", messageId: "m1" },
        5,
      ),
    ).toEqual([before[0], before[1], before[2]]);
  });

  it("drops only the reply of the incarnation the Retraction names (two lives, the same counter value — ADR 0049)", () => {
    // WHY THIS EXISTS: every other case in this block uses BARE ids, so none of
    // them could tell an exact comparison from a NORMALISED one. Stripping an
    // id's `{stamp}:` prefix (or its `#seg` suffix) before comparing looks
    // harmless against bare ids and is exactly the defect ADR 0049 removes:
    // two Worker lives of one Session both mint `m1`, so a normalising filter
    // erases the PREVIOUS incarnation's answer along with the abandoned reply.
    // ADR 0050 weighed that normalisation and rejected it for the same reason.
    // So: red for any future change that touches an id before comparing it
    // (verified — stripping the stamp in the comparison reddens THIS test).
    const before: Message[] = [
      { kind: "agent-text", messageId: "a3f9c1:m1", text: "old", at: 1 },
      { kind: "agent-text", messageId: "bbbbbb:m1", text: "new", at: 2 },
    ];
    expect(
      applySessionUpdate(
        before,
        { sessionUpdate: "message_retracted", messageId: "bbbbbb:m1" },
        3,
      ),
    ).toEqual([{ kind: "agent-text", messageId: "a3f9c1:m1", text: "old", at: 1 }]);
  });
});

// A Retraction has no row kind of its own: the display store has no DELETE, so
// it OVERWRITES the abandoned rows with empty text (ADR 0048). History must
// therefore hydrate an empty text row as nothing, or the erased reply returns
// as an empty bubble.
describe("rowToMessages — an empty retraction row (ADR 0048)", () => {
  it("hydrates an empty agent-text row as nothing", () => {
    expect(
      rowToMessages(
        msgRow({ kind: "agent-text", messageKey: "m1", payloadJson: '{"text":""}' }),
      ),
    ).toEqual([]);
  });

  it("hydrates an empty agent-thought row as nothing", () => {
    expect(
      rowToMessages(
        msgRow({
          kind: "agent-thought",
          messageKey: "m1#1",
          payloadJson: '{"text":""}',
        }),
      ),
    ).toEqual([]);
  });
});

describe("spaceViewFor (per-space grouping, pure)", () => {
  // Both lists arrive in the user's MANUAL ORDER from the server (ADR 0075) —
  // input order IS the display order, and it is evidence of nothing else.
  const spaces = [
    row("/workspaces/alpha", 3000),
    row("/workspaces/bravo", 2000),
    row("/workspaces/charlie", 1000),
  ];
  const sessions = [info("live-alpha", "/workspaces/alpha")];
  // Passed in a SPECIFIC order to prove no re-sort by a nonexistent field.
  const historySessions = [
    info("stored-alpha", "/workspaces/alpha"),
    info("idX", "/workspaces/bravo"),
    info("idY", "/workspaces/bravo"),
  ];
  const closeReasons: Record<string, CloseReasonStr> = {
    "live-alpha": "user",
    "stored-alpha": "error",
    idX: "agent-exited",
  };

  // The ORDER map puts the LIVE row AFTER the stored one here
  // (`live-alpha` 5 > `stored-alpha` 2), so `sessionIds` is
  // ["stored-alpha", "live-alpha"] — NOT the live-block-first concatenation the
  // two arms used to produce. `lastReason` stays "user" regardless: which row a
  // tab OPENS (live preferred) and where that row RENDERs are different
  // questions with different rules.
  it("groups a space with a live session and a stored session", () => {
    const view = spaceViewFor(
      spaces[0],
      sessions,
      historySessions,
      closeReasons,
      [],
      recencyEvidence(),
      { "live-alpha": 5, "stored-alpha": 2 },
    );
    expect(view).toEqual({
      path: "/workspaces/alpha",
      title: "alpha",
      sessionIds: ["stored-alpha", "live-alpha"],
      liveSessionId: "live-alpha",
      archivedSessionIds: [],
      trusted: false,
      // The Landing Session's reason: the live one's (`live-alpha` →
      // `user`), NOT the stored session's (`stored-alpha` → `error`) —
      // proves the lookup does not fall through to the stored one.
      lastReason: "user",
    });
  });

  it("returns sessionIds in the stored order the boot map carries (no re-sort)", () => {
    // The map AGREES with the fixture's input order on purpose: this test is
    // about "the store invents no sequence of its own", not about the merge —
    // `"a Session RESUMED this boot keeps the MIDDLE slot …"` owns the merge.
    const view = spaceViewFor(
      spaces[1],
      sessions,
      historySessions,
      closeReasons,
      [],
      recencyEvidence(),
      { idX: 0, idY: 1 },
    );
    expect(view).toEqual({
      path: "/workspaces/bravo",
      title: "bravo",
      sessionIds: ["idX", "idY"],
      liveSessionId: null,
      archivedSessionIds: [],
      trusted: false,
      // No live session: the most RECENT stored session's reason, and with an
      // empty recency map every id is equally unevidenced, so the tie falls
      // through to input order — `idX`, whose reason the fixture records.
      lastReason: "agent-exited",
    });
  });

  it("returns an empty shape for a space with no sessions", () => {
    const view = spaceViewFor(
      spaces[2],
      sessions,
      historySessions,
      closeReasons,
      [],
      recencyEvidence(),
      noOrder(),
    );
    expect(view).toEqual({
      path: "/workspaces/charlie",
      title: "charlie",
      sessionIds: [],
      liveSessionId: null,
      archivedSessionIds: [],
      trusted: false,
      lastReason: undefined,
    });
  });

  // THE test the D11 reversal exists for. `/w/alpha` holds three rows the user
  // arranged (numbers 0/1/2) and the MIDDLE one has just been resumed, so it is
  // LIVE. TWO COMPETING ANSWERS for this fixture: "live block first" — the old
  // two-arm concatenation — answers
  // ["resumed", "stored_top", "stored_bottom"], while ONE order by the stored
  // number answers ["stored_top", "resumed", "stored_bottom"]. The row the user
  // positioned does not move. The fixture drives the REAL `resumeSession`
  // action (not a hand-built post-resume state), so the live/stored list
  // bookkeeping this test depends on is the store's own.
  it("a Session RESUMED this boot keeps the MIDDLE slot the database holds for it (one sequence spans live and stored)", async () => {
    useSessions.setState({
      spaces: [row("/w/alpha", 1000)],
      sessions: [],
      historySessions: [
        info("stored_top", "/w/alpha"),
        info("resumed", "/w/alpha"),
        info("stored_bottom", "/w/alpha"),
      ],
      archivedSessions: [],
      activeSessionId: null,
      activeSpacePath: null,
      closeReasons: {},
      messages: {},
      sessionRecency: {},
      sessionOrder: { stored_top: 0, resumed: 1, stored_bottom: 2 },
    });
    vi.mocked(resumeSession).mockResolvedValueOnce({
      sessionId: "resumed",
      cwd: "/w/alpha",
      capabilities: {},
      archived: false,
    });
    await useSessions.getState().resumeSession("resumed");

    const s = useSessions.getState();
    // The store's own bookkeeping first: the resumed id left the stored arm and
    // is now live (so the two INPUTS to the merge really do span both arms).
    expect(s.sessions.map((x) => x.sessionId)).toEqual(["resumed"]);
    expect(s.historySessions.map((x) => x.sessionId)).toEqual([
      "stored_top",
      "stored_bottom",
    ]);

    const view = spaceViewFor(
      s.spaces[0],
      s.sessions,
      s.historySessions,
      s.closeReasons,
      s.archivedSessions,
      recencyEvidence(),
      s.sessionOrder,
    );
    expect(view.sessionIds).toEqual(["stored_top", "resumed", "stored_bottom"]);
    // This describe is otherwise PURE (no store writes), so this test cleans up
    // after itself rather than leaking a live row into the next describe.
    resetStores();
  });

  it("a live row whose id the order map does not know joins at the BOTTOM of the sequence", () => {
    // A Session started AFTER the boot fetch has no number anywhere. The
    // approved rule is "new rows join at the bottom", so an implementation that
    // defaulted the unknown to `0` — which would promote the fresh row to the
    // TOP of a list the user arranged — is red here.
    const view = spaceViewFor(
      row("/w/alpha", 1000),
      [info("fresh", "/w/alpha")],
      [info("stored_row", "/w/alpha")],
      {},
      [],
      recencyEvidence(),
      { stored_row: 0 },
    );
    expect(view.sessionIds).toEqual(["stored_row", "fresh"]);
  });

  // The one-live cap is LIFTED: a space may hold MORE than one
  // live session. `sessions` is in insertion order (newest appended by
  // `addSession` / `resumeSession`), so the space row points at the
  // MOST-RECENTLY-STARTED one.
  //
  // T05 repurposed this test: the newest-first ORDER half used to be read off
  // the view's `liveSessionIds`, a field that has since been deleted (ADR 0075 —
  // the view carries ONE sequence, `sessionIds`). The order contract now lives
  // on `liveSessionsInSpace`, whose own test
  // `"returns session IDs for matching cwd in reverse insertion order (newest first)"`
  // pins it; what the VIEW still owns is the LIVE DOT, which is the fact the tab
  // renders. Both halves stay asserted here, on the fields that carry them.
  it("a space with TWO coexisting live sessions points at the most-recently-started one (the one-live cap lift)", () => {
    const twoLive = [
      info("first", "/workspaces/alpha"),
      info("second", "/workspaces/alpha"),
    ];
    // The order half, on the helper that owns it: newest STARTED first.
    expect(liveSessionsInSpace(twoLive, "/workspaces/alpha")).toEqual([
      "second",
      "first",
    ]);
    const view = spaceViewFor(
      spaces[0],
      twoLive,
      historySessions,
      closeReasons,
      [],
      recencyEvidence(),
      noOrder(),
    );
    // The live-dot half, on the view: the tab's dot points at the newest one,
    // i.e. the head of the helper's answer.
    expect(view.liveSessionId).toBe("second");
    expect(view.liveSessionId).toBe(
      liveSessionsInSpace(twoLive, "/workspaces/alpha")[0] ?? null,
    );
  });

  it("autoSelectActive prefers the most-recently-started live session in the space (the one-live cap lift)", () => {
    const twoLive = [
      info("first", "/workspaces/alpha"),
      info("second", "/workspaces/alpha"),
    ];
    expect(
      autoSelectActive(spaces, twoLive, historySessions, recencyEvidence()),
    ).toBe("second");
  });

  // Same repurposing as the two-live test above: the newest-first ORDER half
  // read the view's deleted `liveSessionIds` field (ADR 0075); it now belongs to
  // `liveSessionsInSpace`, and the VIEW keeps the live-dot half.
  it("a space with three or more live sessions orders them newest-first", () => {
    const threeLive = [
      info("s1", "/workspaces/alpha"),
      info("s2", "/workspaces/alpha"),
      info("s3", "/workspaces/alpha"),
    ];
    // The order half, on the helper that owns it.
    expect(liveSessionsInSpace(threeLive, "/workspaces/alpha")).toEqual([
      "s3",
      "s2",
      "s1",
    ]);
    const view = spaceViewFor(
      spaces[0],
      threeLive,
      historySessions,
      closeReasons,
      [],
      recencyEvidence(),
      noOrder(),
    );
    // The live-dot half, on the view.
    expect(view.liveSessionId).toBe("s3");
  });

  // Its subject is per-Space MEMBERSHIP ACROSS Spaces, not the deleted pair, so
  // it survives on the view — and gets STRONGER: it now pins the rendered
  // sequence too, not just an input list.
  //
  // TWO COMPETING ANSWERS for Space A: with NO order map every id is unknown,
  // every id ties, and the sequence is `liveSessionsInSpace`'s reverse insertion
  // order — ["alpha-3","alpha-2","alpha-1"]. The seeded map below is what makes
  // the fixture's own order the answer: ["alpha-3","alpha-1","alpha-2"], which
  // reverse insertion order cannot produce. (A fixture expecting
  // ["alpha-1","alpha-2","alpha-3"] here has mis-read the helper.)
  it("handles live sessions from multiple different spaces interleaved", () => {
    const interleavedLive = [
      info("alpha-1", "/workspaces/alpha"),
      info("bravo-1", "/workspaces/bravo"),
      info("alpha-2", "/workspaces/alpha"),
      info("bravo-2", "/workspaces/bravo"),
      info("alpha-3", "/workspaces/alpha"),
    ];
    const alphaView = spaceViewFor(
      spaces[0],
      interleavedLive,
      historySessions,
      closeReasons,
      [],
      recencyEvidence(),
      { "alpha-3": 0, "alpha-1": 1, "alpha-2": 2 },
    );
    expect(alphaView.sessionIds).toEqual([
      "alpha-3",
      "alpha-1",
      "alpha-2",
      // The describe's stored row for this Space: the map does not know it, so
      // it sinks to the BOTTOM (the "unknown id joins at the bottom" rule).
      "stored-alpha",
    ]);
    expect(alphaView.liveSessionId).toBe("alpha-3");

    const bravoView = spaceViewFor(
      spaces[1],
      interleavedLive,
      historySessions,
      closeReasons,
      [],
      recencyEvidence(),
      noOrder(),
    );
    // Space B has no map, so its live rows keep reverse insertion order and its
    // stored rows follow — the point being that Space A's map moved nothing in
    // Space B.
    expect(bravoView.sessionIds).toEqual([
      "bravo-2",
      "bravo-1",
      "idX",
      "idY",
    ]);
    expect(bravoView.liveSessionId).toBe("bravo-2");
  });
});

describe("liveSessionsInSpace (pure ordering and filtering)", () => {
  it("returns session IDs for matching cwd in reverse insertion order (newest first)", () => {
    const s = [
      info("a1", "/space/a"),
      info("b1", "/space/b"),
      info("a2", "/space/a"),
      info("c1", "/space/c"),
      info("a3", "/space/a"),
    ];
    expect(liveSessionsInSpace(s, "/space/a")).toEqual(["a3", "a2", "a1"]);
    expect(liveSessionsInSpace(s, "/space/b")).toEqual(["b1"]);
    expect(liveSessionsInSpace(s, "/space/empty")).toEqual([]);
  });

  it("mostRecentLiveInSpace returns the newest session ID or null", () => {
    const s = [
      info("a1", "/space/a"),
      info("a2", "/space/a"),
    ];
    expect(mostRecentLiveInSpace(s, "/space/a")).toBe("a2");
    expect(mostRecentLiveInSpace(s, "/space/none")).toBeNull();
  });
});

describe("autoSelectActive (boot auto-select, pure)", () => {
  // `spaces` arrives in the user's MANUAL ORDER — that IS input order (the
  // leftmost tab first); the function must NOT re-sort.
  const spaces = [
    row("/a/space-one", 3000),
    row("/a/space-two", 2000),
    row("/a/space-three", 1000),
    row("/a/space-four", 500),
  ];

  it("returns null when there is nothing at all", () => {
    expect(autoSelectActive([], [], [], recencyEvidence())).toBeNull();
    expect(autoSelectActive(spaces, [], [], recencyEvidence())).toBeNull();
  });

  it("prefers the first space's live session", () => {
    const live = [info("live-1", "/a/space-one")];
    const stored = [
      info("old-1", "/a/space-one"),
      info("old-2", "/a/space-two"),
    ];
    // Even if the other space's stored session is older/newer, the live
    // session in the most recent space wins.
    expect(
      autoSelectActive(spaces, live, stored, recencyEvidence()),
    ).toBe("live-1");
  });

  it("skips a space with no sessions and advances to the next", () => {
    const stored = [
      info("newest-2", "/a/space-two"),
      info("older-2", "/a/space-two"),
    ];
    expect(
      autoSelectActive(spaces, [], stored, recencyEvidence()),
    ).toBe("newest-2");
  });

  it("a stored Session in the FIRST Space still beats a LIVE one in a later Space", () => {
    // The loop's subtle half, and after ADR 0075 nothing else pins it:
    // `autoSelectActive` walks SPACES first and only then considers live vs
    // stored, so Space precedence outranks the live-over-stored preference.
    // The evidence favours nothing in Space one (both of its rows are
    // unevidenced), so the answer comes from the Space walk and not from
    // recency — `"…lands on the most recent stored Session of the first Space…"`
    // owns the within-Space choice.
    const stored = [
      info("newest-1", "/a/space-one"),
      info("older-1", "/a/space-one"),
    ];
    const live = [info("live-two", "/a/space-two")];
    expect(
      autoSelectActive(spaces, live, stored, recencyEvidence({ "live-two": 9_000_000_000_000 })),
    ).toBe("newest-1");
  });

  it("the FIRST Space in manual order wins over a more recent session in a later Space", () => {
    const stored = [
      info("head-1", "/a/space-one"),
      info("brand-new-2", "/a/space-two"),
      info("older-2", "/a/space-two"),
    ];
    // The evidence now FAVOURS the second Space's row — the recency map IS the
    // timestamp now, so the assertion proves the SPACE-level precedence rather
    // than input order. Expected id unchanged from the pre-ADR-0075 fixture,
    // reason entirely different: boot lands in the LEFTMOST Space that has
    // anything, however stale its rows are.
    expect(
      autoSelectActive(
        spaces,
        [],
        stored,
        recencyEvidence({ "brand-new-2": 9_000_000_000_000, "head-1": 1_000 }),
      ),
    ).toBe("head-1");
  });
});

describe("Landing Session (ADR 0075: recency decides, position never does)", () => {
  beforeEach(() => resetStores());
  afterEach(() => resetStores());

  const space = (path: string): SpaceRow => ({
    path,
    createdAt: 0,
    lastOpenedAt: 0,
    trusted: false,
  });

  it("selectSpace lands on the most RECENT stored Session even when it sits LAST in the Space's manual order", () => {
    // TWO COMPETING ANSWERS: the head of the stored subsequence is `hist_first`;
    // max `recencyOf` is `hist_last`. This is the exact conflation ADR 0075 was
    // written to break, at the tab-click site.
    useSessions.setState({
      spaces: [space("/a"), space("/b")],
      activeSpacePath: "/a",
      historySessions: [
        info("hist_first", "/b"),
        info("hist_last", "/b"),
      ],
      sessionRecency: { hist_first: 1_000, hist_last: 9_000_000_000_000 },
    });
    useSessions.getState().selectSpace("/b");
    expect(useSessions.getState().activeSessionId).toBe("hist_last");
  });

  it("autoSelectActive lands on the most recent stored Session of the first Space in manual order, not its head", () => {
    // The within-Space choice at BOOT: the first Space's stored subsequence is
    // ["head", "tail"] and `tail` carries the far-future stamp. Head-first
    // answers "head", max recency answers "tail".
    expect(
      autoSelectActive(
        [space("/a/space-one"), space("/a/space-two")],
        [],
        [info("head", "/a/space-one"), info("tail", "/a/space-one")],
        recencyEvidence({ head: 1_000, tail: 9_000_000_000_000 }),
      ),
    ).toBe("tail");
  });

  it("a Session dragged to the BOTTOM of the manual order is still the Landing Session when it is the most recent", () => {
    // THE test that would have caught the original bug (spec §9), and the pin
    // that keeps the two boot maps from contaminating each other: `bottom` has
    // the LARGEST order number (so it renders LAST) and the NEWEST stamp (so
    // boot lands on it). Point the Landing Session at the order map and this
    // goes red.
    useSessions.getState().setHistorySessions([
      { ...info("top", "/a"), archived: false },
      { ...info("bottom", "/a"), archived: false },
    ]);
    useSessions.getState().setSessionRecency([
      { sessionId: "top", lastActiveAt: 1_000, sortOrder: 0 },
      { sessionId: "bottom", lastActiveAt: 9_000_000_000_000, sortOrder: 5 },
    ]);
    useSessions.getState().setSpaces([space("/a")]);
    expect(useSessions.getState().activeSessionId).toBe("bottom");
    // …and it still RENDERS last, which is the half that must not move.
    const s = useSessions.getState();
    expect(
      spaceViewFor(
        s.spaces[0],
        s.sessions,
        s.historySessions,
        s.closeReasons,
        s.archivedSessions,
        { recency: s.sessionRecency },
        s.sessionOrder,
      ).sessionIds,
    ).toEqual(["top", "bottom"]);
  });

  it("removeSpace lands on the LEFTMOST remaining tab even when another Space holds the most recent Session", async () => {
    // THE PIN — this rule must NOT change. THREE Spaces so the two rules
    // disagree: after `/a` goes, `/b` is the LEFTMOST tab while `/c` holds the
    // by-far-newest Session. "Leftmost neighbour" answers "/b"; "the Space with
    // the most recent Session" (or "max recency over the remaining Spaces")
    // answers "/c". Closing a tab lands you on the tab to its left, which is
    // what the first row of the manual order now means.
    useSessions.setState({
      spaces: [space("/a"), space("/b"), space("/c")],
      activeSpacePath: "/a",
      historySessions: [info("sess-b", "/b"), info("sess-c", "/c")],
      sessionRecency: { "sess-b": 1_000, "sess-c": 9_000_000_000_000 },
    });
    const fallback = await useSessions.getState().removeSpace("/a");
    expect(fallback).toBe("/b");
    expect(useSessions.getState().activeSpacePath).toBe("/b");
  });
});

describe("finalizeSessionMessages (session-closed cleanup)", () => {
  it("marks pending tool calls failed and leaves finished ones alone", () => {
    let messages = applySessionUpdate(
      [],
      { sessionUpdate: "tool_call", toolCallId: "a", title: "a" },
      1,
    );
    messages = applySessionUpdate(
      messages,
      { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" },
      2,
    );
    messages = applySessionUpdate(
      messages,
      { sessionUpdate: "tool_call", toolCallId: "b", title: "b" },
      3,
    );
    const finalized = finalizeSessionMessages(messages);
    const a = finalized.find((m) => m.kind === "tool-call" && m.id === "a");
    const b = finalized.find((m) => m.kind === "tool-call" && m.id === "b");
    if (a?.kind !== "tool-call" || b?.kind !== "tool-call")
      throw new Error("missing tool calls");
    expect(a.status).toBe("completed");
    expect(b.status).toBe("failed");
  });
});

describe("discardSessionMessages (ephemeral subagent cleanup)", () => {
  // The store is global — reset the subagent entries and transcripts the
  // previous test may have left behind.
  beforeEach(() => {
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useSessions.setState({ messages: {} });
  });

  it("deletes a closed subagent session's messages (ephemeral: no history to preserve)", () => {
    useSubagents.getState().addSession({
      sessionId: "sub1",
      parentSessionId: "main1",
      agentName: "reviewer",
      task: "review the diff",
      status: "completed",
    });
    const sub: Message[] = [
      { kind: "agent-text", messageId: "m1", text: "hi", at: 1 },
      {
        kind: "tool-call",
        id: "t1",
        title: "Bash",
        status: "pending",
        at: 1,
      },
    ];
    const main: Message[] = [
      { kind: "agent-text", messageId: "m2", text: "main", at: 1 },
    ];
    useSessions.setState({ messages: { sub1: sub, main1: main } });

    useSessions.getState().handleSessionClosed("sub1", "user");
    discardSessionMessages("sub1");
    expect(useSessions.getState().messages["sub1"]).toBeUndefined();
    // The MAIN session's transcript is kept (finalized by
    // `handleSessionClosed`, NOT deleted — its history survives in the
    // database and the in-memory record stays).
    useSessions.getState().handleSessionClosed("main1", "user");
    discardSessionMessages("main1");
    expect(useSessions.getState().messages["main1"]).toEqual(
      finalizeSessionMessages(main),
    );
  });

  it("is a no-op for a main session id (no subagent entry)", () => {
    const main: Message[] = [{ kind: "user", text: "hello", at: 1 }];
    useSessions.setState({ messages: { main1: main } });
    discardSessionMessages("main1");
    expect(useSessions.getState().messages["main1"]).toEqual(main);
  });

  it("is a no-op when the subagent has no transcript yet", () => {
    useSubagents.getState().addSession({
      sessionId: "sub1",
      parentSessionId: "main1",
      agentName: "reviewer",
      task: "review the diff",
      status: "running",
    });
    discardSessionMessages("sub1");
    expect(useSessions.getState().messages).toEqual({});
  });

  it("deletes the transcript when the `subagent-closed` path runs `discardSessionMessages` + `markClosed` (the `listenSubagentClosed` handler's call sequence — the discard-before-eviction guarantee)", () => {
    // WHY this exists: `subagent-closed` is the ONLY frame that ever names the
    // end of a child session, so it is the only thing that can free the
    // transcript that child streamed into `messages[childId]`. No
    // `session-closed` carries a child id — its one emitter,
    // `on_session_exited_expected` (`src-tauri/src/agent/session/router.rs`),
    // returns without a `live` entry, and the only insert into `live` is
    // `establish_worker_session` (`src-tauri/src/agent/session/mod.rs`) on the
    // main-session paths — so the `session-closed` handler's own discard is a
    // guard that never fires here, and `markClosed`'s `evictOldestClosed` drops
    // the `SubagentEntry` alone, never `messages`. Without the discard the
    // transcript would outlive every surface that could show it.
    // (Discard must run BEFORE `markClosed`: `markClosed` can evict this entry
    // synchronously — the oldest of 21+ closed entries — and a discard
    // running after would then no-op its guard.)
    useSubagents.getState().addSession({
      sessionId: "sub2",
      parentSessionId: "main1",
      agentName: "reviewer",
      task: "review the diff",
      status: "running",
    });
    // A transcript the child streamed before it died (the shape the
    // `subagent-closed` handler has to clear):
    useSessions.setState({
      messages: {
        sub2: [{ kind: "agent-text", messageId: "m1", text: "partial", at: 1 }],
      },
    });
    // The `listenSubagentClosed` handler's call sequence (App.tsx) —
    // discard FIRST, then `markClosed`:
    discardSessionMessages("sub2");
    useSubagents.getState().markClosed("sub2", "failed", "died");
    expect(useSessions.getState().messages["sub2"]).toBeUndefined();
  });
});

describe("contextUsage (the context-percentage state)", () => {
  // The store is global — reset the maps the previous test may have left
  // behind (and the `afterAll` cleans up AFTER this block, so the next
  // block's assumption of a fresh store holds).
  beforeEach(() => {
    useSessions.setState({ contextUsage: {}, messages: {} });
  });
  afterAll(() => {
    useSessions.setState({ contextUsage: {}, messages: {} });
  });

  it("applySessionUpdates stores a context_usage_update frame per session", () => {
    useSessions
      .getState()
      .applySessionUpdates([
        {
          sessionId: "s1",
          update: {
            sessionUpdate: "context_usage_update",
            usedTokens: 12000,
            windowTokens: 128000,
          },
        },
      ]);
    expect(useSessions.getState().contextUsage["s1"]).toEqual({
      used: 12000,
      window: 128000,
    });
  });

  it("a later frame replaces the earlier one (last-wins)", () => {
    useSessions.getState().applySessionUpdates([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "context_usage_update",
          usedTokens: 12000,
          windowTokens: 128000,
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "context_usage_update",
          usedTokens: 9000,
          windowTokens: 128000,
        },
      },
    ]);
    expect(useSessions.getState().contextUsage["s1"]).toEqual({
      used: 9000,
      window: 128000,
    });
  });

  it("one frame per session does not clobber another session's entry", () => {
    useSessions.getState().applySessionUpdates([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "context_usage_update",
          usedTokens: 12000,
          windowTokens: 128000,
        },
      },
      {
        sessionId: "s2",
        update: {
          sessionUpdate: "context_usage_update",
          usedTokens: 3000,
          windowTokens: 64000,
        },
      },
    ]);
    expect(useSessions.getState().contextUsage["s1"]).toEqual({
      used: 12000,
      window: 128000,
    });
    expect(useSessions.getState().contextUsage["s2"]).toEqual({
      used: 3000,
      window: 64000,
    });
  });

  it("a context_usage_update frame does not touch the session's messages", () => {
    useSessions.setState({
      messages: { s1: [{ kind: "agent-text", messageId: "m1", text: "hi", at: 1 }] },
    });
    const before = useSessions.getState().messages["s1"];
    useSessions.getState().applySessionUpdates([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "context_usage_update",
          usedTokens: 12000,
          windowTokens: 128000,
        },
      },
    ]);
    expect(useSessions.getState().messages["s1"]).toBe(before);
  });

  it("handleSessionClosed KEEPS the session's config options + context usage (a pause, not a discard)", () => {
    useSessions.getState().applySessionUpdates([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              category: "model",
              currentValue: "tama/m1",
              options: [{ value: "tama/m1", name: "m1" }],
            },
          ],
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "context_usage_update",
          usedTokens: 12000,
          windowTokens: 128000,
        },
      },
    ]);
    useSessions.getState().handleSessionClosed("s1", "user");
    // A close is a PAUSE: the last known values STAY (the stored session's
    // bottom bar is populated — the selectors render disabled; a resume's
    // `config_option_update` / `context_usage_update` frames refresh them).
    expect(useSessions.getState().contextUsage["s1"]).toEqual({
      used: 12000,
      window: 128000,
    });
    expect(useSessions.getState().configOptions["s1"]?.[0]?.id).toBe("model");
  });
});

/**
 * The cost figure a session accumulated DURING this app run must survive its
 * close — the same retention the two tests above pin for `configOptions` and
 * `contextUsage`, and for the same reason: the row the session is filed into is
 * what `lib/sessionCost.ts`'s `costUsdOf` falls back to once the live
 * accumulator is gone, and `SidePane` keeps rendering the cost line after a
 * close.
 *
 * The two maps above live in THIS store, so `handleSessionClosed` keeps them by
 * simply not touching them. Cost does not: it lives in `useInteractive.cost`,
 * and `lib/sessionLifecycle.ts`'s `onSessionClosed` calls `dismissSession`,
 * which DELETES the entry, before `handleSessionClosed` files the row. The
 * figure therefore has to be captured before the dismiss and handed to the
 * reducer — which is what these tests drive, through the real `onSessionClosed`
 * so the dismiss-then-file ORDER is under test and not just the reducer's
 * arithmetic.
 */
describe("closing a session in this app run carries its cost figure onto the filed row (#105)", () => {
  beforeEach(() => resetStores());
  afterEach(() => resetStores());

  const filedRow = (sessionId: string): SessionInfo | undefined =>
    useSessions.getState().historySessions.find((s) => s.sessionId === sessionId);

  it("onSessionClosed files the session into historySessions carrying this run's costUsd", () => {
    // A session STARTED this run: its row carries no `costUsd` at all (the
    // fresh `start_session` reply has none), so the run's figure exists ONLY in
    // `useInteractive.cost` — the map the close dismisses.
    useSessions.setState({ sessions: [info("s1", "/x")] });
    useInteractive.getState().applyCost("s1", { costUsd: 0.42 });

    onSessionClosed("s1", "user");

    expect(filedRow("s1")?.costUsd).toBe(0.42);
  });

  it("a close with NO live cost entry files the row UNCHANGED (no `costUsd: undefined` key appears)", () => {
    // The guard is about the SHAPE THIS SIDE produces: a bare carry would
    // introduce a `costUsd` key holding `undefined`, and nothing else carries
    // that — a missing figure crosses IPC PRESENT and null (`cost_usd` is an
    // `Option<f64>` with `#[serde(default)]` and NO `skip_serializing_if`,
    // pinned in `src-tauri/src/agent/session/mod.rs`), and `makeSessionRow`
    // models no-figure as `null` or as no key, never as `undefined`. Hence the
    // guarded spread rather than a bare `{ ...closedInfo, costUsd: closedCost }`.
    const row = info("s1", "/x");
    useSessions.setState({ sessions: [row] });

    onSessionClosed("s1", "user");

    const filed = filedRow("s1");
    expect(filed).toBeDefined();
    expect("costUsd" in (filed as SessionInfo)).toBe(false);
    expect(filed).toEqual(row);
  });

  it("a close with no live figure KEEPS a resume-time `costUsd` already on the row (an absent run figure is not a wipe)", () => {
    useSessions.setState({
      sessions: [{ ...info("s1", "/x"), costUsd: 0.1 }],
    });

    onSessionClosed("s1", "user");

    expect(filedRow("s1")?.costUsd).toBe(0.1);
  });

  it("a closing ARCHIVED session's row in archivedSessions carries this run's costUsd too", () => {
    // The archived branch has the same staleness, and it is WORSE: the row is
    // never moved at all, so it keeps whatever `costUsd` the boot-time read put
    // on it while the run's figure dies with the dismissed map.
    useSessions.setState({
      sessions: [info("s1", "/x")],
      archivedSessions: [{ ...info("s1", "/x"), archived: true }],
    });
    useInteractive.getState().applyCost("s1", { costUsd: 0.42 });

    onSessionClosed("s1", "user");

    const st = useSessions.getState();
    expect(st.historySessions.map((s) => s.sessionId)).not.toContain("s1");
    expect(
      st.archivedSessions.find((s) => s.sessionId === "s1")?.costUsd,
    ).toBe(0.42);
  });

  it("an archived close with NO live figure leaves archivedSessions byte-for-byte unchanged", () => {
    // No run figure ⇒ no copy, no key: the untouched list keeps its reference,
    // which is what the reducer's `state.historySessions` passthrough already
    // guarantees for the other list.
    const archivedRow = { ...info("s1", "/x"), archived: true };
    useSessions.setState({
      sessions: [info("s1", "/x")],
      archivedSessions: [archivedRow],
    });

    onSessionClosed("s1", "user");

    const st = useSessions.getState();
    expect(st.archivedSessions).toEqual([archivedRow]);
    expect(st.archivedSessions[0]).toBe(archivedRow);
    expect("costUsd" in (st.archivedSessions[0] as SessionInfo)).toBe(false);
  });
});

describe("compacting (the working indicator's compaction state)", () => {
  // The store is global — reset the maps the previous test may have left
  // behind (and the `afterAll` cleans up AFTER this block, so the next
  // block's assumption of a fresh store holds).
  beforeEach(() => {
    useSessions.setState({
      compacting: {},
      contextUsage: {},
      messages: {},
      stalled: {},
    });
  });
  afterAll(() => {
    useSessions.setState({
      compacting: {},
      contextUsage: {},
      messages: {},
      stalled: {},
    });
  });

  const active = (reason: string): AcpSessionUpdate => ({
    sessionUpdate: "compaction_update",
    active: true,
    reason,
  });
  const settled = (reason: string): AcpSessionUpdate => ({
    sessionUpdate: "compaction_update",
    active: false,
    reason,
  });

  it("applySessionUpdates records the reason on an active frame", () => {
    useSessions
      .getState()
      .applySessionUpdates([{ sessionId: "s1", update: active("manual") }]);
    expect(useSessions.getState().compacting["s1"]).toBe("manual");
  });

  it("all three reasons are stored verbatim (the indicator's label is reason-independent, the state is not)", () => {
    for (const reason of ["manual", "threshold", "overflow"]) {
      useSessions
        .getState()
        .applySessionUpdates([{ sessionId: "s1", update: active(reason) }]);
      expect(useSessions.getState().compacting["s1"]).toBe(reason);
    }
  });

  it("an inactive frame clears it (any outcome ends the indicator)", () => {
    useSessions
      .getState()
      .applySessionUpdates([{ sessionId: "s1", update: active("overflow") }]);
    useSessions
      .getState()
      .applySessionUpdates([{ sessionId: "s1", update: settled("overflow") }]);
    expect(useSessions.getState().compacting["s1"]).toBeUndefined();
  });

  it("a batch carrying ONLY a compaction_update still updates the store (the changed sentinel)", () => {
    // The batch reducer ENDS with an early `return state` when nothing
    // changed. A compaction frame carries no message content and touches no
    // config/context, so without its OWN sentinel this update would be
    // silently dropped and the indicator would never appear.
    const before = useSessions.getState();
    useSessions
      .getState()
      .applySessionUpdates([{ sessionId: "s1", update: active("manual") }]);
    expect(useSessions.getState()).not.toBe(before);
    expect(useSessions.getState().compacting["s1"]).toBe("manual");
  });

  it("a coalescing batch (active then inactive in ONE frame) leaves it cleared (last-wins is deliberate)", () => {
    // A `Skipped` compaction emits both frames back-to-back, so they can
    // land in the SAME rAF batch. Last-wins within the batch is what makes
    // the indicator blink out instead of pinning on forever.
    useSessions.getState().applySessionUpdates([
      { sessionId: "s1", update: active("threshold") },
      { sessionId: "s1", update: settled("threshold") },
    ]);
    expect(useSessions.getState().compacting["s1"]).toBeUndefined();
  });

  it("one session's frame does not touch another session's entry", () => {
    useSessions
      .getState()
      .applySessionUpdates([{ sessionId: "s1", update: active("manual") }]);
    useSessions
      .getState()
      .applySessionUpdates([{ sessionId: "s2", update: active("overflow") }]);
    expect(useSessions.getState().compacting["s1"]).toBe("manual");
    expect(useSessions.getState().compacting["s2"]).toBe("overflow");
    useSessions
      .getState()
      .applySessionUpdates([{ sessionId: "s2", update: settled("overflow") }]);
    expect(useSessions.getState().compacting["s1"]).toBe("manual");
    expect(useSessions.getState().compacting["s2"]).toBeUndefined();
  });

  it("the single-frame action sets and clears it too (every frame reaches the frontend through one of the two)", () => {
    useSessions.getState().applySessionUpdate("s1", active("threshold"));
    expect(useSessions.getState().compacting["s1"]).toBe("threshold");
    useSessions.getState().applySessionUpdate("s1", settled("threshold"));
    expect(useSessions.getState().compacting["s1"]).toBeUndefined();
  });

  it("a compaction frame adds no message to the transcript", () => {
    useSessions.setState({
      messages: { s1: [{ kind: "agent-text", messageId: "m1", text: "hi", at: 1 }] },
    });
    const before = useSessions.getState().messages["s1"];
    useSessions
      .getState()
      .applySessionUpdates([{ sessionId: "s1", update: active("manual") }]);
    expect(useSessions.getState().messages["s1"]).toBe(before);
  });

  /**
   * The reducer's weld rule, still load-bearing — and now a rule a compaction
   * does NOT participate in.
   *
   * Every `system_chunk` carries `messageId: "system"`, and this reducer APPENDS
   * same-`messageId` chunks with NO separator, so two one-liners in one batch
   * render as a single bubble. That is why `normalize` has never emitted a pair
   * of them for one event; it is pinned HERE because the frame-level Rust test
   * inspects each frame alone and cannot see the weld.
   *
   * It used to be pinned with the compaction's own two lines. Issue #90 turned a
   * compaction into a tool card, so those lines are gone — and with them the
   * repeated-compaction weld they could not prevent: every compaction of a
   * session shared the `system` key, so a real database read
   * `Compacting context…Compaction finishedCompacting context…Compaction
   * finishedCompaction failed: …` as ONE bubble. The rule below still governs the
   * one-liners that remain (the retry line, the retraction line).
   */
  it("same-messageId one-liners weld, which is why a compaction no longer emits them", () => {
    const failure =
      "Context overflow: not enough older context to compact — try a larger-context model.";
    const systemLine = (text: string): AcpSessionUpdate => ({
      sessionUpdate: "agent_message_chunk",
      messageId: "system",
      content: { type: "text", text },
    });

    // The hazard, spelled out on the one-liners that DO still ship (the retry
    // line and a result line share the `system` key): two of them in ONE batch
    // weld into one bubble. This is the shape `normalize` must never emit.
    const welded = applySessionUpdate(
      applySessionUpdate([], systemLine("Retrying (attempt 1/3…)"), 1),
      systemLine(`Compaction failed: ${failure}`),
      1,
    );
    expect(welded).toHaveLength(1);
    expect((welded[0] as Extract<Message, { kind: "agent-text" }>).text).toContain(
      "…)Compaction failed",
    );

    // And the reason the compaction stopped taking part in it: its frames are a
    // card, so a failed compaction lands as ONE tool-call message and never
    // touches the `system` key at all.
    useSessions.getState().applySessionUpdates([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t:compact:1",
          title: "compaction",
          status: "in_progress",
          rawInput: { reason: "overflow" },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t:compact:1",
          status: "failed",
          rawOutput: { content: [{ type: "text", text: failure }], details: { error: failure } },
        },
      },
      { sessionId: "s1", update: settled("overflow") },
    ]);
    const messages = useSessions.getState().messages["s1"] ?? [];
    const cards = messages.filter(
      (m): m is Extract<Message, { kind: "tool-call" }> => m.kind === "tool-call",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].status).toBe("failed");
    expect(cards[0].title).toBe("compaction");
    // The failure text survives on the card's output (what the expanded body shows).
    expect(JSON.stringify(cards[0].rawOutput)).toContain(failure);
    // No agent-text bubble was created, and the state frame added nothing.
    expect(messages).toHaveLength(1);
  });

  it("markStalled clears it (a stalled session can no longer end its own compaction)", () => {
    useSessions
      .getState()
      .applySessionUpdates([{ sessionId: "s1", update: active("manual") }]);
    useSessions.getState().markStalled("s1", 123, null);
    expect(useSessions.getState().compacting["s1"]).toBeUndefined();
  });

  it("an active frame that was still in flight when the Worker crashed does NOT re-lock it", () => {
    // The race: `App.tsx` coalesces `session-update` frames into ONE store
    // write per animation frame, while the `session-stalled` event is applied
    // immediately. So a frame that arrived BEFORE the crash is applied AFTER
    // `markStalled` cleared the entry — and with a dead Worker there is no
    // closing frame coming, so the indicator spins on and the composer stays
    // locked on a session that can never compact again. An ACTIVE frame for a
    // stalled session is therefore stale by construction.
    useSessions.getState().markStalled("s1", 123, "boom");
    useSessions
      .getState()
      .applySessionUpdates([{ sessionId: "s1", update: active("manual") }]);
    expect(useSessions.getState().compacting["s1"]).toBeUndefined();
    // The single-frame form takes the same rule (every frame reaches the
    // frontend through one of the two).
    useSessions.getState().applySessionUpdate("s1", active("manual"));
    expect(useSessions.getState().compacting["s1"]).toBeUndefined();
    // Clearing is never harmful, so an INACTIVE frame is still applied.
    useSessions
      .getState()
      .applySessionUpdates([{ sessionId: "s1", update: settled("manual") }]);
    expect(useSessions.getState().compacting["s1"]).toBeUndefined();
    // A RESUMED session (the stall cleared) compacts normally again — the guard
    // is about the crash, not about the reason.
    useSessions.setState({ stalled: { s1: undefined } });
    useSessions
      .getState()
      .applySessionUpdates([{ sessionId: "s1", update: active("manual") }]);
    expect(useSessions.getState().compacting["s1"]).toBe("manual");
  });

  it("handleSessionClosed clears it, but KEEPS the context usage (unchanged invariant)", () => {
    useSessions.getState().applySessionUpdates([
      { sessionId: "s1", update: active("manual") },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "context_usage_update",
          usedTokens: 12000,
          windowTokens: 128000,
        },
      },
    ]);
    useSessions.getState().handleSessionClosed("s1", "user");
    expect(useSessions.getState().compacting["s1"]).toBeUndefined();
    expect(useSessions.getState().contextUsage["s1"]).toEqual({
      used: 12000,
      window: 128000,
    });
  });
});

describe("addSystemLine (a Client-local line in the transcript, ADR 0044)", () => {
  beforeEach(() => {
    useSessions.setState({ messages: { s1: [] }, inTurn: {} });
  });
  // The store is a module singleton and this file has NO global reset, so a
  // block that leaves rows behind would leak them into whichever describe
  // follows (the next one counts messages from zero). Clean up after.
  afterEach(() => {
    useSessions.setState({ messages: {}, inTurn: {} });
  });

  it("appends ONE agent-text message carrying the text", () => {
    useSessions.getState().addSystemLine("s1", "Nothing to compact — this session is not open.");
    const messages = useSessions.getState().messages["s1"];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "agent-text",
      text: "Nothing to compact — this session is not open.",
    });
  });

  it("gives the line a Client-owned messageId, never the harness's `system` key", () => {
    useSessions.getState().addSystemLine("s1", "one");
    const [msg] = useSessions.getState().messages["s1"];
    expect(msg?.kind).toBe("agent-text");
    // `case "agent_message_chunk"` APPENDS to a trailing agent-text that carries
    // the SAME `messageId`, with NO separator. Reusing the harness's `"system"`
    // id would therefore weld two Client lines — or a Client line onto a real
    // harness system message — into one run-on bubble.
    expect(msg?.kind === "agent-text" ? msg.messageId : "").toMatch(/^client:/);
    expect(msg?.kind === "agent-text" ? msg.messageId : "").not.toBe("system");
  });

  it("two calls are TWO bubbles with DIFFERENT messageIds (no welding)", () => {
    useSessions.getState().addSystemLine("s1", "first");
    useSessions.getState().addSystemLine("s1", "second");
    const messages = useSessions.getState().messages["s1"];
    expect(messages).toHaveLength(2);
    const ids = messages.map((m) => (m.kind === "agent-text" ? m.messageId : ""));
    expect(ids[0]).not.toBe(ids[1]);
    expect(messages.map((m) => (m.kind === "agent-text" ? m.text : ""))).toEqual([
      "first",
      "second",
    ]);
  });

  it("does not weld onto a trailing agent-text the harness itself emitted", () => {
    useSessions
      .getState()
      .applySessionUpdate("s1", chunk("m1", "the agent's own answer"));
    useSessions.getState().addSystemLine("s1", "a client line");
    const messages = useSessions.getState().messages["s1"];
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ kind: "agent-text", text: "a client line" });
  });

  it("adds no user message and starts no turn (a command is not a prompt)", () => {
    useSessions.getState().addSystemLine("s1", "a client line");
    expect(
      useSessions.getState().messages["s1"].some((m) => m.kind === "user"),
    ).toBe(false);
    expect(useSessions.getState().inTurn["s1"]).toBeUndefined();
  });
});

describe("a **Flush** interleaving a streaming answer (the prompt-queue race)", () => {
  const chunk = (messageId: string, text: string): AcpSessionUpdate =>
    ({
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text },
    }) as AcpSessionUpdate;

  // `useSessions` is a module singleton and this file has no global reset, so
  // the block cleans up AFTER itself as well as before: leaving `s1` populated
  // here leaks into the attachment tests below (each pins `messages.s1` length
  // as its own first assertion).
  const isolated = () => useSessions.setState({ messages: {}, inTurn: {} });
  beforeEach(isolated);
  afterEach(isolated);

  it("keeps the answer in ONE band when the queue's user row lands mid-stream", () => {
    // The exact sequence the queue produces: turn 1 is settling, its last chunk
    // is still in flight, and the settle edge fires a **Flush**, whose
    // `addUserMessage` lands BEFORE that chunk is applied.
    useSessions.setState({ messages: { s1: [] } });
    const s = () => useSessions.getState();
    s().applySessionUpdate("s1", chunk("m1", "Point me at the real thing — "));
    s().beginTurn("s1");
    s().turnCompleted("s1", "end_turn");
    // the **Flush**'s user row:
    s().addUserMessage("s1", "dogs!!!!");
    // …then the tail of the answer that just settled arrives:
    s().applySessionUpdate("s1", chunk("m1", "a file, or the ADR for the film"));

    const rows = s().messages["s1"];
    // ONE agent band, not two. The second one wore `bg-composer` and read as a
    // prompt the user never typed.
    expect(rows.map((m) => m.kind)).toEqual(["agent-text", "user"]);
    expect(rows[0]).toMatchObject({ kind: "agent-text", messageId: "m1" });
    expect((rows[0] as { text: string }).text).toBe(
      "Point me at the real thing — a file, or the ADR for the film",
    );
    // The user's own prompt keeps its place — the transcript never reorders a
    // prompt backwards to accommodate a late chunk.
    expect(rows[1]).toMatchObject({ kind: "user", text: "dogs!!!!" });
  });
});

describe("user message with image attachments", () => {
  it("(a) stores a user message with image attachments", () => {
    useSessions.getState().addUserMessage("s1", "hi", [{ name: "a.png", mimeType: "image/png", sizeBytes: 3, data: "QUJD" }]);
    const messages = useSessions.getState().messages["s1"];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "user",
      text: "hi",
      images: [{ name: "a.png", mimeType: "image/png", sizeBytes: 3, data: "QUJD" }],
    });
  });

  it("(b) stores a user message without images without the key", () => {
    // Reset messages for this test
    useSessions.setState({ messages: { s1: [] } });
    useSessions.getState().addUserMessage("s1", "hi");
    const messages = useSessions.getState().messages["s1"];
    expect(messages).toHaveLength(1);
    expect("images" in messages[0]).toBe(false);
  });

  it("(b2) omits the images key when an empty array is passed", () => {
    useSessions.setState({ messages: { s1: [] } });
    useSessions.getState().addUserMessage("s1", "hi", []);
    const messages = useSessions.getState().messages["s1"];
    expect(messages).toHaveLength(1);
    expect("images" in messages[0]).toBe(false);
  });

  it("(c) hydrates a user row with image attachments (round-trip)", () => {
    const payload = JSON.stringify({
      text: "old",
      images: [{ name: "a.png", mimeType: "image/png", sizeBytes: 3, data: "QUJD" }],
    });
    const [msg] = rowToMessages(msgRow({ kind: "user", payloadJson: payload }));
    expect(msg).toMatchObject({
      kind: "user",
      text: "old",
      images: [{ name: "a.png", mimeType: "image/png", sizeBytes: 3, data: "QUJD" }],
    });
  });

  it("(d) hydrates a user row without images", () => {
    const payload = JSON.stringify({ text: "old" });
    const [msg] = rowToMessages(msgRow({ kind: "user", payloadJson: payload }));
    expect(msg).toMatchObject({ kind: "user", text: "old" });
    expect("images" in msg).toBe(false);
  });

  it("(e) drops malformed image entries during hydration", () => {
    const payload = JSON.stringify({
      text: "x",
      images: [{ data: 42 }, { name: "a.png", mimeType: "image/png", sizeBytes: 3, data: "QUJD" }],
    });
    const [msg] = rowToMessages(msgRow({ kind: "user", payloadJson: payload }));
    expect(msg).toMatchObject({
      kind: "user",
      text: "x",
      images: [{ name: "a.png", mimeType: "image/png", sizeBytes: 3, data: "QUJD" }],
    });
  });
});

describe("rowToMessages (history replay from the database)", () => {
  const row = (
    overrides: Partial<MessageRow> & { kind: MessageRow["kind"] },
  ): MessageRow => ({
    id: 1,
    sessionId: "s1",
    messageKey: null,
    payloadJson: "{}",
    createdAt: 1000,
    ...overrides,
  });

  it("maps a user row to a user message", () => {
    const [msg] = rowToMessages(
      row({ kind: "user", payloadJson: JSON.stringify({ text: "hi" }) }),
    );
    expect(msg).toEqual({ kind: "user", text: "hi", at: 1000 });
  });

  it("maps an agent-text row to an agent-text message with its messageId", () => {
    const [msg] = rowToMessages(
      row({
        kind: "agent-text",
        messageKey: "m1",
        payloadJson: JSON.stringify({ text: "hello world" }),
      }),
    );
    expect(msg).toEqual({
      kind: "agent-text",
      messageId: "m1",
      text: "hello world",
      at: 1000,
    });
  });

  it("maps a tool-call row to a tool-call message plus its diff messages", () => {
    const messages = rowToMessages(
      row({
        kind: "tool-call",
        messageKey: "tc1",
        payloadJson: JSON.stringify({
          toolCallId: "tc1",
          title: "edit file",
          status: "completed",
          content: [
            { type: "diff", path: "/tmp/x.txt", oldText: "a\n", newText: "b\n" },
          ],
        }),
      }),
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      kind: "tool-call",
      id: "tc1",
      title: "edit file",
      status: "completed",
    });
    const diff = messages.find((m) => m.kind === "diff");
    if (!diff || diff.kind !== "diff") throw new Error("no diff message");
    expect(diff.path).toBe("/tmp/x.txt");
    expect(diff.patch).toContain("+b");
  });

  it("maps a tool-call row's rawInput onto the message", () => {
    const [msg] = rowToMessages(
      row({
        kind: "tool-call",
        messageKey: "tc1",
        payloadJson: JSON.stringify({
          toolCallId: "tc1",
          title: "manage_todo_list",
          status: "completed",
          rawInput: { operation: "write", todoList: [{ content: "a", status: "pending" }] },
        }),
      }),
    );
    if (msg?.kind !== "tool-call") throw new Error("no tool-call message");
    expect(msg.rawInput).toEqual({
      operation: "write",
      todoList: [{ content: "a", status: "pending" }],
    });
  });

  it("maps a tool-call row's rawOutput onto the message", () => {
    const [msg] = rowToMessages(
      row({
        kind: "tool-call",
        messageKey: "tc1",
        payloadJson: JSON.stringify({
          toolCallId: "tc1",
          title: "bash",
          status: "completed",
          rawOutput: { content: [{ type: "text", text: "done" }] },
        }),
      }),
    );
    if (msg?.kind !== "tool-call") throw new Error("no tool-call message");
    expect(msg.rawOutput).toEqual({ content: [{ type: "text", text: "done" }] });
  });

  it("ignores rows with unparseable payloads or unknown kinds", () => {
    expect(
      rowToMessages(row({ kind: "user", payloadJson: "not json" })),
    ).toHaveLength(0);
    expect(rowToMessages(row({ kind: "mystery" }))).toHaveLength(0);
  });
});

describe("configOptions state", () => {
  beforeEach(() => {
    useSessions.setState({
      sessions: [],
      historySessions: [],
      activeSessionId: null,
      messages: {},
      configOptions: {},
    });
  });

  it("seeds configOptions from a started session's SessionInfo (and not when absent)", () => {
    useSessions.getState().addSession({
      sessionId: "s1",
      cwd: "/x",
      capabilities: {},
      archived: false,
      configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "gpt-4" }],
    });
    expect(useSessions.getState().configOptions.s1).toEqual([
      { id: "model", name: "Model", type: "select", currentValue: "gpt-4" },
    ]);

    useSessions.getState().addSession({
      sessionId: "s2",
      cwd: "/x",
      capabilities: {},
      archived: false,
    });
    expect("s2" in useSessions.getState().configOptions).toBe(false);
  });

  it("seeds configOptions from a resumed session's SessionInfo", async () => {
    useSessions.setState({
      historySessions: [
        { sessionId: "s1", cwd: "/x", capabilities: {}, archived: false },
      ],
    });
    await useSessions.getState().resumeSession("s1");
    expect(useSessions.getState().configOptions.s1).toEqual([
      { id: "model", name: "Model", type: "select", currentValue: "gpt-4" },
    ]);
  });

  it("replaces a session's configOptions on a config_option_update update", () => {
    useSessions.getState().applyConfigOptions("s1", [
      { id: "model", name: "Model", type: "select", currentValue: "gpt-3.5" },
    ]);
    useSessions.getState().applySessionUpdate("s1", {
      sessionUpdate: "config_option_update",
      configOptions: [
        { id: "model", name: "Model", type: "select", currentValue: "gpt-4" },
      ],
    });
    expect(useSessions.getState().configOptions.s1).toEqual([
      { id: "model", name: "Model", type: "select", currentValue: "gpt-4" },
    ]);

    // Non-config update should not change it
    useSessions.getState().applySessionUpdate("s1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    });
    expect(useSessions.getState().configOptions.s1).toEqual([
      { id: "model", name: "Model", type: "select", currentValue: "gpt-4" },
    ]);
  });

  it("replaces a session's configOptions via applyConfigOptions", () => {
    useSessions.getState().applyConfigOptions("s1", [
      { id: "model", name: "Model", type: "select", currentValue: "gpt-3.5" },
    ]);
    useSessions.getState().applyConfigOptions("s1", [
      { id: "model", name: "Model", type: "select", currentValue: "gpt-4" },
    ]);
    expect(useSessions.getState().configOptions.s1).toEqual([
      { id: "model", name: "Model", type: "select", currentValue: "gpt-4" },
    ]);
  });

  /**
   * TRAP 3 (#105): the accumulator restarts at zero, the stored row does not.
   *
   * `dismissSession` drops `useInteractive.cost[id]` on close, so a resumed
   * session's next priced frame would otherwise be THAT CALL's cost alone — the
   * figure the user saw before the reload would silently drop to a fraction of
   * itself. `resumeSession` therefore mirrors the `configOptions` seeding two
   * tests above and hands the row's `costUsd` to `seedCostFromRow`, which writes
   * the key DIRECTLY (never `applyCost`, which would add the total to itself).
   *
   * Both cases `resetStores()` first: this `describe` has no reset of its own, so
   * without it the case below would inherit whatever `cost` a previous test left
   * under `s1` and pass for the wrong reason.
   */
  it("seeds the cost accumulator from a resumed session's SessionInfo (#105)", async () => {
    resetStores();
    vi.mocked(resumeSession).mockResolvedValueOnce({
      sessionId: "s1",
      cwd: "/x",
      capabilities: {},
      archived: false,
      costUsd: 0.5,
    });
    useSessions.setState({
      historySessions: [info("s1", "/x")],
    });

    await useSessions.getState().resumeSession("s1");

    const entry = useInteractive.getState().cost["s1"] as {
      costUsd: number | null;
    };
    expect(entry.costUsd).toBe(0.5);
    // The consequence the whole seeding exists for: the next priced frame ADDS
    // to the stored figure instead of replacing it. 0.6, not 0.1 (no seed) and
    // not 1.1 (the seed routed through `applyCost`).
    useInteractive.getState().applyCost("s1", { costUsd: 0.1 });
    expect(
      (useInteractive.getState().cost["s1"] as { costUsd: number | null })
        .costUsd,
    ).toBeCloseTo(0.6, 10);
    resetStores();
  });

  it("seeds NO cost entry for a resumed session whose row never reported one (#105)", async () => {
    resetStores();
    vi.mocked(resumeSession).mockResolvedValueOnce({
      sessionId: "s1",
      cwd: "/x",
      capabilities: {},
      archived: false,
    });
    useSessions.setState({
      historySessions: [info("s1", "/x")],
    });

    await useSessions.getState().resumeSession("s1");

    // No entry at all — and that is load-bearing, not tidiness. An entry holding
    // `costUsd: null` reads as a REPORT ("live, reporting nothing") to
    // `costUsdOf`, which would then suppress a figure the row does hold.
    expect("s1" in useInteractive.getState().cost).toBe(false);
    resetStores();
  });

});

describe("applySessionUpdates (batch)", () => {
  // A local agent at xhigh thinking emits ~1000 `session-update` events/sec.
  // The listener coalesces them into one batch per frame; the batch must
  // apply them in ONE `setState` (one React render per frame, not one per
  // event) or the webview main thread stays saturated and the UI renders
  // at ~1fps.
  const thought = (text: string): AcpSessionUpdate => ({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
  });

  it("applies a burst of updates for one session in a single store update", () => {
    useSessions.getState().addSession(info("s1", "/x"));
    let notifications = 0;
    const unsub = useSessions.subscribe(() => {
      notifications += 1;
    });

    useSessions
      .getState()
      .applySessionUpdates([
        { sessionId: "s1", update: thought("a") },
        { sessionId: "s1", update: thought("b") },
        { sessionId: "s1", update: thought("c") },
      ]);
    unsub();

    expect(notifications).toBe(1);
    const messages = useSessions.getState().messages.s1;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "agent-thought",
      text: "abc",
    });
  });

  it("updates several sessions in the same single store update", () => {
    useSessions.getState().addSession(info("s1", "/x"));
    useSessions.getState().addSession(info("s2", "/y"));
    let notifications = 0;
    const unsub = useSessions.subscribe(() => {
      notifications += 1;
    });

    useSessions
      .getState()
      .applySessionUpdates([
        { sessionId: "s1", update: thought("one") },
        { sessionId: "s2", update: thought("two") },
      ]);
    unsub();

    expect(notifications).toBe(1);
    expect((useSessions.getState().messages.s1[0] as { text: string }).text).toBe("one");
    expect((useSessions.getState().messages.s2[0] as { text: string }).text).toBe("two");
  });

  it("keeps the config_option_update side effect inside a batch", () => {
    useSessions.getState().addSession(info("s1", "/x"));
    useSessions
      .getState()
      .applySessionUpdates([
        {
          sessionId: "s1",
          update: {
            sessionUpdate: "config_option_update",
            configOptions: [
              { id: "model", name: "Model", type: "select", currentValue: "m1" },
            ],
          },
        },
        { sessionId: "s1", update: thought("after") },
      ]);

    expect(useSessions.getState().configOptions.s1).toEqual([
      { id: "model", name: "Model", type: "select", currentValue: "m1" },
    ]);
    // A `config_option_update` is ignored by the reducer (no message), but
    // it still updated `configOptions` — the batch applied it in order.
    expect((useSessions.getState().messages.s1[0] as { text: string }).text).toBe("after");
  });

  it("does not notify when the batch is a no-op", () => {
    useSessions.getState().addSession(info("s1", "/x"));
    const before = useSessions.getState();
    let notifications = 0;
    const unsub = useSessions.subscribe(() => {
      notifications += 1;
    });

    // Empty chunks are dropped by the reducer (same reference returned),
    // and unknown types fall through to `default` — the batch must not
    // notify at all (same state object back, no render).
    useSessions
      .getState()
      .applySessionUpdates([
        { sessionId: "s1", update: thought("") },
        { sessionId: "s1", update: { sessionUpdate: "some_future_type" } as unknown as AcpSessionUpdate },
      ]);
    unsub();

    expect(notifications).toBe(0);
    expect(useSessions.getState()).toBe(before);
  });
});

describe("resumeSession (history reload race)", () => {
  beforeEach(() => {
    useSessions.setState({
      sessions: [],
      historySessions: [],
      activeSessionId: null,
      messages: {},
      history: {},
      configOptions: {},
    });
  });

  it("does not wipe a user message added while the history reload is in flight (merge, not overwrite)", async () => {
    useSessions.setState({
      activeSessionId: "s1",
      historySessions: [
        {
          sessionId: "s1",
          cwd: "/x",
          capabilities: { loadSession: true },
          archived: false,
        },
      ],
      messages: {
        s1: [
          { kind: "user", text: "one", at: 1 },
          { kind: "agent-text", messageId: "m1", text: "two", at: 2 },
        ],
      },
    });
    // The history reload is slow (the resume IPC spawns the agent): it is
    // still in flight when `send()` adds the user message — the race the
    // merge exists for.
    let resolveRows: (rows: MessageRow[]) => void = () => {};
    vi.mocked(loadHistory).mockImplementationOnce(
      () =>
        new Promise<HistoryPage>((r) => {
          resolveRows = (rows) => r({ rows, hasMore: false, todos: null });
        }),
    );
    // `resumeSession` resolves once the resume IPC settles — the reload is
    // fire-and-forget (NOT awaited), so it is still in flight.
    await useSessions.getState().resumeSession("s1");
    // The user message is added while the reload is in flight (the
    // `send()` flow: `await resume()` → `addUserMessage` → `sendPrompt`,
    // which is the FIRST `record_message` of the user message — the
    // reloaded rows predate it, so the fresh row is NOT in them).
    useSessions.getState().addUserMessage("s1", "three");
    // The reload settles with the persisted history.
    resolveRows([
      {
        id: 1,
        sessionId: "s1",
        kind: "user",
        messageKey: null,
        payloadJson: JSON.stringify({ text: "one" }),
        createdAt: 1,
      },
      {
        id: 2,
        sessionId: "s1",
        kind: "agent-text",
        messageKey: "m1",
        payloadJson: JSON.stringify({ text: "two" }),
        createdAt: 2,
      },
    ]);
    // Let the fire-and-forget reload's continuation run.
    await new Promise((r) => setTimeout(r, 0));
    // The reloaded history is MERGED with the locally-added message (not
    // wiped): all three are present, the added one appended after.
    const msgs = useSessions.getState().messages.s1;
    expect(msgs).toHaveLength(3);
    expect(msgs[2]).toMatchObject({ kind: "user", text: "three" });
  });

  it("does not render a resumed prompt twice when record_message commits before the history query reads (dedup)", async () => {
    useSessions.setState({
      activeSessionId: "s1",
      historySessions: [
        {
          sessionId: "s1",
          cwd: "/x",
          capabilities: { loadSession: true },
          archived: false,
        },
      ],
      messages: {
        s1: [{ kind: "user", text: "one", at: 1 }],
      },
    });
    // The history reload is slow (the resume IPC spawns the agent): it is
    // still in flight when `send()` adds the user message.
    let resolveRows: (rows: MessageRow[]) => void = () => {};
    vi.mocked(loadHistory).mockImplementationOnce(
      () =>
        new Promise<HistoryPage>((r) => {
          resolveRows = (rows) => r({ rows, hasMore: false, todos: null });
        }),
    );
    await useSessions.getState().resumeSession("s1");
    // `send()` adds the user message while the reload is in flight, then
    // `send_prompt`'s `record_message` COMMITS it BEFORE the history query
    // reads — so the reloaded rows INCLUDE the new user message (the race
    // that made the prompt render twice, attachments included). The reloaded
    // row's `createdAt` is >= the local message's creation time (`at`):
    // the DB commit happens AFTER the client-side `addUserMessage` (which
    // stamps `at = Date.now()`), so the reloaded row is the SAME message
    // committed slightly later — the timestamp rule dedups it (equal or
    // newer timestamps both dedup: the safe direction).
    useSessions.getState().addUserMessage("s1", "two", [
      { name: "shot.png", mimeType: "image/png", sizeBytes: 12, data: "AAAA" },
    ]);
    const added = useSessions.getState().messages.s1;
    const addedAt = added[added.length - 1].at;
    resolveRows([
      {
        id: 1,
        sessionId: "s1",
        kind: "user",
        messageKey: null,
        payloadJson: JSON.stringify({ text: "one" }),
        createdAt: 1,
      },
      {
        id: 2,
        sessionId: "s1",
        kind: "user",
        messageKey: null,
        payloadJson: JSON.stringify({
          text: "two",
          images: [
            { name: "shot.png", mimeType: "image/png", sizeBytes: 12, data: "AAAA" },
          ],
        }),
        createdAt: addedAt,
      },
    ]);
    // Let the fire-and-forget reload's continuation run.
    await new Promise((r) => setTimeout(r, 0));
    // The prompt appears ONCE, not twice: the locally-added copy is
    // deduped against the reloaded row (text + images match AND the
    // reloaded row's timestamp is >= the local creation time).
    const msgs = useSessions.getState().messages.s1;
    expect(msgs).toHaveLength(2);
    expect(msgs.filter((m) => m.kind === "user" && m.text === "two")).toHaveLength(1);
  });

  it("keeps a re-sent identical prompt when the matching reloaded row is OLDER (repeated prompt, not a duplicate)", async () => {
    useSessions.setState({
      activeSessionId: "s1",
      historySessions: [
        {
          sessionId: "s1",
          cwd: "/x",
          capabilities: { loadSession: true },
          archived: false,
        },
      ],
      messages: {
        s1: [{ kind: "user", text: "hi", at: 1 }],
      },
    });
    // The history reload is slow (the resume IPC spawns the agent): it is
    // still in flight when the user re-sends the SAME prompt.
    let resolveRows: (rows: MessageRow[]) => void = () => {};
    vi.mocked(loadHistory).mockImplementationOnce(
      () =>
        new Promise<HistoryPage>((r) => {
          resolveRows = (rows) => r({ rows, hasMore: false, todos: null });
        }),
    );
    await useSessions.getState().resumeSession("s1");
    // The user re-sent the identical prompt while the reload is in flight:
    // the persisted (reloaded) "hi" is the OLDER one (committed long ago,
    // `createdAt = 1`) and the new local "hi" (`at = Date.now()`) is NOT
    // in the snapshot yet. The content match is a false positive for the
    // new turn — it must NOT be deduped.
    useSessions.getState().addUserMessage("s1", "hi");
    resolveRows([
      {
        id: 1,
        sessionId: "s1",
        kind: "user",
        messageKey: null,
        payloadJson: JSON.stringify({ text: "hi" }),
        createdAt: 1,
      },
    ]);
    // Let the fire-and-forget reload's continuation run.
    await new Promise((r) => setTimeout(r, 0));
    // BOTH the older reloaded "hi" AND the new local "hi" survive: the
    // matching reloaded row's timestamp (1) is EARLIER than the new
    // message's creation time, so it is the older prompt, not a duplicate.
    const msgs = useSessions.getState().messages.s1;
    const hi = msgs.filter((m) => m.kind === "user" && m.text === "hi");
    expect(hi).toHaveLength(2);
    // The new local copy (created just now, NOT the reloaded row's `at: 1`)
    // is present.
    expect(hi.some((m) => m.at > 1)).toBe(true);
  });

  it("dedupes a resumed prompt whose text carries <agent>/<mcp> mention blocks (the merge key is byte-identical across a reload)",
    async () => {
      // The `send()` REFINEMENT: the live bubble, the persisted record, and
      // the agent's input all carry the SAME EXPANDED text, so
      // `mergeDedupeKey`'s user case (`user|<text>|<images>`) matches across
      // a resume reload EVEN for the multi-line `<agent>` / `<mcp>` blocks
      // (em dashes, curly quotes, blank lines). Any normalization on either
      // side (a trim, a `splitMentionBlocks` render-then-persist, a
      // re-join) would change the key and render the prompt TWICE.
      const agent: AgentDefinitionDto = {
        name: "scout",
        description: "Fast recon.",
        model: null,
        scope: "user",
      };
      const mcp: McpServerInfo = {
        name: "postgres",
        kind: "stdio",
        summary: "npx -y x-mcp",
      };
      // The REAL expanded shape (built by the production builder, not a
      // hand-written literal).
      const expanded = expandMentions("ping @scout and #postgres", {
        skills: [],
        agents: [agent],
        mcpServers: [mcp],
      });
      // Precondition: the fixture really is the block shape (two blocks, one
      // per new kind) — otherwise this test would degrade to the plain-text
      // case already covered above.
      expect(expanded).toContain('<agent name="scout">');
      expect(expanded).toContain('<mcp name="postgres">');

      useSessions.setState({
        activeSessionId: "s1",
        historySessions: [
          {
            sessionId: "s1",
            cwd: "/x",
            capabilities: { loadSession: true },
            archived: false,
          },
        ],
        messages: { s1: [{ kind: "user", text: "one", at: 1 }] },
      });
      let resolveRows: (rows: MessageRow[]) => void = () => {};
      vi.mocked(loadHistory).mockImplementationOnce(
        () =>
          new Promise<HistoryPage>((r) => {
            resolveRows = (rows) => r({ rows, hasMore: false, todos: null });
          }),
      );
      await useSessions.getState().resumeSession("s1");
      // The live row the send appended (the EXPANDED text — `send()` calls
      // `addUserMessage(id, expandMentions(rawText, …))`).
      useSessions.getState().addUserMessage("s1", expanded);
      const addedAt =
        useSessions.getState().messages.s1[
          useSessions.getState().messages.s1.length - 1
        ].at;
      // The persisted row `record_message` committed for the SAME message
      // (`payloadJson.text` is the sent text verbatim — the persistence path
      // stores what it is handed, no reshaping).
      resolveRows([
        {
          id: 1,
          sessionId: "s1",
          kind: "user",
          messageKey: null,
          payloadJson: JSON.stringify({ text: "one" }),
          createdAt: 1,
        },
        {
          id: 2,
          sessionId: "s1",
          kind: "user",
          messageKey: null,
          payloadJson: JSON.stringify({ text: expanded }),
          createdAt: addedAt,
        },
      ]);
      await new Promise((r) => setTimeout(r, 0));
      const msgs = useSessions.getState().messages.s1;
      // DEDUPED: the locally-added copy is dropped against the reloaded row
      // (same `mergeDedupeKey`, reloaded `createdAt` >= the local `at`), so
      // the mention-expanded prompt renders ONCE.
      expect(msgs).toHaveLength(2);
      const ping = msgs.filter(
        (m) => m.kind === "user" && m.text.startsWith("ping @scout"),
      );
      expect(ping).toHaveLength(1);
      // The surviving row is byte-identical to the expansion (the transcript
      // keeps the blocks — the split is DISPLAY-only).
      expect(ping[0]!.kind === "user" ? ping[0]!.text : null).toBe(expanded);
    });

  it("does NOT dedupe a mention prompt when the reloaded row holds the UNEXPANDED text (the key is byte-exact)",
    async () => {
      // The negative control for the test above (and the reason it is not a
      // tautology): a live row carrying the EXPANDED text and a persisted row
      // carrying the RAW `@`/`#` text are DIFFERENT keys, so both survive.
      // If the dedupe key were normalized (e.g. the blocks stripped by
      // `splitMentionBlocks` before hashing), this pair would collapse and
      // the test above would pass for the wrong reason.
      const agent: AgentDefinitionDto = {
        name: "scout",
        description: "Fast recon.",
        model: null,
        scope: "user",
      };
      const expanded = expandMentions("ping @scout", {
        skills: [],
        agents: [agent],
        mcpServers: [],
      });
      useSessions.setState({
        activeSessionId: "s1",
        historySessions: [
          {
            sessionId: "s1",
            cwd: "/x",
            capabilities: { loadSession: true },
            archived: false,
          },
        ],
        messages: { s1: [] },
      });
      let resolveRows: (rows: MessageRow[]) => void = () => {};
      vi.mocked(loadHistory).mockImplementationOnce(
        () =>
          new Promise<HistoryPage>((r) => {
            resolveRows = (rows) => r({ rows, hasMore: false, todos: null });
          }),
      );
      await useSessions.getState().resumeSession("s1");
      useSessions.getState().addUserMessage("s1", expanded);
      const addedAt =
        useSessions.getState().messages.s1[
          useSessions.getState().messages.s1.length - 1
        ].at;
      resolveRows([
        {
          id: 1,
          sessionId: "s1",
          kind: "user",
          messageKey: null,
          // The RAW draft (NOT what `send()` persisted) — a divergence the
          // dedupe must catch.
          payloadJson: JSON.stringify({ text: "ping @scout" }),
          createdAt: addedAt,
        },
      ]);
      await new Promise((r) => setTimeout(r, 0));
      const msgs = useSessions.getState().messages.s1;
      expect(msgs).toHaveLength(2);
      expect(
        msgs.filter((m) => m.kind === "user" && m.text === expanded),
      ).toHaveLength(1);
    });

  it("keeps a user message added while the reload is in flight when a retraction shrinks the transcript (ADR 0050)", async () => {
    useSessions.setState({
      activeSessionId: "s1",
      historySessions: [
        {
          sessionId: "s1",
          cwd: "/x",
          capabilities: { loadSession: true },
          archived: false,
        },
      ],
      messages: {
        s1: [
          { kind: "user", text: "one", at: 1 },
          { kind: "agent-text", messageId: "a3f9c1:m1", text: "two", at: 2 },
        ],
      },
    });
    // The history reload is slow (the resume IPC spawns the agent): it is
    // still in flight while the Retraction AND the new prompt land.
    let resolveRows: (rows: MessageRow[]) => void = () => {};
    vi.mocked(loadHistory).mockImplementationOnce(
      () =>
        new Promise<HistoryPage>((r) => {
          resolveRows = (rows) => r({ rows, hasMore: false, todos: null });
        }),
    );
    await useSessions.getState().resumeSession("s1");
    // The abandoned attempt is retracted (ADR 0048): the transcript SHRINKS
    // 2 → 1, so every index shifts LEFT.
    useSessions.getState().applySessionUpdate("s1", {
      sessionUpdate: "message_retracted",
      messageId: "a3f9c1:m1",
    });
    expect(useSessions.getState().messages.s1).toHaveLength(1);
    // And the user's next prompt arrives in the SAME window: the array is 2
    // again — the length alone says "nothing happened", which is exactly the
    // blind spot of `slice(prior.length)`.
    useSessions.getState().addUserMessage("s1", "three");
    expect(useSessions.getState().messages.s1).toHaveLength(2);
    // The reload settles with ONLY the persisted user row (the retracted
    // reply was never persisted, and the new prompt postdates the query).
    resolveRows([
      {
        id: 1,
        sessionId: "s1",
        kind: "user",
        messageKey: null,
        payloadJson: JSON.stringify({ text: "one" }),
        createdAt: 1,
      },
    ]);
    // Let the fire-and-forget reload's continuation run.
    await new Promise((r) => setTimeout(r, 0));
    // The prompt SURVIVES: the merge selects its additions by identity, so a
    // shrink-then-grow across the await cannot hide the new message (ADR 0050).
    expect(
      useSessions
        .getState()
        .messages.s1.some((m) => m.kind === "user" && m.text === "three"),
    ).toBe(true);
  });

  it("counts an added message that is identical to one already in the snapshot (identity is a COUNTED multiset, not a Set)", async () => {
    useSessions.setState({
      activeSessionId: "s1",
      historySessions: [
        {
          sessionId: "s1",
          cwd: "/x",
          capabilities: { loadSession: true },
          archived: false,
        },
      ],
      messages: {
        s1: [{ kind: "user", text: "again", at: 5 }],
      },
    });
    let resolveRows: (rows: MessageRow[]) => void = () => {};
    vi.mocked(loadHistory).mockImplementationOnce(
      () =>
        new Promise<HistoryPage>((r) => {
          resolveRows = (rows) => r({ rows, hasMore: false, todos: null });
        }),
    );
    await useSessions.getState().resumeSession("s1");
    // A SECOND `again` with the SAME content AND the same `at` — pushed
    // directly into the store so `at` is exact (a real `addUserMessage` would
    // stamp `Date.now()`). Identity (`mergeDedupeKey` + `at`) cannot tell the
    // two apart, so it is COUNTED: the snapshot has one, the second occurrence
    // is the new one. A Set-based identity would treat it as "already in the
    // snapshot" and drop it (verified: degrading the count to a Set reddens
    // THIS test and only this test).
    useSessions.setState((s) => ({
      messages: {
        ...s.messages,
        s1: [...s.messages.s1!, { kind: "user", text: "again", at: 5 }],
      },
    }));
    // The persisted `again` is STRICTLY OLDER (`createdAt: 4`, NOT 5) on
    // purpose: this test is about the IDENTITY selection, and the second gate
    // — the dedupe against the reloaded rows, which is NOT what is under test
    // and is unchanged by ADR 0050 — dedupes a `user` message whenever the
    // matching reloaded row is newer-OR-EQUAL (`reloadedAt < m.at` keeps it).
    // At `createdAt: 5` that gate would legitimately collapse the pair to one
    // and this assertion would say nothing about counting.
    resolveRows([
      {
        id: 1,
        sessionId: "s1",
        kind: "user",
        messageKey: null,
        payloadJson: JSON.stringify({ text: "again" }),
        createdAt: 4,
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    // BOTH `again` messages survive: the reloaded older one, and the one the
    // counted identity selected out of the window.
    const again = useSessions
      .getState()
      .messages.s1.filter((m) => m.kind === "user" && m.text === "again");
    expect(again).toHaveLength(2);
  });

  it("merges to exactly the reloaded rows when nothing landed during the load (the O(1) fast path)", async () => {
    // The fast path: `current === prior` proves nothing arrived in the window,
    // so NO addition is selected and `mergeDedupeKey` is never called. That
    // matters because its `user` case concatenates every attachment's full
    // base64 `data` — running it over the WHOLE live snapshot of an
    // attachment-heavy session on every resume allocates a copy of every
    // attachment to conclude nothing changed.
    //
    // Reference equality is a sound change-detector here because every write
    // path that adds or removes a message builds a NEW array (the reducer's
    // arms spread, `addUserMessage` spreads, `finalizeSessionMessages` maps,
    // and the batch reducer stores only what the pure reducer returned) —
    // nothing pushes or pops in place. The no-match Retraction below pins that
    // premise at its source: a store write that changes nothing leaves the
    // SAME array, so it must not trip the fast path.
    //
    // What is pinned: the fast path selects NOTHING. The snapshot holds a live
    // thought (`a3f9c1:m1`) whose persisted key is `a3f9c1:m1#1`, so content
    // can never dedupe it — a fast path that handed back the whole snapshot
    // instead of `[]` would re-append it as a FOURTH message (verified by
    // mutation: `current === prior ? current : …` reddens HERE and only here).
    useSessions.setState({
      activeSessionId: "s1",
      historySessions: [
        {
          sessionId: "s1",
          cwd: "/x",
          capabilities: { loadSession: true },
          archived: false,
        },
      ],
      messages: {
        s1: [
          { kind: "user", text: "one", at: 1 },
          { kind: "agent-text", messageId: "a3f9c1:m1", text: "two", at: 2 },
          { kind: "agent-thought", messageId: "a3f9c1:m1", text: "think", at: 2 },
        ],
      },
    });
    let resolveRows: (rows: MessageRow[]) => void = () => {};
    vi.mocked(loadHistory).mockImplementationOnce(
      () =>
        new Promise<HistoryPage>((r) => {
          resolveRows = (rows) => r({ rows, hasMore: false, todos: null });
        }),
    );
    await useSessions.getState().resumeSession("s1");
    const snapshot = useSessions.getState().messages.s1;
    // Silence in the window: a Retraction that matches nothing changes neither
    // the content NOR the array reference.
    useSessions.getState().applySessionUpdate("s1", {
      sessionUpdate: "message_retracted",
      messageId: "deadbe:m9",
    });
    expect(useSessions.getState().messages.s1).toBe(snapshot);
    // The reload settles with the persisted rows for exactly that transcript —
    // the thought row carries the `#1` segment suffix the live row never had.
    resolveRows([
      {
        id: 1,
        sessionId: "s1",
        kind: "user",
        messageKey: null,
        payloadJson: JSON.stringify({ text: "one" }),
        createdAt: 1,
      },
      {
        id: 2,
        sessionId: "s1",
        kind: "agent-text",
        messageKey: "a3f9c1:m1",
        payloadJson: JSON.stringify({ text: "two" }),
        createdAt: 2,
      },
      {
        id: 3,
        sessionId: "s1",
        kind: "agent-thought",
        messageKey: "a3f9c1:m1#1",
        payloadJson: JSON.stringify({ text: "think" }),
        createdAt: 2,
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    // The transcript is the reloaded rows and nothing else — unchanged in
    // content, no snapshot message re-appended behind them.
    expect(useSessions.getState().messages.s1).toEqual([
      { kind: "user", text: "one", at: 1 },
      { kind: "agent-text", messageId: "a3f9c1:m1", text: "two", at: 2 },
      { kind: "agent-thought", messageId: "a3f9c1:m1#1", text: "think", at: 2 },
    ]);
  });

  it("duplicates a tool card when a session close finalizes it inside the load window (the third mutator ADR 0050 accepts)", async () => {
    // The third mutator of the load window (ADR 0050's second consequence):
    // `handleSessionClosed` runs `finalizeSessionMessages`, which maps every
    // still-`pending` tool call to `failed`. Resume and then Pause/Close
    // before `loadHistory` resolves, and that card's `mergeDedupeKey`
    // (`tool-call|<id>|<title>|<status>` — content-inclusive, so `status` IS
    // part of the identity) changes in the window: the card is no longer "in
    // the snapshot", it re-enters `added`, and the `reloadedKeys` gate cannot
    // catch it either, because the persisted row still carries the status the
    // WORKER last wrote (`pending` — the close is a frontend-only map, it
    // never reaches the display store). So the same tool call lands TWICE.
    //
    // This is ADR 0050's decision APPLIED, not a defect to fix here: where
    // identity cannot decide the merge KEEPS the message, because duplication
    // beats loss. Verified before being pinned — the transcript below is what
    // the merge actually produced (both cards present, one `pending` from the
    // reloaded row and one `failed` from the finalized live copy; nothing
    // dropped). The positional rule this branch replaced could not produce it
    // — `slice(prior.length)` never re-selected a message that was already in
    // the snapshot — so pinning it here is what stops a later "fix" dropping
    // the finalized card instead.
    useSessions.setState({
      activeSessionId: "s1",
      sessions: [
        {
          sessionId: "s1",
          cwd: "/x",
          capabilities: { loadSession: true },
          archived: false,
        },
      ],
      messages: {
        s1: [
          { kind: "user", text: "one", at: 1 },
          { kind: "agent-text", messageId: "a3f9c1:m1", text: "two", at: 2 },
          {
            kind: "tool-call",
            id: "t1",
            title: "Read file",
            status: "pending",
            at: 2,
          },
        ],
      },
    });
    let resolveRows: (rows: MessageRow[]) => void = () => {};
    vi.mocked(loadHistory).mockImplementationOnce(
      () =>
        new Promise<HistoryPage>((r) => {
          resolveRows = (rows) => r({ rows, hasMore: false, todos: null });
        }),
    );
    await useSessions.getState().resumeSession("s1");
    // Pause/Close INSIDE the window: the pending card becomes a failed one.
    useSessions.getState().handleSessionClosed("s1", "user");
    // The reload settles with the persisted rows — the tool-call row still
    // reads `pending`, because nothing about a frontend close is persisted.
    resolveRows([
      {
        id: 1,
        sessionId: "s1",
        kind: "user",
        messageKey: null,
        payloadJson: JSON.stringify({ text: "one" }),
        createdAt: 1,
      },
      {
        id: 2,
        sessionId: "s1",
        kind: "agent-text",
        messageKey: "a3f9c1:m1",
        payloadJson: JSON.stringify({ text: "two" }),
        createdAt: 2,
      },
      {
        id: 3,
        sessionId: "s1",
        kind: "tool-call",
        messageKey: "t1",
        payloadJson: JSON.stringify({
          toolCallId: "t1",
          title: "Read file",
          status: "pending",
        }),
        createdAt: 2,
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    // TWO cards for one tool call: the reloaded row first, the finalized live
    // copy appended after. Nothing else changed, and nothing was lost.
    expect(useSessions.getState().messages.s1).toEqual([
      { kind: "user", text: "one", at: 1 },
      { kind: "agent-text", messageId: "a3f9c1:m1", text: "two", at: 2 },
      { kind: "tool-call", id: "t1", title: "Read file", status: "pending", at: 2 },
      { kind: "tool-call", id: "t1", title: "Read file", status: "failed", at: 2 },
    ]);
  });

  it("keeps a tool call that ARRIVES in the window exactly once when the close finalizes it (the duplicate needs a lagging row, not the close alone)", async () => {
    // The control for the test above: `finalizeSessionMessages` on its own
    // duplicates nothing. A tool call whose `tool_call` frame arrives DURING
    // the window has no persisted row at all (the query read before it), so
    // there is no reloaded key to mismatch — it is kept once, as the finalized
    // (`failed`) card. The duplicate above is therefore the status change
    // against a row that LAGS it, not a close inside the window per se.
    useSessions.setState({
      activeSessionId: "s1",
      sessions: [
        {
          sessionId: "s1",
          cwd: "/x",
          capabilities: { loadSession: true },
          archived: false,
        },
      ],
      messages: { s1: [{ kind: "user", text: "one", at: 1 }] },
    });
    let resolveRows: (rows: MessageRow[]) => void = () => {};
    vi.mocked(loadHistory).mockImplementationOnce(
      () =>
        new Promise<HistoryPage>((r) => {
          resolveRows = (rows) => r({ rows, hasMore: false, todos: null });
        }),
    );
    await useSessions.getState().resumeSession("s1");
    useSessions.getState().applySessionUpdate("s1", {
      sessionUpdate: "tool_call",
      toolCallId: "t9",
      title: "Run command",
      status: "pending",
    });
    useSessions.getState().handleSessionClosed("s1", "user");
    resolveRows([
      {
        id: 1,
        sessionId: "s1",
        kind: "user",
        messageKey: null,
        payloadJson: JSON.stringify({ text: "one" }),
        createdAt: 1,
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    const msgs = useSessions.getState().messages.s1;
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({
      kind: "tool-call",
      id: "t9",
      status: "failed",
    });
  });
});

describe("archivedSessions (sticky, ADR 0016)", () => {
  beforeEach(() => {
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      activeSessionId: null,
      closeReasons: {},
      messages: {},
      history: {},
      configOptions: {},
    });
  });

  it("setHistorySessions splits rows by the archived flag (live ids in neither list)", () => {
    useSessions.setState({
      sessions: [info("live-1", "/x")],
    });
    useSessions.getState().setHistorySessions([
      info("live-1", "/x"), // live id → excluded from BOTH lists
      { ...info("arch-1", "/x"), archived: true },
      info("hist-1", "/x"),
    ]);
    const st = useSessions.getState();
    expect(st.historySessions.map((s) => s.sessionId)).toEqual(["hist-1"]);
    expect(st.archivedSessions.map((s) => s.sessionId)).toEqual(["arch-1"]);
  });

  it("mergeRefreshedSessionRows updates contextUsage/configOptions WITHOUT re-splitting the lists (#85)", () => {
    // The boot-time lists, including a sticky live+archived pair — the exact
    // state `setHistorySessions`'s "boot-only, do NOT re-run mid-run" comment
    // forbids re-deriving. The merge must leave membership untouched.
    useSessions.setState({
      sessions: [info("live-arch", "/x")],
      historySessions: [info("hist-1", "/x")],
      archivedSessions: [
        { ...info("live-arch", "/x"), archived: true },
        { ...info("arch-1", "/x"), archived: true },
      ],
      contextUsage: {},
      configOptions: {},
    });
    // A refresh reports a corrected window for the stored session (#85).
    useSessions.getState().mergeRefreshedSessionRows([
      {
        ...info("hist-1", "/x"),
        contextUsage: { used: 53_760, window: 1_000_000 },
      },
      {
        ...info("arch-1", "/x"),
        archived: true,
        contextUsage: { used: 1_000, window: 640_000 },
      },
    ]);
    const st = useSessions.getState();
    // The VALUES arrive.
    expect(st.contextUsage["hist-1"]).toEqual({
      used: 53_760,
      window: 1_000_000,
    });
    expect(st.contextUsage["arch-1"]).toEqual({ used: 1_000, window: 640_000 });
    // Membership is UNTOUCHED — no row moved lists, no sticky entry dropped.
    expect(st.sessions.map((s) => s.sessionId)).toEqual(["live-arch"]);
    expect(st.historySessions.map((s) => s.sessionId)).toEqual(["hist-1"]);
    expect(st.archivedSessions.map((s) => s.sessionId)).toEqual([
      "live-arch",
      "arch-1",
    ]);
  });

  it("mergeRefreshedSessionRows leaves a session that a live frame already updated alone (#85)", () => {
    // The live frame is FRESHER than the `list_sessions` read the refresh ran
    // alongside: the store's map wins over the row (the `contextUsageOf`
    // precedence), so the merge must not clobber a live session's number with a
    // possibly-earlier snapshot.
    useSessions.setState({
      sessions: [info("live-1", "/x")],
      historySessions: [],
      archivedSessions: [],
      contextUsage: { "live-1": { used: 9_000, window: 1_000_000 } },
      configOptions: {},
    });
    useSessions.getState().mergeRefreshedSessionRows([
      {
        ...info("live-1", "/x"),
        contextUsage: { used: 8_000, window: 1_000_000 },
      },
    ]);
    expect(useSessions.getState().contextUsage["live-1"]).toEqual({
      used: 9_000,
      window: 1_000_000,
    });
  });

  it("archiveSession moves the entry historySessions → archivedSessions and calls the backend", async () => {
    useSessions.setState({
      historySessions: [info("h1", "/x")],
    });
    await useSessions.getState().archiveSession("h1");
    expect(vi.mocked(setSessionArchived)).toHaveBeenCalledWith("h1", true);
    const st = useSessions.getState();
    expect(st.historySessions).toEqual([]);
    expect(st.archivedSessions).toEqual([info("h1", "/x")]);
  });

  it("archiveSession is a no-op for an unknown id (does not call the backend)", async () => {
    useSessions.setState({ historySessions: [] });
    await useSessions.getState().archiveSession("missing");
    expect(vi.mocked(setSessionArchived)).not.toHaveBeenCalled();
    // And nothing is closed either: an id in NONE of the three lists is not a
    // Session this app run knows anything about, so Stop/Archive may not ask
    // the backend to tear one down.
    expect(vi.mocked(closeSession)).not.toHaveBeenCalled();
  });

  it("archiveSession on a LIVE session sets the flag, moves the row, and closes it — in that order", async () => {
    // The sidebar offers Archive on a live row too (a live Session is not
    // "put away" while its Worker runs, so Archive has to stop it). The id is
    // in `sessions` ONLY — the pre-change guard read `historySessions` and
    // returned early, so nothing reached the backend at all.
    useSessions.setState({ sessions: [info("s1", "/x")] });
    await useSessions.getState().archiveSession("s1");
    expect(vi.mocked(setSessionArchived)).toHaveBeenCalledWith("s1", true);
    expect(vi.mocked(closeSession)).toHaveBeenCalledWith("s1");
    const st = useSessions.getState();
    expect(st.archivedSessions.map((s) => s.sessionId)).toContain("s1");
    // Archive does not itself detach the Session: dropping the row out of the
    // live group is `handleSessionClosed`'s job, when `session-closed` lands.
    expect(st.sessions.map((s) => s.sessionId)).toContain("s1");
    // THE ORDER IS THE DESIGN, not an accident of `await` placement: the flag
    // is committed and the lists moved FIRST, so the closing event is caught by
    // `handleSessionClosed`'s sticky guard. Close-first would race the async
    // event against the store move and flicker the row through the Space group.
    expect(
      vi.mocked(setSessionArchived).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(closeSession).mock.invocationCallOrder[0]);
    // The second half of that proof: replay the event the close will produce
    // and the sticky guard must land the row in `archivedSessions` ALONE — the
    // pair of assertions below is what makes the ordering load-bearing rather
    // than decorative (a close that beat the move would file it under
    // `historySessions`, i.e. an un-archived-looking row).
    useSessions.getState().handleSessionClosed("s1", "user");
    const after = useSessions.getState();
    expect(after.historySessions.map((s) => s.sessionId)).not.toContain("s1");
    expect(after.archivedSessions.map((s) => s.sessionId)).toContain("s1");
  });

  it("a failed close still leaves the session archived", async () => {
    // The flag is Archive's ONE durable job (it hides the row from the next
    // boot); a `close_session` that rejects — a mid-await delete answers
    // `UnknownSession` — must not undo it and must not surface as a failed
    // Archive. Best-effort like `closeSpace`: log, do not throw, do not roll
    // back.
    useSessions.setState({ sessions: [info("s1", "/x")] });
    vi.mocked(closeSession).mockRejectedValueOnce(new Error("gone"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // `expect(...).resolves` would need the promise in hand; awaiting a call
    // that rejects throws, so the assertion IS the await not throwing.
    await expect(
      useSessions.getState().archiveSession("s1"),
    ).resolves.toBeUndefined();
    expect(vi.mocked(setSessionArchived)).toHaveBeenCalledWith("s1", true);
    expect(
      useSessions.getState().archivedSessions.map((s) => s.sessionId),
    ).toContain("s1");
    expect(spy).toHaveBeenCalled();
    // This file has no file-scope `mockRestore` (unlike `SpacesList.test.tsx`),
    // so the spy goes away here or it swallows the next test's real errors.
    spy.mockRestore();
  });

  it("unarchiveSession is the mirror", async () => {
    useSessions.setState({
      archivedSessions: [info("h1", "/x")],
    });
    await useSessions.getState().unarchiveSession("h1");
    expect(vi.mocked(setSessionArchived)).toHaveBeenCalledWith("h1", false);
    const st = useSessions.getState();
    expect(st.archivedSessions).toEqual([]);
    expect(st.historySessions).toEqual([info("h1", "/x")]);
  });

  it("archiveSession is idempotent under concurrent invocation (double-click)", async () => {
    // Two invocations both pass the pre-await membership check; the move
    // must still land the id in `archivedSessions` EXACTLY ONCE.
    useSessions.setState({
      historySessions: [info("h1", "/x")],
    });
    const p1 = useSessions.getState().archiveSession("h1");
    const p2 = useSessions.getState().archiveSession("h1");
    await Promise.all([p1, p2]);
    const st = useSessions.getState();
    expect(st.historySessions.map((s) => s.sessionId)).not.toContain("h1");
    expect(
      st.archivedSessions.map((s) => s.sessionId).filter((id) => id === "h1"),
    ).toHaveLength(1);
  });

  it("unarchiveSession is idempotent under concurrent invocation (double-click)", async () => {
    useSessions.setState({
      archivedSessions: [info("h1", "/x")],
    });
    const p1 = useSessions.getState().unarchiveSession("h1");
    const p2 = useSessions.getState().unarchiveSession("h1");
    await Promise.all([p1, p2]);
    const st = useSessions.getState();
    expect(st.archivedSessions.map((s) => s.sessionId)).not.toContain("h1");
    expect(
      st.historySessions.map((s) => s.sessionId).filter((id) => id === "h1"),
    ).toHaveLength(1);
  });

  it("a delete that completes mid-archive-await leaves no ghost row", async () => {
    useSessions.setState({
      historySessions: [info("h1", "/x")],
    });
    // Manual deferred resolution: the delete's `set` must land BEFORE the
    // archive's `set`. With plain `mockResolvedValue` the mock resolves in
    // call order (archive first — it called the backend first), which would
    // let the delete clear the row and hide the bug.
    let resolveArchived: (v: boolean) => void = () => {};
    vi.mocked(setSessionArchived).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveArchived = resolve;
        }),
    );
    const pArchive = useSessions.getState().archiveSession("h1");
    const pDelete = useSessions.getState().deleteSession("h1");
    await pDelete; // delete's `set` clears both lists first
    resolveArchived(true);
    await pArchive; // archive's `set` must re-check and no-op
    const st = useSessions.getState();
    expect(st.historySessions.map((s) => s.sessionId)).not.toContain("h1");
    expect(st.archivedSessions.map((s) => s.sessionId)).not.toContain("h1");
  });

  it("an archive that lands after a resume of the same session keeps client and DB in agreement (sticky live)", async () => {
    // The mocked `resumeSession` resolves to a FIXED `SessionInfo` with
    // `sessionId: "s1"` — seed the history list with that id.
    useSessions.setState({
      historySessions: [info("s1", "/x")],
    });
    // Manual deferred resolution: the resume's `set` must land BEFORE the
    // archive's `set` (the row's Archive hover button stays clickable
    // until the resume's `set` lands). With plain `mockResolvedValue`
    // the archive's backend resolves first (it was called first) and the
    // race would not be exercised.
    let resolveArchived: (v: boolean) => void = () => {};
    vi.mocked(setSessionArchived).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveArchived = resolve;
        }),
    );
    const pArchive = useSessions.getState().archiveSession("s1");
    const pResume = useSessions.getState().resumeSession("s1");
    await pResume; // resume's `set` removes the id from `historySessions`,
                   // adds it to `sessions`, leaves it OUT of
                   // `archivedSessions` (the pre-sticky state)
    resolveArchived(true);
    await pArchive; // the DB flag is now `true` — the client must land
                    // the id in `archivedSessions` (sticky live), not no-op
    const st = useSessions.getState();
    expect(st.sessions.map((s) => s.sessionId)).toContain("s1");
    expect(st.archivedSessions.map((s) => s.sessionId)).toContain("s1");
    expect(st.historySessions.map((s) => s.sessionId)).not.toContain("s1");
    // The pin for capturing `wasLive` BEFORE the await: the id was STORED at
    // click time and only became live when the resume won the mid-await race,
    // so Archive must NOT close it. Re-reading liveness after the `set` would
    // close a Session nobody clicked Archive on — and nothing else in this suite
    // can tell the two reads apart.
    expect(vi.mocked(closeSession)).not.toHaveBeenCalled();
  });

  it("an unarchive that lands after a resume of the same session does not duplicate the live id into historySessions", async () => {
    useSessions.setState({
      archivedSessions: [info("s1", "/x")],
    });
    // Manual deferred resolution: the resume's `set` must land BEFORE the
    // unarchive's `set` (see the archive race above).
    let resolveArchived: (v: boolean) => void = () => {};
    vi.mocked(setSessionArchived).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveArchived = resolve;
        }),
    );
    const pUnarchive = useSessions.getState().unarchiveSession("s1");
    const pResume = useSessions.getState().resumeSession("s1");
    await pResume; // the id is now live: in `sessions` AND (sticky)
                   // `archivedSessions`
    resolveArchived(false);
    await pUnarchive; // must remove it from `archivedSessions` but NOT
                      // append it to `historySessions` (the close handler
                      // lands it there on close)
    const st = useSessions.getState();
    expect(st.sessions.map((s) => s.sessionId)).toContain("s1");
    expect(st.archivedSessions.map((s) => s.sessionId)).not.toContain("s1");
    expect(st.historySessions.map((s) => s.sessionId)).not.toContain("s1");
  });

  it("resumeSession finds an archived session and keeps it sticky (in BOTH live and archived)", async () => {
    // The mocked `resumeSession` (tauri) resolves to a FIXED `SessionInfo`
    // with `sessionId: "s1"` — seed the archived list with that id.
    useSessions.setState({
      archivedSessions: [info("s1", "/x")],
    });
    await useSessions.getState().resumeSession("s1");
    const st = useSessions.getState();
    expect(st.sessions.map((s) => s.sessionId)).toContain("s1");
    // STICKY: the entry stays in `archivedSessions` while the session is
    // live (the Archived view filters out live ids).
    expect(st.archivedSessions.map((s) => s.sessionId)).toContain("s1");
    expect(st.historySessions.map((s) => s.sessionId)).not.toContain("s1");
  });

  it("a resumed-then-closed archived session stays archived (NOT in historySessions)", async () => {
    useSessions.setState({
      archivedSessions: [info("s1", "/x")],
    });
    await useSessions.getState().resumeSession("s1");
    useSessions.getState().handleSessionClosed("s1", "user");
    const st = useSessions.getState();
    expect(st.archivedSessions.map((s) => s.sessionId)).toContain("s1");
    expect(st.historySessions.map((s) => s.sessionId)).not.toContain("s1");
  });

  it("deleteSession removes the id from all three lists", async () => {
    useSessions.setState({
      sessions: [info("d1", "/x")],
      historySessions: [info("d1", "/x")],
      archivedSessions: [info("d1", "/x")],
      activeSessionId: "d1",
    });
    await useSessions.getState().deleteSession("d1");
    const st = useSessions.getState();
    expect(st.sessions).toEqual([]);
    expect(st.historySessions).toEqual([]);
    expect(st.archivedSessions).toEqual([]);
    expect(st.activeSessionId).toBeNull();
  });
});

describe("spaceViewFor — archivedSessionIds (view membership only)", () => {
  it("reports archivedSessionIds without polluting sessionIds, and lastReason falls back to the most recent archived Session", () => {
    const space = row("/w/alpha", 1000);
    const live = info("live-a", "/w/alpha");
    const stored = info("stored-a", "/w/alpha");
    const archived = { ...info("arch-a", "/w/alpha"), archived: true };
    const reasons: Record<string, CloseReasonStr> = {
      "live-a": "user",
      "stored-a": "error",
      "arch-a": "agent-exited",
    };
    // An EMPTY order map: every id is unknown, every id ties, and the sequence
    // keeps this fixture's live-before-stored answer (the safety property — see
    // `mergeSessionOrder`). Membership and the banner are what this test owns.
    const view = spaceViewFor(
      space,
      [live],
      [stored],
      reasons,
      [archived],
      recencyEvidence(),
      noOrder(),
    );
    expect(view.archivedSessionIds).toEqual(["arch-a"]);
    // `sessionIds` is UNCHANGED in membership: stored + live only (the archived
    // id must NOT appear — the Space group renders stored sessions only).
    expect(view.sessionIds).toEqual(["live-a", "stored-a"]);
    // The LIVE session is the Landing Session (live is preferred over any
    // stored one, whatever the recency maps say): its reason wins.
    expect(view.lastReason).toBe("user");

    // No live session, no stored sessions: an archived row is still the last
    // resort — the close-reason banner must not silently vanish for an
    // archived-only Space.
    const archivedOnly = spaceViewFor(
      space,
      [],
      [],
      reasons,
      [archived],
      recencyEvidence(),
      noOrder(),
    );
    expect(archivedOnly.archivedSessionIds).toEqual(["arch-a"]);
    expect(archivedOnly.sessionIds).toEqual([]);
    expect(archivedOnly.lastReason).toBe("agent-exited");
  });
});

describe("lastReason (ADR 0075: the banner follows the Landing Session, not the list head)", () => {
  it("spaceViewFor reads lastReason off the max-recency stored Session, not the head", () => {
    // TWO COMPETING ANSWERS: the head of the stored subsequence is
    // `stored_first` → "error"; max recency is `stored_last` → "user". Since
    // ADR 0075 the head is merely the first row of a manual arrangement, so the
    // banner has to follow the recency answer.
    const space = row("/w/alpha", 1000);
    const reasons: Record<string, CloseReasonStr> = {
      stored_first: "error",
      stored_last: "user",
    };
    const view = spaceViewFor(
      space,
      [],
      [info("stored_first", "/w/alpha"), info("stored_last", "/w/alpha")],
      reasons,
      [],
      recencyEvidence({
        stored_first: 1_000,
        stored_last: 9_000_000_000_000,
      }),
      noOrder(),
    );
    expect(view.lastReason).toBe("user");
  });

  it("spaceViewFor falls back to the most recent ARCHIVED Session only when the Space has no stored one", () => {
    // D5: the archived arm is a LAST RESORT, not a max over stored ∪ archived.
    // THREE candidate answers for this fixture, and only one is right:
    //   - the head of the stored subsequence (the pre-ADR-0075 rule) → "error";
    //   - a max over stored ∪ archived (which the archived row's far-future
    //     stamp would win) → "agent-exited";
    //   - max recency WITHIN the stored arm, archived only if stored is empty →
    //     "user". The fixture puts the most recent stored row SECOND, so the
    //     head-of-list rule cannot answer it by accident.
    const space = row("/w/alpha", 1000);
    const reasons: Record<string, CloseReasonStr> = {
      stored_head: "error",
      stored_recent: "user",
      "arch-a": "agent-exited",
    };
    const evidence = recencyEvidence({
      stored_head: 1_000,
      stored_recent: 5_000_000_000_000,
      "arch-a": 9_000_000_000_000,
    });
    const withStored = spaceViewFor(
      space,
      [],
      [info("stored_head", "/w/alpha"), info("stored_recent", "/w/alpha")],
      reasons,
      [{ ...info("arch-a", "/w/alpha"), archived: true }],
      evidence,
      noOrder(),
    );
    expect(withStored.lastReason).toBe("user");

    // Drop BOTH stored rows and the archived arm answers — the banner survives
    // an archived-only Space.
    const archivedOnly = spaceViewFor(
      space,
      [],
      [],
      reasons,
      [{ ...info("arch-a", "/w/alpha"), archived: true }],
      evidence,
      noOrder(),
    );
    expect(archivedOnly.lastReason).toBe("agent-exited");
  });
});

describe("archivedInSpace (the Archived section sorts by recency, explicitly)", () => {
  const archivedRow = (sessionId: string, cwd: string): SessionInfo => ({
    sessionId,
    cwd,
    capabilities: {},
    archived: true,
  });

  it("archivedInSpace sorts by recency and NOT by input order", () => {
    // ADR 0075's named trap: this section used to inherit recency for free from
    // `list_sessions`. TWO COMPETING ANSWERS: input order (the manual order the
    // query now returns) is ["a_old", "a_new"]; recency order is
    // ["a_new", "a_old"]. Swapping the two recency values reddens it.
    const a_old = archivedRow("a_old", "/w/alpha");
    const a_new = archivedRow("a_new", "/w/alpha");
    const rows = archivedInSpace(
      "/w/alpha",
      [a_old, a_new],
      [],
      recencyEvidence({ a_old: 1_000, a_new: 9_000_000_000_000 }),
    );
    expect(rows.map((r) => r.sessionId)).toEqual(["a_new", "a_old"]);
    // ROWS come back, not ids (the section renders title/cwd off them).
    expect(rows[0]).toEqual(a_new);
  });

  it("archivedInSpace drops the sticky live ids and another Space's rows", () => {
    const resumed = archivedRow("resumed", "/w/alpha");
    const other = archivedRow("beta-1", "/w/beta");
    const own = archivedRow("alpha-1", "/w/alpha");
    const rows = archivedInSpace(
      "/w/alpha",
      [resumed, other, own],
      [info("resumed", "/w/alpha")],
      recencyEvidence(),
    );
    // A resumed archived Session renders in its Space group, not here; a row of
    // another Space is Detached and belongs to Settings.
    expect(rows.map((r) => r.sessionId)).toEqual(["alpha-1"]);
    // The documented empty state: no Space selected matches NOTHING (the
    // section's "No archived sessions." must not silently become "everything").
    expect(
      archivedInSpace(null, [own], [], recencyEvidence()).map((r) => r.sessionId),
    ).toEqual([]);
  });
});

describe("activeSpacePath (the selected Space — the top tabs' state)", () => {
  beforeEach(() => {
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      activeSessionId: null,
      spaces: [],
      activeSpacePath: null,
      closeReasons: {},
      messages: {},
      configOptions: {},
      // Both boot maps too: the tests below seed them, and this file resets by
      // hand-written key lists — an unnamed key leaks into the next case.
      sessionRecency: {},
      sessionOrder: {},
    });
  });

  const space = (path: string): SpaceRow => ({
    path,
    createdAt: 0,
    lastOpenedAt: 0,
    trusted: false,
  });

  it("boot (setSpaces, nothing active): the auto-selected session's space becomes active; no sessions → the most recent space", () => {
    // A stored session in /a (the input order is newest-first).
    useSessions.getState().setSpaces([space("/a"), space("/b")]);
    // No sessions at all → the leftmost Space with something to show (the
    // FIRST row — `list_spaces` returns the user's MANUAL order, `sort_order`
    // ASC then `path` ASC; ADR 0075 — position is not recency).
    expect(useSessions.getState().activeSpacePath).toBe("/a");
    expect(useSessions.getState().activeSessionId).toBeNull();

    useSessions.setState({ spaces: [], activeSpacePath: null });
    useSessions.getState().setHistorySessions([
      { ...info("h1", "/a"), archived: false },
      { ...info("h2", "/b"), archived: false },
    ]);
    useSessions.getState().setSpaces([space("/a"), space("/b")]);
    // `autoSelectActive` lands on the first space's newest session (first
    // space in manual order, newest stored session of that space by
    // `recencyOf` — ADR 0075: the space comes from position, the session from
    // explicit recency evidence, never from the space's own timestamps).
    expect(useSessions.getState().activeSessionId).toBe("h1");
    expect(useSessions.getState().activeSpacePath).toBe("/a");
  });

  it("openSession follows the session's space (live or stored)", () => {
    useSessions.setState({
      spaces: [space("/a"), space("/b")],
      activeSpacePath: "/a",
    });
    useSessions.getState().addSession(info("live-1", "/a"));
    expect(useSessions.getState().activeSpacePath).toBe("/a");
    useSessions.getState().setHistorySessions([
      { ...info("hist-1", "/b"), archived: false },
    ]);
    useSessions.getState().openSession("hist-1");
    expect(useSessions.getState().activeSessionId).toBe("hist-1");
    expect(useSessions.getState().activeSpacePath).toBe("/b");
  });

  it("openSession for a session whose cwd is NO space leaves activeSpacePath alone", () => {
    useSessions.setState({
      spaces: [space("/a")],
      activeSpacePath: "/a",
    });
    useSessions.getState().setHistorySessions([
      { ...info("legacy-1", "/not-a-space"), archived: false },
    ]);
    useSessions.getState().openSession("legacy-1");
    expect(useSessions.getState().activeSpacePath).toBe("/a");
  });

  it("selectSpace: live session preferred, then the most RECENT stored, then nothing", () => {
    useSessions.setState({
      spaces: [space("/a"), space("/b")],
      activeSpacePath: "/a",
    });
    // /b holds a live + a stored session: the live wins (a Space with a Worker
    // mid-turn shows that turn, whatever recency says).
    useSessions.getState().addSession(info("live-1", "/b"));
    useSessions.getState().setHistorySessions([
      { ...info("hist-first", "/b"), archived: false },
      { ...info("hist-1", "/b"), archived: false },
    ]);
    // The recency map favours the SECOND stored row, so "most recent" is
    // distinguishable from "first in the list" — the two rules this test used to
    // be unable to tell apart.
    useSessions.getState().setSessionRecency([
      { sessionId: "hist-first", lastActiveAt: 1_000, sortOrder: 0 },
      { sessionId: "hist-1", lastActiveAt: 9_000_000_000_000, sortOrder: 1 },
    ]);
    useSessions.getState().selectSpace("/b");
    expect(useSessions.getState().activeSpacePath).toBe("/b");
    expect(useSessions.getState().activeSessionId).toBe("live-1");

    // No live in /b: the most RECENT stored row, which is the one sitting LAST
    // in the manual order.
    useSessions.getState().handleSessionClosed("live-1", "user");
    useSessions.getState().selectSpace("/b");
    expect(useSessions.getState().activeSessionId).toBe("hist-1");

    // An empty space: no session (the chat's empty state).
    useSessions.getState().selectSpace("/a");
    expect(useSessions.getState().activeSpacePath).toBe("/a");
    expect(useSessions.getState().activeSessionId).toBeNull();
  });

  it("selectSpace is a no-op for an unknown path", () => {
    useSessions.setState({
      spaces: [space("/a")],
      activeSpacePath: "/a",
    });
    useSessions.getState().selectSpace("/nowhere");
    expect(useSessions.getState().activeSpacePath).toBe("/a");
  });

  it("the start flow (addSession + addSpace) makes the new space active", () => {
    useSessions.setState({
      spaces: [space("/a")],
      activeSpacePath: "/a",
    });
    // The start flow: `addSession` (the fresh session) + `addSpace`
    // (the space row upsert) — the new space becomes the active one.
    useSessions.getState().addSession(info("live-1", "/new"));
    useSessions.getState().addSpace("/new");
    expect(useSessions.getState().activeSessionId).toBe("live-1");
    expect(useSessions.getState().activeSpacePath).toBe("/new");
  });

  it("removing the active space falls back to the first remaining space (or null)", async () => {
    useSessions.setState({
      spaces: [space("/a"), space("/b")],
      activeSpacePath: "/a",
    });
    // `removeSpace` awaits the backend command (the mock resolves). The
    // fallback is the LEFTMOST remaining TAB (the first row of the manual
    // order, ADR 0075) — and this fixture keeps the `null`-when-nothing-remains
    // half, which is the half only this test pins.
    await useSessions.getState().removeSpace("/a");
    expect(useSessions.getState().activeSpacePath).toBe("/b");
    await useSessions.getState().removeSpace("/b");
    expect(useSessions.getState().activeSpacePath).toBeNull();
  });
});

describe("closeSpace (closing a Space TAB — the tab bar's ×)", () => {
  beforeEach(() => {
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      activeSessionId: null,
      activeSpacePath: null,
      spaces: [row("/a", 2000), row("/b", 1000)],
      closeReasons: {},
      messages: {},
      history: {},
    });
    vi.clearAllMocks();
  });

  it("forgets the Space but keeps every conversation of it", async () => {
    useSessions.setState({
      historySessions: [info("stored-1", "/a")],
      activeSpacePath: "/b",
    });
    await useSessions.getState().closeSpace("/a");
    expect(deleteSpace).toHaveBeenCalledWith("/a");
    expect(useSessions.getState().spaces.map((s) => s.path)).toEqual(["/b"]);
    // The transcript rows are NOT touched — re-opening the folder brings the
    // Space back WITH its history (`removeSpace`'s standing decision).
    expect(useSessions.getState().historySessions).toHaveLength(1);
    expect(
      useSessions.getState().historySessions[0]?.sessionId,
    ).toBe("stored-1");
  });

  it("closing the SELECTED tab lands on the next Space's session (the same rule a tab click uses)", async () => {
    useSessions.setState({
      spaces: [row("/a", 2000), row("/b", 1000)],
      activeSpacePath: "/a",
      activeSessionId: "live-a",
      sessions: [info("live-a", "/a"), info("live-b", "/b")],
    });
    await useSessions.getState().closeSpace("/a");
    const s = useSessions.getState();
    expect(s.activeSpacePath).toBe("/b");
    // NOT merely the path: the user is looking at the neighbour's conversation,
    // exactly as if they had clicked its tab.
    expect(s.activeSessionId).toBe("live-b");
    expect(loadHistory).toHaveBeenCalledWith("live-b", { limit: 500 });
  });

  it("closing a tab you are NOT looking at leaves the view alone", async () => {
    useSessions.setState({
      activeSpacePath: "/b",
      activeSessionId: "live-b",
      sessions: [info("live-b", "/b")],
    });
    await useSessions.getState().closeSpace("/a");
    const s = useSessions.getState();
    expect(s.activeSpacePath).toBe("/b");
    expect(s.activeSessionId).toBe("live-b");
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("stops the sessions it is given, then removes the Space", async () => {
    useSessions.setState({ activeSpacePath: "/b" });
    await useSessions.getState().closeSpace("/a", ["live-1", "live-2"]);
    expect(closeSession).toHaveBeenCalledWith("live-1");
    expect(closeSession).toHaveBeenCalledWith("live-2");
    expect(deleteSpace).toHaveBeenCalledWith("/a");
    expect(useSessions.getState().spaces.map((s) => s.path)).toEqual(["/b"]);
  });

  it("a FAILED stop still closes the tab (a dead Worker must not make a tab unclosable)", async () => {
    useSessions.setState({ activeSpacePath: "/b" });
    vi.mocked(closeSession).mockRejectedValueOnce(
      new Error("unknown session live-1"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    await useSessions.getState().closeSpace("/a", ["live-1", "live-2"]);
    expect(useSessions.getState().spaces.map((s) => s.path)).toEqual(["/b"]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("closing the LAST tab leaves no Space selected AND no transcript on screen", async () => {
    // The session is LIVE in the Space being closed, so the view has something
    // to keep showing if the close forgets to clear it.
    useSessions.setState({
      spaces: [row("/a", 2000)],
      activeSpacePath: "/a",
      activeSessionId: "live-a",
      sessions: [info("live-a", "/a")],
    });
    await useSessions.getState().closeSpace("/a");
    const s = useSessions.getState();
    expect(s.activeSpacePath).toBeNull();
    // There is no landing Space, so `selectSpace` cannot repaint the view —
    // the session must be dropped explicitly, or `ChatStream` keeps rendering
    // a transcript whose Space row (and therefore whose sidebar row) is gone,
    // instead of its "No active session" empty state.
    expect(s.activeSessionId).toBeNull();
  });
});

describe("stopSession (the sidebar row's Stop button)", () => {
  beforeEach(() => {
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      activeSessionId: null,
      inTurn: {},
      closeReasons: {},
      messages: {},
      history: {},
    });
    // Vitest's default `clearMocks` already wipes call history between tests,
    // but these two assertions are about "NOT called", so their truth is made
    // explicit here rather than inherited from the runner config: the
    // `closeSpace` block above calls `closeSession` on purpose, and a
    // "not called" assertion that leans on the config instead of on this
    // block is one config tweak away from passing on call history.
    vi.mocked(closeSession).mockClear();
    vi.mocked(cancelSession).mockClear();
  });

  it("a turn in flight is CANCELLED, not closed (the Session stays live)", async () => {
    useSessions.setState({
      sessions: [info("s1", "/x")],
      inTurn: { s1: true },
    });
    await useSessions.getState().stopSession("s1");
    // `cancelSession` keeps the Worker, so the Session is re-promptable at
    // once — a close would drop the row to stored for no benefit.
    expect(vi.mocked(cancelSession)).toHaveBeenCalledWith("s1");
    expect(vi.mocked(closeSession)).not.toHaveBeenCalled();
    expect(useSessions.getState().sessions.map((s) => s.sessionId)).toContain(
      "s1",
    );
  });

  it("live and idle CLOSES the Session (the Worker is reaped)", async () => {
    useSessions.setState({ sessions: [info("s1", "/x")], inTurn: {} });
    await useSessions.getState().stopSession("s1");
    expect(vi.mocked(closeSession)).toHaveBeenCalledWith("s1");
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("a non-live id is a no-op (a stored or archived row has nothing to stop)", async () => {
    // Stop lives on the LIVE row; a stored/archived id has no Worker, and
    // `close_session` on a stored id would be an ask the backend has no
    // business receiving.
    useSessions.setState({
      historySessions: [info("h1", "/x")],
      archivedSessions: [info("a1", "/x")],
    });
    await useSessions.getState().stopSession("h1");
    await useSessions.getState().stopSession("a1");
    expect(vi.mocked(closeSession)).not.toHaveBeenCalled();
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("a rejected command propagates (the row logs it)", async () => {
    // Unlike Archive's best-effort close, Stop has nothing durable behind it:
    // a Stop that silently "succeeded" while the Worker kept running would be
    // a lie on the row, so the rejection goes to the caller.
    useSessions.setState({ sessions: [info("s1", "/x")], inTurn: {} });
    vi.mocked(closeSession).mockRejectedValueOnce(new Error("gone"));
    await expect(useSessions.getState().stopSession("s1")).rejects.toThrow(
      "gone",
    );
  });
});

describe("setSpaceTrusted (the trust flag — the sidebar's shield UI is gone; the behavior lives here)", () => {
  beforeEach(() => {
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      activeSessionId: null,
      activeSpacePath: null,
      spaces: [
        { path: "/tmp/alpha", createdAt: 0, lastOpenedAt: 0, trusted: false },
        { path: "/tmp/beta", createdAt: 0, lastOpenedAt: 0, trusted: true },
      ],
      closeReasons: {},
      messages: {},
      configOptions: {},
    });
    // Reset the Tauri mocks (clears any `mockImplementationOnce` queues
    // left by an earlier test in this file — the mock is module-scoped).
    vi.mocked(setSpaceTrusted).mockReset();
    vi.mocked(setSpaceTrusted).mockResolvedValue(undefined);
    vi.mocked(deleteSpace).mockReset();
    vi.mocked(deleteSpace).mockResolvedValue(undefined);
  });

  it("flips the flag optimistically and calls the set_space_trusted wrapper", async () => {
    const toggling = useSessions.getState().setSpaceTrusted("/tmp/alpha", true);
    // Optimistic: the store flipped BEFORE the (async) command resolves —
    // the spaces store has no live refresh, so the flag must not wait for
    // a round-trip.
    expect(
      useSessions.getState().spaces.find((s) => s.path === "/tmp/alpha")!.trusted,
    ).toBe(true);
    expect(vi.mocked(setSpaceTrusted)).toHaveBeenCalledWith("/tmp/alpha", true);
    await toggling;
  });

  it("rolls the flag back to the previous value when the command rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(setSpaceTrusted).mockRejectedValueOnce(new Error("boom"));
    const toggling = useSessions.getState().setSpaceTrusted("/tmp/beta", false);
    // Optimistic flip first (beta trusted → untrusted)...
    expect(
      useSessions.getState().spaces.find((s) => s.path === "/tmp/beta")!.trusted,
    ).toBe(false);
    // ...then rolled back once the command rejects.
    await toggling;
    expect(
      useSessions.getState().spaces.find((s) => s.path === "/tmp/beta")!.trusted,
    ).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to set trusted for /tmp/beta:",
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it("serializes rapid trust toggles for a space (the second command runs only after the first settles)", async () => {
    // The first command stays pending on a deferred promise: without a
    // per-path queue, the second click's command would be issued
    // immediately (two overlapping Tauri invokes could commit in either
    // order and the DB could end on the OPPOSITE value from the
    // optimistic UI).
    let resolveFirst!: () => void;
    vi.mocked(setSpaceTrusted).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    vi.mocked(setSpaceTrusted).mockImplementationOnce(() => Promise.resolve());
    // `/tmp/gamma` is a FRESH path (no earlier test queued a command
    // for it): the first command is issued synchronously.
    useSessions.getState().setSpaces([
      { path: "/tmp/gamma", createdAt: 0, lastOpenedAt: 0, trusted: false },
    ]);
    // Toggle trust on...
    const first = useSessions.getState().setSpaceTrusted("/tmp/gamma", true);
    expect(vi.mocked(setSpaceTrusted)).toHaveBeenCalledTimes(1);
    // ...then immediately off (the optimistic flip re-labeled the UI).
    const second = useSessions.getState().setSpaceTrusted("/tmp/gamma", false);
    // The second command is NOT issued until the first settles.
    expect(vi.mocked(setSpaceTrusted)).toHaveBeenCalledTimes(1);
    resolveFirst();
    await first;
    await second;
    expect(vi.mocked(setSpaceTrusted)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(setSpaceTrusted)).toHaveBeenNthCalledWith(1, "/tmp/gamma", true);
    expect(vi.mocked(setSpaceTrusted)).toHaveBeenNthCalledWith(2, "/tmp/gamma", false);
    // The final state ends on the last click's value.
    expect(
      useSessions.getState().spaces.find((s) => s.path === "/tmp/gamma")!.trusted,
    ).toBe(false);
  });

  it("settles on the DB-committed value when BOTH of two rapid toggles reject (not the first click's optimistic value)", async () => {
    // Seed through `setSpaces` (the production load path) so the store's
    // committed-trusted baseline is seeded from the DB rows like in
    // production. `delta` is a fresh path (no baseline entry from an
    // earlier test) committed as `trusted: false`.
    const now = Date.now();
    useSessions.getState().setSpaces([
      { path: "/tmp/delta", createdAt: now, lastOpenedAt: now, trusted: false },
    ]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // Both commands reject, on deferred promises so the two rollbacks
    // land in click order: the first click's rollback first, the
    // second's LAST — the last rollback is what the UI settles on.
    let rejectFirst!: (err: Error) => void;
    let rejectSecond!: (err: Error) => void;
    vi.mocked(setSpaceTrusted).mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectFirst = reject;
        }),
    );
    vi.mocked(setSpaceTrusted).mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectSecond = reject;
        }),
    );
    // Click 1 (false → true): the optimistic flip lands before the
    // command settles.
    const click1 = useSessions.getState().setSpaceTrusted("/tmp/delta", true);
    expect(
      useSessions.getState().spaces.find((s) => s.path === "/tmp/delta")!.trusted,
    ).toBe(true);
    // Click 2 (true → false) while click 1's command is still pending:
    // the per-path queue defers the second command.
    const click2 = useSessions.getState().setSpaceTrusted("/tmp/delta", false);
    expect(
      useSessions.getState().spaces.find((s) => s.path === "/tmp/delta")!.trusted,
    ).toBe(false);
    // Reject click 1's command: its rollback lands first, and the queue
    // then issues click 2's (still pending) command — in a microtask
    // that runs AFTER `await click1`'s continuation, so wait for it.
    rejectFirst(new Error("boom1"));
    await click1;
    await vi.waitFor(() => {
      expect(typeof rejectSecond).toBe("function");
    });
    // Reject click 2's command: its rollback lands LAST — the final
    // value is the DB-committed baseline (false), NOT the first
    // click's optimistic value (true).
    rejectSecond(new Error("boom2"));
    await click2;
    expect(
      useSessions.getState().spaces.find((s) => s.path === "/tmp/delta")!.trusted,
    ).toBe(false);
    consoleError.mockRestore();
  });

  it("does NOT leave a stale committed-trusted baseline after a remove (a late in-flight toggle success must not re-insert the pruned entry)", async () => {
    // Seed through `setSpaces` (the production load path) so the store's
    // committed-trusted baseline is seeded from the DB rows: `epsilon`
    // is committed as `trusted: false`.
    const now = Date.now();
    useSessions.getState().setSpaces([
      { path: "/tmp/epsilon", createdAt: now, lastOpenedAt: now, trusted: false },
    ]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // A toggle in flight on a deferred command...
    let resolveToggle!: () => void;
    vi.mocked(setSpaceTrusted).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveToggle = resolve;
        }),
    );
    const toggling = useSessions.getState().setSpaceTrusted("/tmp/epsilon", true);
    // ...and a removal while it is in flight (deferred delete): the
    // store prunes the path's baseline + queue once the delete settles.
    let resolveDelete!: () => void;
    vi.mocked(deleteSpace).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const removing = useSessions.getState().removeSpace("/tmp/epsilon");
    resolveDelete();
    await removing;
    // The in-flight toggle's command succeeds AFTER the prune: its
    // success handler must NOT re-insert a baseline entry for the
    // removed path (it would survive the `addSpace` guard and poison a
    // fresh re-add).
    resolveToggle();
    await toggling;
    // Re-add the path: a fresh DB row is committed as `trusted: false`,
    // so the (pruned) baseline must re-seed to false.
    useSessions.getState().addSpace("/tmp/epsilon");
    // A failed toggle must roll back to the FRESH baseline (false), not
    // a stale in-flight value (true).
    let rejectToggle!: (err: Error) => void;
    vi.mocked(setSpaceTrusted).mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectToggle = reject;
        }),
    );
    const toggle2 = useSessions.getState().setSpaceTrusted("/tmp/epsilon", true);
    rejectToggle(new Error("boom"));
    await toggle2;
    expect(
      useSessions.getState().spaces.find((s) => s.path === "/tmp/epsilon")!.trusted,
    ).toBe(false);
    consoleError.mockRestore();
  });
});

describe("titleSession (the `session-titled` push writes the row's title)", () => {
  beforeEach(() => {
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      activeSessionId: null,
      messages: {},
    });
  });

  it("sets the title on the LIVE entry (the boot `list_sessions` predates a generated title — the push is its only source)", () => {
    useSessions.setState({ sessions: [info("s1", "/x")] });
    useSessions.getState().titleSession("s1", "Porting the session namer");
    expect(useSessions.getState().sessions).toEqual([
      { ...info("s1", "/x"), title: "Porting the session namer" },
    ]);
  });

  it("sets the title on the STORED entry (a session titled in an earlier run lands here, not in `sessions`)", () => {
    useSessions.setState({ historySessions: [info("h1", "/x")] });
    useSessions.getState().titleSession("h1", "Auditing the sidebar rows");
    expect(useSessions.getState().historySessions).toEqual([
      { ...info("h1", "/x"), title: "Auditing the sidebar rows" },
    ]);
  });

  it("sets the title on the ARCHIVED entry", () => {
    useSessions.setState({
      archivedSessions: [{ ...info("a1", "/x"), archived: true }],
    });
    useSessions.getState().titleSession("a1", "Naming an archived session");
    expect(useSessions.getState().archivedSessions).toEqual([
      {
        ...info("a1", "/x"),
        archived: true,
        title: "Naming an archived session",
      },
    ]);
  });

  it("titles a resumed archived session in BOTH lists it belongs to (the sticky membership)", () => {
    // A resumed archived session is STICKY: it sits in `sessions` (live)
    // AND `archivedSessions` at once, and a title that lands mid-run must
    // not leave the two copies disagreeing.
    useSessions.setState({
      sessions: [info("a1", "/x")],
      archivedSessions: [{ ...info("a1", "/x"), archived: true }],
    });
    useSessions.getState().titleSession("a1", "Resumed and renamed");
    const st = useSessions.getState();
    expect(st.sessions[0].title).toBe("Resumed and renamed");
    expect(st.archivedSessions[0].title).toBe("Resumed and renamed");
  });

  it("leaves the list's OTHER entries alone (one title never rewrites its neighbours)", () => {
    useSessions.setState({
      historySessions: [info("h1", "/x"), info("h2", "/x")],
    });
    useSessions.getState().titleSession("h2", "The second session");
    const [first, second] = useSessions.getState().historySessions;
    expect(first.title).toBeUndefined();
    expect(second.title).toBe("The second session");
  });

  it("is a no-op for an id in none of the three lists (does not throw, does not append a ghost row)", () => {
    useSessions.setState({ historySessions: [info("h1", "/x")] });
    expect(() =>
      useSessions.getState().titleSession("ghost", "A deleted session"),
    ).not.toThrow();
    const st = useSessions.getState();
    expect(st.sessions).toEqual([]);
    expect(st.archivedSessions).toEqual([]);
    expect(st.historySessions).toEqual([info("h1", "/x")]);
    expect(st.historySessions).toHaveLength(1);
  });
});

describe("views (store integration for space views)", () => {
  beforeEach(() => {
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      activeSessionId: null,
      spaces: [],
      activeSpacePath: null,
      closeReasons: {},
      messages: {},
      configOptions: {},
    });
  });

  const space = (path: string): SpaceRow => ({
    path,
    createdAt: 0,
    lastOpenedAt: 0,
    trusted: false,
  });

  it("adding sessions sequentially in one space yields a newest-first LIVE DOT and a newest-first sequence in views()", () => {
    // T05 renamed this test: its old name named `liveSessionIds`, a `SpaceView`
    // field ADR 0075 deleted. The fixture is unchanged and so is the expected
    // sequence — it is simply pinned on fields that survive. The order map is
    // EMPTY, so every id is unknown, every id ties, and the sequence is input
    // order, which for all-live rows is reverse insertion order.
    useSessions.setState({
      spaces: [space("/workspaces/alpha")],
    });

    useSessions.getState().addSession(info("s1", "/workspaces/alpha"));
    useSessions.getState().addSession(info("s2", "/workspaces/alpha"));
    useSessions.getState().addSession(info("s3", "/workspaces/alpha"));

    const s = useSessions.getState();
    const view = spaceViewFor(
      s.spaces[0],
      s.sessions,
      s.historySessions,
      s.closeReasons,
      s.archivedSessions,
      { recency: s.sessionRecency },
      s.sessionOrder,
    );
    expect(view.sessionIds).toEqual(["s3", "s2", "s1"]);
    expect(view.liveSessionId).toBe("s3");
  });
});

describe("useSessions.startSessionInActiveSpace", () => {
  beforeEach(() => {
    // Seed via `setState` directly — NOT `getState().setSpaces(…)`, which
    // triggers boot auto-selection + `openSession` → a `loadHistory` IPC.
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      activeSessionId: null,
      activeSpacePath: null,
      spaces: [],
      closeReasons: {},
      messages: {},
      history: {},
      configOptions: {},
      newSessionError: null,
    });
    // The dialog flag is module-scoped, so a `true` this suite's "no Space"
    // cases leave behind is `true` for the next case in this file.
    setNewSpaceDialogOpen(false);
    // The mock is module-scoped: an earlier case's `mockRejectedValueOnce`
    // must not decide a later case's outcome.
    vi.mocked(startSession).mockReset();
    vi.mocked(startSession).mockResolvedValue({
      sessionId: "new1",
      cwd: "/tmp/ws",
      capabilities: {},
      archived: false,
    });
  });

  it("starts a native session at activeSpacePath, records session + space, and SELECTS the new session", async () => {
    useSessions.setState({
      spaces: [row("/tmp/alpha", 1)],
      activeSpacePath: "/tmp/alpha",
    });
    await useSessions.getState().startSessionInActiveSpace();
    expect(vi.mocked(startSession)).toHaveBeenCalledWith("/tmp/alpha");
    const st = useSessions.getState();
    expect(st.sessions.map((s) => s.sessionId)).toContain("new1");
    expect(st.spaces.map((s) => s.path)).toContain("/tmp/ws");
    // The invariant the deleted `useStartNewConversation` test carried: a
    // start flow ALWAYS switches the view to the session it started —
    // `addSession` sets `activeSessionId`, so nothing else has to.
    expect(st.activeSessionId).toBe("new1");
  });

  it("opens the Open Space dialog when activeSpacePath is null", async () => {
    useSessions.setState({ spaces: [], activeSpacePath: null });
    await useSessions.getState().startSessionInActiveSpace();
    expect(vi.mocked(startSession)).not.toHaveBeenCalled();
    expect(getNewSpaceDialogOpen()).toBe(true);
  });

  it("opens the Open Space dialog when the path matches no Space row (a legacy cwd)", async () => {
    // A `⌘N` aimed at a cwd that is no longer a Space row: nothing to start
    // in, so the dialog is the honest answer (the same route the sidebar
    // took for `activeView === undefined`).
    useSessions.setState({
      spaces: [row("/tmp/alpha", 1)],
      activeSpacePath: "/tmp/gone",
    });
    await useSessions.getState().startSessionInActiveSpace();
    expect(vi.mocked(startSession)).not.toHaveBeenCalled();
    expect(getNewSpaceDialogOpen()).toBe(true);
  });

  it("suppresses a concurrent double-invoke (⌘N pressed twice in one tick)", async () => {
    useSessions.setState({
      spaces: [row("/tmp/alpha", 1)],
      activeSpacePath: "/tmp/alpha",
    });
    const p1 = useSessions.getState().startSessionInActiveSpace();
    const p2 = useSessions.getState().startSessionInActiveSpace();
    await Promise.all([p1, p2]);
    expect(vi.mocked(startSession)).toHaveBeenCalledTimes(1);
  });

  it("records the rejection message in newSessionError, and clears it on the next run", async () => {
    // The sidebar's actions-menu `title` is the only surface that shows this,
    // and it re-reads the flag on every open — which is why the action clears
    // it at the top of its own run instead of carrying a `clearError` the way
    // the hook did (no consumer ever called one).
    useSessions.setState({
      spaces: [row("/tmp/alpha", 1)],
      activeSpacePath: "/tmp/alpha",
    });
    vi.mocked(startSession).mockRejectedValueOnce("no such folder");
    await useSessions.getState().startSessionInActiveSpace();
    expect(useSessions.getState().newSessionError).toBe("no such folder");

    await useSessions.getState().startSessionInActiveSpace();
    expect(useSessions.getState().newSessionError).toBeNull();
  });
});

describe("history window and pagination (ADR 0073)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      activeSessionId: null,
      activeSpacePath: null,
      spaces: [],
      closeReasons: {},
      messages: {},
      history: {},
      configOptions: {},
      newSessionError: null,
    });
    useInteractive.setState({
      requests: {},
      todos: {},
      agentState: {},
      cost: {},
      session: {},
    });
  });

  it("openSession calls loadHistory with { limit: 500 }, populates history, bumps generation", async () => {
    const rows: MessageRow[] = [
      msgRow({ id: 10, kind: "user", payloadJson: JSON.stringify({ text: "first" }) }),
      msgRow({ id: 11, kind: "user", payloadJson: JSON.stringify({ text: "second" }) }),
    ];
    vi.mocked(loadHistory).mockResolvedValueOnce({
      rows,
      hasMore: true,
      todos: null,
    });
    useSessions.setState({
      activeSessionId: null,
      historySessions: [info("s1", "/x")],
    });
    useSessions.getState().openSession("s1");
    await new Promise((r) => setTimeout(r, 0));

    expect(loadHistory).toHaveBeenCalledWith("s1", { limit: INITIAL_HISTORY_PAGE });
    const hist = useSessions.getState().history["s1"];
    expect(hist).toEqual({
      oldestRowId: 10,
      hasMore: true,
      loadingMore: false,
      generation: 1,
      epoch: 0,
    });
    expect(useSessions.getState().messages["s1"]).toHaveLength(2);
  });

  it("loadOlderHistory calls loadHistory with { limit: 200, beforeId }, prepends older rows, updates oldestRowId / hasMore", async () => {
    useSessions.setState({
      activeSessionId: "s1",
      history: {
        s1: {
          oldestRowId: 10,
          hasMore: true,
          loadingMore: false,
          generation: 1,
          epoch: 0,
        },
      },
      messages: {
        s1: [{ kind: "user", text: "current", at: 100 }],
      },
    });
    const olderRows: MessageRow[] = [
      msgRow({ id: 5, kind: "user", payloadJson: JSON.stringify({ text: "older" }) }),
    ];
    vi.mocked(loadHistory).mockResolvedValueOnce({
      rows: olderRows,
      hasMore: false,
      todos: null,
    });

    await useSessions.getState().loadOlderHistory("s1");

    expect(loadHistory).toHaveBeenCalledWith("s1", {
      limit: OLDER_HISTORY_PAGE,
      beforeId: 10,
    });
    const hist = useSessions.getState().history["s1"];
    expect(hist).toEqual({
      oldestRowId: 5,
      hasMore: false,
      loadingMore: false,
      generation: 1,
      epoch: 0,
    });
    const msgs = useSessions.getState().messages["s1"];
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ kind: "user", text: "older" });
    expect(msgs[1]).toMatchObject({ kind: "user", text: "current" });
  });

  it("loadOlderHistory is a no-op if hasMore is false, loadingMore is true, or oldestRowId is null", async () => {
    useSessions.setState({
      history: {
        s1: { oldestRowId: 10, hasMore: false, loadingMore: false, generation: 1, epoch: 0 },
        s2: { oldestRowId: 10, hasMore: true, loadingMore: true, generation: 1, epoch: 0 },
        s3: { oldestRowId: null, hasMore: true, loadingMore: false, generation: 1, epoch: 0 },
      },
    });
    await useSessions.getState().loadOlderHistory("s1");
    await useSessions.getState().loadOlderHistory("s2");
    await useSessions.getState().loadOlderHistory("s3");
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("loadOlderHistory discards response if generation changed while fetch was in flight", async () => {
    let resolvePage: (page: HistoryPage) => void = () => {};
    vi.mocked(loadHistory).mockImplementationOnce(
      () => new Promise<HistoryPage>((r) => (resolvePage = r)),
    );
    useSessions.setState({
      activeSessionId: "s1",
      history: {
        s1: {
          oldestRowId: 10,
          hasMore: true,
          loadingMore: false,
          generation: 1,
          epoch: 0,
        },
      },
      messages: {
        s1: [{ kind: "user", text: "original", at: 100 }],
      },
    });

    const p = useSessions.getState().loadOlderHistory("s1");
    expect(useSessions.getState().history["s1"]?.loadingMore).toBe(true);

    // Generation bumps (e.g. from resume or reopen)
    useSessions.setState((st) => ({
      history: {
        ...st.history,
        s1: { ...st.history["s1"]!, generation: 2, loadingMore: false },
      },
    }));

    resolvePage({
      rows: [msgRow({ id: 2, kind: "user", payloadJson: JSON.stringify({ text: "stale" }) })],
      hasMore: false,
      todos: null,
    });
    await p;

    expect(useSessions.getState().messages["s1"]).toEqual([
      { kind: "user", text: "original", at: 100 },
    ]);
  });

  it("loadOlderHistory discards response if session was deleted while fetch was in flight", async () => {
    let resolvePage: (page: HistoryPage) => void = () => {};
    vi.mocked(loadHistory).mockImplementationOnce(
      () => new Promise<HistoryPage>((r) => (resolvePage = r)),
    );
    useSessions.setState({
      activeSessionId: "s1",
      history: {
        s1: {
          oldestRowId: 10,
          hasMore: true,
          loadingMore: false,
          generation: 1,
          epoch: 0,
        },
      },
      messages: {
        s1: [{ kind: "user", text: "original", at: 100 }],
      },
    });

    const p = useSessions.getState().loadOlderHistory("s1");

    useSessions.setState((st) => {
      const { s1: _h, ...restH } = st.history;
      const { s1: _m, ...restM } = st.messages;
      return { history: restH, messages: restM };
    });

    resolvePage({
      rows: [msgRow({ id: 2, kind: "user", payloadJson: JSON.stringify({ text: "stale" }) })],
      hasMore: false,
      todos: null,
    });
    await p;

    expect(useSessions.getState().history["s1"]).toBeUndefined();
    expect(useSessions.getState().messages["s1"]).toBeUndefined();
  });

  it("loadOlderHistory resets loadingMore to false on error while preserving generation and hasMore", async () => {
    vi.mocked(loadHistory).mockRejectedValueOnce(new Error("network error"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    useSessions.setState({
      activeSessionId: "s1",
      history: {
        s1: {
          oldestRowId: 10,
          hasMore: true,
          loadingMore: false,
          generation: 1,
          epoch: 0,
        },
      },
      messages: {
        s1: [{ kind: "user", text: "original", at: 100 }],
      },
    });

    await useSessions.getState().loadOlderHistory("s1");

    const hist = useSessions.getState().history["s1"];
    expect(hist?.loadingMore).toBe(false);
    expect(hist?.hasMore).toBe(true);
    expect(hist?.generation).toBe(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("openSession seeds useInteractive.todos if page.todos is present and session not already in todos", async () => {
    const todos = [{ content: "Task 1", status: "pending" as const }];
    vi.mocked(loadHistory).mockResolvedValueOnce({
      rows: [],
      hasMore: false,
      todos,
    });
    useSessions.setState({
      activeSessionId: null,
      historySessions: [info("s-todo", "/x")],
    });

    useSessions.getState().openSession("s-todo");
    await new Promise((r) => setTimeout(r, 0));

    expect(useInteractive.getState().todos["s-todo"]).toEqual(todos);
  });

  it("openSession does NOT overwrite useInteractive.todos if session is already in todos", async () => {
    const existing = [{ content: "Existing Task", status: "completed" as const }];
    const fromPage = [{ content: "Stale Task", status: "pending" as const }];
    vi.mocked(loadHistory).mockResolvedValueOnce({
      rows: [],
      hasMore: false,
      todos: fromPage,
    });
    useInteractive.setState({ todos: { "s-todo": existing } });
    useSessions.setState({
      activeSessionId: null,
      historySessions: [info("s-todo", "/x")],
    });

    useSessions.getState().openSession("s-todo");
    await new Promise((r) => setTimeout(r, 0));

    expect(useInteractive.getState().todos["s-todo"]).toEqual(existing);
  });

  it("deleteSession cleans up history and clears todos", async () => {
    useSessions.setState({
      sessions: [info("s1", "/x")],
      messages: { s1: [{ kind: "user", text: "hi", at: 1 }] },
      history: {
        s1: { oldestRowId: 1, hasMore: false, loadingMore: false, generation: 1, epoch: 0 },
      },
    });
    useInteractive.setState({
      todos: { s1: [{ content: "do it", status: "pending" }] },
    });

    await useSessions.getState().deleteSession("s1");

    expect(useSessions.getState().history["s1"]).toBeUndefined();
    expect(useSessions.getState().messages["s1"]).toBeUndefined();
    expect(useInteractive.getState().todos["s1"]).toBeUndefined();
  });

  it("resumeSession resets window to tail, bumps generation, and seeds todos", async () => {
    const todos = [{ content: "Resume Task", status: "in_progress" as const }];
    const rows: MessageRow[] = [
      msgRow({ id: 50, kind: "user", payloadJson: JSON.stringify({ text: "tail" }) }),
    ];
    vi.mocked(loadHistory).mockResolvedValueOnce({
      rows,
      hasMore: true,
      todos,
    });
    useSessions.setState({
      activeSessionId: "s1",
      historySessions: [info("s1", "/x")],
      history: {
        s1: { oldestRowId: 10, hasMore: false, loadingMore: false, generation: 1, epoch: 0 },
      },
      messages: {
        s1: [
          { kind: "user", text: "prepended-old", at: 1 },
          { kind: "user", text: "tail", at: 50 },
        ],
      },
    });

    await useSessions.getState().resumeSession("s1");
    await new Promise((r) => setTimeout(r, 0));

    const hist = useSessions.getState().history["s1"];
    expect(hist).toEqual({
      oldestRowId: 50,
      hasMore: true,
      loadingMore: false,
      generation: 2,
      epoch: 1,
    });
    expect(useInteractive.getState().todos["s1"]).toEqual(todos);
    // Transcript reset to reloaded rows (deduped)
    expect(useSessions.getState().messages["s1"]).toEqual([
      { kind: "user", text: "tail", at: 1000 },
    ]);
  });

  it("resumeSession invalidates in-flight loadOlderHistory pages", async () => {
    let resolveOlderPage: (page: HistoryPage) => void = () => {};
    let resolveResumePage: (page: HistoryPage) => void = () => {};

    vi.mocked(loadHistory)
      .mockImplementationOnce(
        () => new Promise<HistoryPage>((r) => (resolveOlderPage = r)),
      )
      .mockImplementationOnce(
        () => new Promise<HistoryPage>((r) => (resolveResumePage = r)),
      );

    useSessions.setState({
      activeSessionId: "s1",
      historySessions: [info("s1", "/x")],
      history: {
        s1: {
          oldestRowId: 10,
          hasMore: true,
          loadingMore: false,
          generation: 1,
          epoch: 0,
        },
      },
      messages: {
        s1: [{ kind: "user", text: "initial", at: 100 }],
      },
    });

    const olderPromise = useSessions.getState().loadOlderHistory("s1");
    expect(useSessions.getState().history["s1"]?.loadingMore).toBe(true);

    const resumePromise = useSessions.getState().resumeSession("s1");
    await resumePromise;

    resolveOlderPage({
      rows: [
        msgRow({ id: 5, kind: "user", payloadJson: JSON.stringify({ text: "older-row" }) }),
      ],
      hasMore: false,
      todos: null,
    });
    await olderPromise;

    resolveResumePage({
      rows: [
        msgRow({ id: 20, kind: "user", payloadJson: JSON.stringify({ text: "tail-row" }) }),
      ],
      hasMore: false,
      todos: null,
    });
    await new Promise((r) => setTimeout(r, 0));

    const msgs = useSessions.getState().messages["s1"] ?? [];
    const texts = msgs.map((m) => (m.kind === "user" ? m.text : ""));
    expect(texts).not.toContain("older-row");
    expect(texts).toContain("tail-row");
    expect(useSessions.getState().history["s1"]?.loadingMore).toBe(false);
  });

  it("while resumeSession reload is pending, loadOlderHistory is a no-op", async () => {
    let resolveResumePage: (page: HistoryPage) => void = () => {};
    let resolveOlderPage: (page: HistoryPage) => void = () => {};

    vi.mocked(loadHistory)
      .mockImplementationOnce(
        () => new Promise<HistoryPage>((r) => (resolveResumePage = r)),
      )
      .mockImplementationOnce(
        () => new Promise<HistoryPage>((r) => (resolveOlderPage = r)),
      );

    useSessions.setState({
      activeSessionId: "s1",
      historySessions: [info("s1", "/x")],
      history: {
        s1: {
          oldestRowId: 10,
          hasMore: true,
          loadingMore: false,
          generation: 1,
          epoch: 0,
        },
      },
      messages: {
        s1: [{ kind: "user", text: "initial", at: 100 }],
      },
    });

    const resumePromise = useSessions.getState().resumeSession("s1");
    await resumePromise; // resume IPC returns; history reload is now pending

    // loadingMore must be true during the resume reload
    expect(useSessions.getState().history["s1"]?.loadingMore).toBe(true);

    // loadOlderHistory called while reload is pending should no-op
    await useSessions.getState().loadOlderHistory("s1");
    expect(vi.mocked(loadHistory)).toHaveBeenCalledTimes(1);
    expect(useSessions.getState().messages["s1"]).toEqual([
      { kind: "user", text: "initial", at: 100 },
    ]);

    // Now resolve the resume reload
    resolveResumePage({
      rows: [
        msgRow({ id: 20, kind: "user", payloadJson: JSON.stringify({ text: "tail-row" }) }),
      ],
      hasMore: true,
      todos: null,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(useSessions.getState().history["s1"]?.loadingMore).toBe(false);
    expect(useSessions.getState().messages["s1"]).toEqual([
      { kind: "user", text: "tail-row", at: 1000 },
    ]);

    // loadOlderHistory works again
    const olderPromise = useSessions.getState().loadOlderHistory("s1");
    expect(vi.mocked(loadHistory)).toHaveBeenCalledTimes(2);
    expect(useSessions.getState().history["s1"]?.loadingMore).toBe(true);

    resolveOlderPage({
      rows: [
        msgRow({ id: 5, kind: "user", payloadJson: JSON.stringify({ text: "older-row" }) }),
      ],
      hasMore: false,
      todos: null,
    });
    await olderPromise;

    expect(useSessions.getState().history["s1"]?.loadingMore).toBe(false);
    const texts = (useSessions.getState().messages["s1"] ?? []).map((m) =>
      m.kind === "user" ? m.text : "",
    );
    expect(texts).toEqual(["older-row", "tail-row"]);
  });

  it("resumeSession creates history entry when session has no history entry yet", async () => {
    vi.mocked(loadHistory).mockResolvedValueOnce({
      rows: [
        msgRow({ id: 1, kind: "user", payloadJson: JSON.stringify({ text: "hello" }) }),
      ],
      hasMore: false,
      todos: null,
    });

    useSessions.setState({
      activeSessionId: "s1",
      historySessions: [info("s1", "/x")],
      history: {},
      messages: {},
    });

    await useSessions.getState().resumeSession("s1");
    await new Promise((r) => setTimeout(r, 0));

    const hist = useSessions.getState().history["s1"];
    expect(hist).toEqual({
      oldestRowId: 1,
      hasMore: false,
      loadingMore: false,
      generation: 1,
      epoch: 1,
    });
  });

  it("resumeSession handles loadHistory rejection gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loadHistory).mockRejectedValueOnce(new Error("network error"));

    useSessions.setState({
      activeSessionId: "s1",
      historySessions: [info("s1", "/x")],
      history: {
        s1: {
          oldestRowId: 42,
          hasMore: true,
          loadingMore: false,
          generation: 1,
          epoch: 5,
        },
      },
      messages: {
        s1: [{ kind: "user", text: "keep-me", at: 100 }],
      },
    });

    await useSessions.getState().resumeSession("s1");
    await new Promise((r) => setTimeout(r, 0));

    const hist = useSessions.getState().history["s1"];
    expect(hist).toEqual({
      oldestRowId: 42,
      hasMore: true,
      loadingMore: false,
      generation: 1,
      epoch: 6,
    });
    expect(useSessions.getState().messages["s1"]).toEqual([
      { kind: "user", text: "keep-me", at: 100 },
    ]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("detachedSessions (sessions with no open Space — CONTEXT.md's Detached session)", () => {
  const stored = (sessionId: string, cwd: string): SessionInfo => ({
    sessionId,
    cwd,
    capabilities: {},
    archived: false,
  });
  const archived = (sessionId: string, cwd: string): SessionInfo => ({
    sessionId,
    cwd,
    capabilities: {},
    archived: true,
  });
  const live = (sessionId: string, cwd: string): SessionInfo => ({
    sessionId,
    cwd,
    capabilities: {},
    archived: false,
  });
  const openSpaces = [{ path: "/tmp/alpha" }, { path: "/tmp/beta" }];

  it("excludes a row whose cwd is an open Space", () => {
    expect(
      detachedSessions(openSpaces, [stored("h1", "/tmp/alpha")], [], []),
    ).toEqual([]);
    expect(
      detachedSessions(openSpaces, [stored("h1", "/tmp/beta")], [], []),
    ).toEqual([]);
  });

  it("returns a row whose cwd matches no Space path, archived or not", () => {
    const rows = detachedSessions(
      openSpaces,
      [stored("h1", "/tmp/gamma")],
      [archived("a1", "/tmp/delta")],
      [],
    );
    expect(rows.map((r) => r.sessionId)).toEqual(["h1", "a1"]);
    // The rows themselves are returned (not ids) — the Settings section
    // renders cwd/title straight off them.
    expect(rows[0]).toEqual(stored("h1", "/tmp/gamma"));
    expect(rows[1]).toEqual(archived("a1", "/tmp/delta"));
  });

  it("excludes a live row even when its cwd matches no Space (the Close-anyway case)", () => {
    // `closeSpace` removes the Space row and touches no session (ADR 0043),
    // so a LIVE session with no Space row is reachable, not defensive.
    const rows = detachedSessions(
      openSpaces,
      [stored("h1", "/tmp/gamma")],
      [archived("a1", "/tmp/delta")],
      [live("a1", "/tmp/delta")],
    );
    expect(rows.map((r) => r.sessionId)).toEqual(["h1"]);
  });

  it("returns a row whose folder no longer exists on disk (no filesystem access here)", () => {
    // `/nonexistent/…` is a path that cannot exist — the derivation is pure
    // string equality, so a deleted folder is just another non-match.
    const rows = detachedSessions(
      openSpaces,
      [stored("gone", "/nonexistent/deleted-folder")],
      [],
      [],
    );
    expect(rows.map((r) => r.sessionId)).toEqual(["gone"]);
  });

  it("returns [] when every row belongs to an open Space", () => {
    expect(
      detachedSessions(
        openSpaces,
        [stored("h1", "/tmp/alpha"), stored("h2", "/tmp/beta")],
        [archived("a1", "/tmp/alpha")],
        [],
      ),
    ).toEqual([]);
  });

  it("keeps input order: stored rows first, then archived, neither re-sorted", () => {
    // The order IS the store's input order — the user's MANUAL ORDER for the
    // stored rows, then the archived rows in theirs — and that is deliberate:
    // Settings → Detached sessions is a management list, not a recency list
    // (ADR 0075). The assertion is the pre-ADR-0075 one; only the REASON for it
    // changed, which is exactly what a test that cannot see recency proves.
    const rows = detachedSessions(
      openSpaces,
      [stored("h2", "/tmp/gamma"), stored("h1", "/tmp/delta")],
      [archived("a2", "/tmp/epsilon"), archived("a1", "/tmp/gamma")],
      [],
    );
    expect(rows.map((r) => r.sessionId)).toEqual(["h2", "h1", "a2", "a1"]);
  });
});

describe("sessionRecency (the recency + order side-channel, ADR 0075)", () => {
  // This file resets by hand-written key lists elsewhere; this describe uses the
  // shared `resetStores()` because the assertions below are about the store's
  // INITIAL shape, which is exactly what that helper installs (from zustand's own
  // `getInitialState()` capture, so a newly added field is covered for free).
  beforeEach(() => resetStores());
  afterEach(() => resetStores());

  it("the store starts with empty sessionRecency and sessionOrder maps (the closeReasons side-channel shape)", () => {
    // Both boot maps are `{}` before the boot fetch lands — the same shape
    // `closeReasons` starts with, and the reason `recencyOf` must answer `null`
    // rather than invent `0` for an id the map has never seen.
    expect(useSessions.getState().sessionRecency).toEqual({});
    expect(useSessions.getState().sessionOrder).toEqual({});
  });

  it("setSessionRecency reduces one row set into BOTH the per-id recency map and the per-id order map", () => {
    // ONE payload, TWO readings. The two maps are seeded from the SAME array on
    // purpose, so a setter that fills one and forgets the other is red here —
    // the single most likely way to ship ADR 0075 broken (a recency map with no
    // order map loses the one sequence; an order map with no recency map puts
    // position back in charge of the Landing Session).
    useSessions.getState().setSessionRecency([
      { sessionId: "s1", lastActiveAt: 9_000_000_000_000, sortOrder: 4 },
      { sessionId: "s2", lastActiveAt: 8_000_000_000_000, sortOrder: 1 },
    ]);
    expect(useSessions.getState().sessionRecency).toEqual({
      s1: 9_000_000_000_000,
      s2: 8_000_000_000_000,
    });
    expect(useSessions.getState().sessionOrder).toEqual({ s1: 4, s2: 1 });

    // A later row for a known id WINS in both maps: unlike the merge-only
    // `closeReasons` neighbour, these maps are a SNAPSHOT of the newest read
    // (D13), so a stale entry must not outlive the row it described.
    useSessions.getState().setSessionRecency([
      { sessionId: "s1", lastActiveAt: 9_500_000_000_000, sortOrder: 0 },
    ]);
    expect(useSessions.getState().sessionRecency).toEqual({
      s1: 9_500_000_000_000,
    });
    expect(useSessions.getState().sessionOrder).toEqual({ s1: 0 });
  });
});

describe("reorderSessions (the sidebar drag write path, ADR 0075)", () => {
  // The optimistic write's whole point is that it changes the ORDER MAP, so every
  // fixture here seeds `sessionOrder` explicitly. A fixture that left it empty
  // would make every id unknown, every id tied, and the derivation answer input
  // order — which at this point in the chain is byte-for-byte what the OLD
  // live-then-stored concatenation answered, i.e. a test that cannot fail.
  beforeEach(() => {
    resetStores();
    vi.mocked(reorderSessionsCommand).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => resetStores());

  /** Drain to a macrotask boundary, so "the chain has had every chance to reach
   *  the command" is a fact about the QUEUE and not about how many
   *  `await Promise.resolve()`s the implementation happens to need. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** The store's own view of one Space, built the way the render layer builds it.
   *  Step (b)/(c) of the acceptance test read THIS and not `historySessions`, on
   *  purpose: an assertion on the store's array is the shape that passes for the
   *  stale-map implementation the test exists to catch. */
  const viewFor = (path: string) => {
    const s = useSessions.getState();
    return spaceViewFor(
      row(path, 1000),
      s.sessions,
      s.historySessions,
      s.closeReasons,
      s.archivedSessions,
      { recency: s.sessionRecency },
      s.sessionOrder,
    );
  };

  /** `/w/alpha` with three STORED rows the user arranged top-to-bottom as
   *  top(0) mid(1) bottom(2), and no live rows. */
  const seedAlpha = () => {
    useSessions.setState({
      spaces: [row("/w/alpha", 1000)],
      sessions: [],
      historySessions: [
        info("top", "/w/alpha"),
        info("mid", "/w/alpha"),
        info("bottom", "/w/alpha"),
      ],
      archivedSessions: [],
      activeSessionId: null,
      activeSpacePath: "/w/alpha",
      closeReasons: {},
      messages: {},
      sessionRecency: {},
      sessionOrder: { top: 0, mid: 1, bottom: 2 },
    });
  };

  it("a dragged row HOLDS its slot when the list is re-derived from the stored rows (the optimistic write moves the order map, not the array it derived)", async () => {
    // THE ACCEPTANCE TEST FOR T05 — T03's recorded constraint, made observable.
    //
    // TWO COMPETING ANSWERS, and this is the whole task in one assertion:
    //  - an implementation that reorders the DERIVED array (`historySessions`)
    //    answers the ORIGINAL order at both (b) and (c): `sessionOrder` is a BOOT
    //    SNAPSHOT, so `mergeSessionOrder` re-sorts the union straight back and the
    //    row SNAPS BACK — the defect T03 recorded as a constraint;
    //  - an implementation that writes the MAP answers ["mid","bottom","top"] at
    //    every step.
    seedAlpha();
    // The whole visible slice in its new order — exactly what `useDragReorder`
    // hands `onReorder`.
    const done = useSessions.getState().reorderSessions([
      "mid",
      "bottom",
      "top",
    ]);

    // (a) THE MAP MOVED. Slice index = the new number.
    expect(useSessions.getState().sessionOrder).toEqual({
      top: 2,
      mid: 0,
      bottom: 1,
    });

    // (b) THE PAINT: the sequence the rows render, read off the derivation.
    expect(viewFor("/w/alpha").sessionIds).toEqual(["mid", "bottom", "top"]);

    // (c) THE PROMISE: re-derive from the ORIGINAL boot array — the shape any
    // refetch or any other writer restores. (b) alone already reddens the
    // array-only write; (c) is the constraint as T03 recorded it — a drag holds
    // ACROSS a re-derivation — and the step that stops a future implementation
    // satisfying the paint while leaving the durable map stale.
    useSessions.getState().setHistorySessions([
      info("top", "/w/alpha"),
      info("mid", "/w/alpha"),
      info("bottom", "/w/alpha"),
    ]);
    expect(viewFor("/w/alpha").sessionIds).toEqual(["mid", "bottom", "top"]);

    // (d) and it is still there once the command has landed.
    await done;
    expect(viewFor("/w/alpha").sessionIds).toEqual(["mid", "bottom", "top"]);
  });

  it("publishes the new order BEFORE the command resolves (the optimistic publish the sidebar paints from)", () => {
    // `useAgentOverridesWrites`' "publish first (before the awaits)", copied. The
    // COMPETING ANSWER is a write-after-await implementation, which leaves the
    // boot map standing at this instant. Deliberately no `await` anywhere: the
    // command is left pending and the assertions are synchronous.
    seedAlpha();
    useSessions.getState().reorderSessions(["mid", "bottom", "top"]);
    expect(useSessions.getState().sessionOrder).toEqual({
      top: 2,
      mid: 0,
      bottom: 1,
    });
    expect(viewFor("/w/alpha").sessionIds).toEqual(["mid", "bottom", "top"]);
  });

  it("sends the WHOLE visible slice VERBATIM — unsorted, undeduped, unfiltered — and sends nothing for an empty slice", async () => {
    seedAlpha();
    await useSessions.getState().reorderSessions(["mid", "bottom", "top"]);
    // TWO COMPETING ANSWERS: "send just the moved id" answers ["mid"] — and
    // because the Rust side writes the SLICE INDEX as each row's stored number,
    // that is the half-moved list the spec calls a bug.
    expect(reorderSessionsCommand).toHaveBeenCalledTimes(1);
    expect(reorderSessionsCommand).toHaveBeenCalledWith(["mid", "bottom", "top"]);

    // The empty slice is the one degenerate case the store CAN see (it has no
    // view of a visible slice — that is the render layer's answer).
    await useSessions.getState().reorderSessions([]);
    expect(reorderSessionsCommand).toHaveBeenCalledTimes(1);
    expect(useSessions.getState().sessionOrder).toEqual({
      top: 2,
      mid: 0,
      bottom: 1,
    });
  });

  it("a rejected reorder logs and restores the PREVIOUS order map, and the action never rejects", async () => {
    useSessions.setState({
      spaces: [row("/w/a", 1000)],
      sessions: [],
      historySessions: [info("a", "/w/a"), info("b", "/w/a")],
      archivedSessions: [],
      activeSpacePath: "/w/a",
      closeReasons: {},
      messages: {},
      sessionRecency: {},
      sessionOrder: { a: 0, b: 1 },
    });
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.mocked(reorderSessionsCommand).mockRejectedValueOnce(new Error("boom"));
    // The `await` IS the never-rejects proof: a rejecting action fails this test
    // on the rejection rather than on an assertion.
    await useSessions.getState().reorderSessions(["b", "a"]);
    // TWO COMPETING ANSWERS: no rollback leaves ["b","a"] in the UI while the DB
    // holds ["a","b"] — the list the user sees re-arranged at the next boot,
    // which reads as the app ignoring them.
    expect(useSessions.getState().sessionOrder).toEqual({ a: 0, b: 1 });
    expect(viewFor("/w/a").sessionIds).toEqual(["a", "b"]);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("reorder"),
      expect.anything(),
    );
    errSpy.mockRestore();
  });

  it("a failed OLDER drag does not roll back a NEWER drag's order (the publish epoch, checked at commit)", async () => {
    useSessions.setState({
      spaces: [row("/w/a", 1000)],
      sessions: [],
      historySessions: [
        info("a", "/w/a"),
        info("b", "/w/a"),
        info("c", "/w/a"),
      ],
      archivedSessions: [],
      activeSpacePath: "/w/a",
      closeReasons: {},
      messages: {},
      sessionRecency: {},
      sessionOrder: { a: 0, b: 1, c: 2 },
    });
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    // Two drags in one tick: the FIRST one's command fails, the second's lands.
    vi.mocked(reorderSessionsCommand).mockRejectedValueOnce(new Error("boom"));
    const first = useSessions.getState().reorderSessions(["b", "a"]);
    const second = useSessions.getState().reorderSessions(["c", "b", "a"]);
    await Promise.all([first, second]);
    // TWO COMPETING ANSWERS: an unconditional rollback restores the pre-FIRST
    // snapshot {a:0,b:1,c:2} and silently DELETES the user's second drag — the
    // exact failure `useAgentOverridesWrites`' epoch exists to stop.
    expect(useSessions.getState().sessionOrder).toEqual({ c: 0, b: 1, a: 2 });
    expect(viewFor("/w/a").sessionIds).toEqual(["c", "b", "a"]);
    errSpy.mockRestore();
  });

  it("two drags whose commands BOTH fail return the order the DATABASE holds, not the first drag's optimistic one", async () => {
    // The sibling of the epoch test above, and the case the epoch guard does NOT
    // solve on its own. TWO COMPETING ANSWERS:
    //  - the bug answers `{b:0, a:1, c:2}`: the SECOND drag captures its rollback
    //    snapshot from the store, which at that instant IS the first drag's
    //    optimistic, never-committed map, and the guard correctly discards the
    //    FIRST drag's own rollback — so the only write left restores a number the
    //    database never held, and the rows re-arrange themselves at the next boot
    //    into an order the user never asked for and was never told had failed;
    //  - the committed baseline answers `{a:0, b:1, c:2}`, which is what
    //    `list_sessions` still returns because BOTH commands failed.
    // The baseline is seeded through `setSessionRecency` — the boot path that
    // fills `sessionOrder` from the row's own `sortOrder`, i.e. from the database.
    useSessions.getState().setSessionRecency([
      { sessionId: "a", lastActiveAt: 1_000, sortOrder: 0 },
      { sessionId: "b", lastActiveAt: 2_000, sortOrder: 1 },
      { sessionId: "c", lastActiveAt: 3_000, sortOrder: 2 },
    ]);
    useSessions.setState({
      spaces: [row("/w/a", 1000)],
      sessions: [],
      historySessions: [
        info("a", "/w/a"),
        info("b", "/w/a"),
        info("c", "/w/a"),
      ],
      archivedSessions: [],
      activeSpacePath: "/w/a",
      closeReasons: {},
      messages: {},
    });
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    // BOTH commands reject (every call, not just the first).
    vi.mocked(reorderSessionsCommand).mockRejectedValue(new Error("boom"));
    const first = useSessions.getState().reorderSessions(["b", "a"]);
    const second = useSessions.getState().reorderSessions(["c", "b", "a"]);
    await Promise.all([first, second]);
    expect(useSessions.getState().sessionOrder).toEqual({ a: 0, b: 1, c: 2 });
    // And the PAINT agrees with the database, which is the only thing the user can
    // check: the rows sit exactly where they were before either drag.
    expect(viewFor("/w/a").sessionIds).toEqual(["a", "b", "c"]);
    // Both writes really were attempted, in drag order (the chain is intact).
    expect(reorderSessionsCommand).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });

  it("reordering one Space leaves another Space's rows exactly where they were", async () => {
    // Space B's rows sit in the ARRAY in the OPPOSITE order to their numbers, on
    // purpose. TWO COMPETING ANSWERS: an implementation that rebuilds the map
    // wholesale (`Object.fromEntries(ids.map(…))`) DELETES b1/b2, and
    // `sortByManualOrder` sinks unknown ids while preserving their input order —
    // so Space B silently answers ["b2","b1"]. Seeding B's array order to AGREE
    // with its numbers would make the two rules answer identically, which is the
    // trap the Conventions name.
    useSessions.setState({
      spaces: [row("/w/a", 1000), row("/w/b", 900)],
      sessions: [],
      historySessions: [
        info("a1", "/w/a"),
        info("a2", "/w/a"),
        info("b2", "/w/b"),
        info("b1", "/w/b"),
      ],
      archivedSessions: [],
      activeSpacePath: "/w/a",
      closeReasons: {},
      messages: {},
      sessionRecency: {},
      sessionOrder: { a1: 0, a2: 1, b1: 0, b2: 1 },
    });
    // Prove the fixture is live: the map beats the array for Space B too.
    expect(viewFor("/w/b").sessionIds).toEqual(["b1", "b2"]);

    await useSessions.getState().reorderSessions(["a2", "a1"]);

    expect(viewFor("/w/a").sessionIds).toEqual(["a2", "a1"]);
    expect(viewFor("/w/b").sessionIds).toEqual(["b1", "b2"]);
  });

  it("ids outside the sent slice keep their map entries (the write touches the slice, as the command does)", async () => {
    // The data-layer statement of the same failure as the test above: the command
    // updates ONLY the ids it is given, so a wholesale map would sink every other
    // Space's rows to the bottom.
    useSessions.setState({ sessionOrder: { a: 0, b: 1, z: 7 } });
    await useSessions.getState().reorderSessions(["b", "a"]);
    expect(useSessions.getState().sessionOrder).toEqual({ a: 1, b: 0, z: 7 });
  });

  it("two drags in one list reach the database in DRAG ORDER (the chain — the newer drag must not land first)", async () => {
    // The property `setSpaceTrusted`'s `inFlightToggles` queue exists for, copied
    // (D4). TWO COMPETING ANSWERS: with the chain, the second drag's command does
    // not START while the first is still in flight; without it, both fire as soon
    // as they are called and the DB settles on whichever IPC finishes last — which
    // can be the OLDER drag, leaving the database on an order the user has since
    // overwritten. The optimistic map cannot save it: the map is the newer order
    // while the DB is the older one, and the next boot re-derives from the DB.
    useSessions.setState({
      spaces: [row("/w/a", 1000)],
      sessions: [],
      historySessions: [
        info("a", "/w/a"),
        info("b", "/w/a"),
        info("c", "/w/a"),
      ],
      archivedSessions: [],
      activeSpacePath: "/w/a",
      closeReasons: {},
      messages: {},
      sessionRecency: {},
      sessionOrder: { a: 0, b: 1, c: 2 },
    });
    // Hold the first command open until the test says so.
    let releaseFirst: () => void = () => {};
    const firstCommand = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(reorderSessionsCommand).mockImplementationOnce(
      () => firstCommand,
    );

    const first = useSessions.getState().reorderSessions(["b", "a"]);
    // Let the chain's `.then` reach the command, so the first IPC is genuinely in
    // flight (not merely queued). A `setTimeout` flush drains the whole microtask
    // queue, so the count below cannot be a tick-count artefact.
    await flush();
    expect(reorderSessionsCommand).toHaveBeenCalledTimes(1);

    const second = useSessions.getState().reorderSessions(["c", "b", "a"]);
    await flush();
    // THE DISCRIMINATING ASSERTION: the second command has not even started.
    expect(reorderSessionsCommand).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(reorderSessionsCommand).toHaveBeenCalledTimes(2);
    expect(reorderSessionsCommand).toHaveBeenNthCalledWith(1, ["b", "a"]);
    expect(reorderSessionsCommand).toHaveBeenNthCalledWith(2, [
      "c",
      "b",
      "a",
    ]);
    // And the optimistic map is the NEWER drag's, which is what the user sees.
    expect(useSessions.getState().sessionOrder).toEqual({ c: 0, b: 1, a: 2 });
  });
});

describe("reorderSpaces (the tab-strip drag write path, ADR 0075)", () => {
  // The asymmetry with the describe above, stated once: a Space carries its
  // position in the ARRAY — `SpaceRow` has no order field and the column never
  // crosses the wire — so `spaces.map(…)` IS the tab strip and
  // `views = spaces.map(spaceViewFor)` inherits it. There is therefore no map to
  // write and no snap-back hazard; what this action owns instead is the array's
  // integrity (nothing dropped, nothing invented).
  beforeEach(() => {
    resetStores();
    vi.mocked(reorderSpacesCommand).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => resetStores());

  const stripPaths = () => useSessions.getState().spaces.map((s) => s.path);

  it("reorders the tab strip optimistically and sends the whole strip's PATHS", async () => {
    useSessions.setState({
      spaces: [row("/a", 3000), row("/b", 2000), row("/c", 1000)],
    });
    const done = useSessions.getState().reorderSpaces(["/c", "/a", "/b"]);
    // SYNCHRONOUS — the optimistic publish the tab strip paints from. The
    // COMPETING ANSWER is a write-after-await implementation, which still answers
    // ["/a","/b","/c"] at this instant.
    expect(stripPaths()).toEqual(["/c", "/a", "/b"]);
    await done;
    // PATHS, verbatim. Sending ids or whole rows instead is a `{ ids }` wire key
    // against Rust's `paths` parameter — a runtime-only failure no Rust test and
    // no component test can see, which is why it is pinned at this boundary too.
    // Asserted AFTER the await on purpose: the write is CHAINED (D4), so the IPC
    // legitimately starts a microtask after the publish — the optimistic half
    // above is what has to be synchronous, not the call.
    expect(reorderSpacesCommand).toHaveBeenCalledWith(["/c", "/a", "/b"]);
    expect(stripPaths()).toEqual(["/c", "/a", "/b"]);
  });

  it("a rejected tab drag restores the PREVIOUS strip array (no refetch — see the doc)", async () => {
    useSessions.setState({
      spaces: [row("/a", 3000), row("/b", 2000), row("/c", 1000)],
    });
    const before = useSessions.getState().spaces;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(reorderSpacesCommand).mockRejectedValueOnce(new Error("boom"));
    // The `await` is the never-rejects proof (a rejecting action fails here on the
    // rejection, not on an assertion).
    await useSessions.getState().reorderSpaces(["/c", "/a", "/b"]);
    // TWO COMPETING ANSWERS: leaving the dragged order means the strip and the DB
    // disagree until a restart — and `removeSpace`'s leftmost-tab fallback then
    // lands on a tab the DB does not think is leftmost.
    expect(useSessions.getState().spaces).toBe(before);
    expect(stripPaths()).toEqual(["/a", "/b", "/c"]);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("reorder"),
      expect.anything(),
    );
    errSpy.mockRestore();
  });

  it("a Space the slice does not name is kept, at the BOTTOM (a tab added mid-drag is not dropped)", async () => {
    useSessions.setState({
      spaces: [row("/a", 3000), row("/b", 2000), row("/c", 1000)],
    });
    // As if `/b` had been opened mid-gesture, so the drag's slice predates it.
    // `/b` sits in the MIDDLE of the strip on purpose: seed it last and "keep its
    // index" and "go to the bottom" answer identically and the test certifies
    // nothing. THREE COMPETING ANSWERS:
    //  - a naive `paths.map(lookup)` answers ["/c","/a"] — a tab that VANISHES
    //    from the strip while its Space still exists is data loss in a UI costume;
    //  - splicing the named rows and leaving the unnamed one at its ORIGINAL index
    //    answers ["/c","/b","/a"];
    //  - the approved new-row rule answers ["/c","/a","/b"].
    await useSessions.getState().reorderSpaces(["/c", "/a"]);
    expect(stripPaths()).toEqual(["/c", "/a", "/b"]);
  });

  it("an unknown path in the slice is ignored, and an empty slice sends nothing", async () => {
    useSessions.setState({
      spaces: [row("/a", 3000), row("/b", 2000), row("/c", 1000)],
    });
    // The ghost cannot be rendered, so it is not inserted as `undefined`; the
    // slice still goes to the command verbatim (the store does not second-guess
    // what the call site can see).
    await useSessions.getState().reorderSpaces(["/ghost", "/a"]);
    expect(stripPaths()).toEqual(["/a", "/b", "/c"]);
    expect(reorderSpacesCommand).toHaveBeenCalledWith(["/ghost", "/a"]);

    await useSessions.getState().reorderSpaces([]);
    expect(reorderSpacesCommand).toHaveBeenCalledTimes(1);
    expect(stripPaths()).toEqual(["/a", "/b", "/c"]);
  });

  it("after a tab drag, closing the selected tab lands on the NEW leftmost tab (a neighbour means the user's neighbour)", async () => {
    // The ADR 0075 consequence, and the one place another action reads the array's
    // order. `/c` is the SELECTED tab because `removeSpace` answers its fallback
    // ONLY for the Space that was selected (`null` otherwise) — selecting anything
    // else here would make the test fail for the wrong reason.
    useSessions.setState({
      spaces: [row("/a", 3000), row("/b", 2000), row("/c", 1000)],
      activeSpacePath: "/c",
    });
    await useSessions.getState().reorderSpaces(["/c", "/b", "/a"]);
    expect(stripPaths()).toEqual(["/c", "/b", "/a"]);
    // `removeSpace`, not `closeSpace`: it RETURNS the fallback, which isolates the
    // ordering claim, while `closeSpace` additionally runs `selectSpace` →
    // `openSession` → a `loadHistory` IPC whose result could muddy an assertion
    // about position.
    const fallback = await useSessions.getState().removeSpace("/c");
    // TWO COMPETING ANSWERS: had the reorder been a no-op the strip would still be
    // ["/a","/b","/c"], and removing "/c" would leave ["/a","/b"] → leftmost
    // "/a". After a REAL drag it leaves ["/b","/a"] → leftmost "/b".
    // `removeSpace`'s rule is deliberately UNCHANGED by ADR 0075 ("the LEFTMOST
    // remaining tab"), so this is the pin that the rule now reads the user's
    // arrangement rather than a server-inferred recency.
    expect(fallback).toBe("/b");
  });

  it("a failed OLDER tab drag does not roll back a NEWER tab drag's strip (the publish epoch)", async () => {
    // The same rule as `reorderSessions`'s epoch test, on the other list: a
    // rollback IS a publish, so a stale one silently deletes the user's newer
    // move. TWO COMPETING ANSWERS: an unconditional rollback restores the
    // pre-FIRST array and erases the second drag; the epoch-checked one discards
    // the stale rollback and keeps ["/c","/b","/a"].
    useSessions.setState({
      spaces: [row("/a", 3000), row("/b", 2000), row("/c", 1000)],
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Two drags in one tick; the FIRST command fails, the second's lands.
    vi.mocked(reorderSpacesCommand).mockRejectedValueOnce(new Error("boom"));
    const first = useSessions.getState().reorderSpaces(["/b", "/a", "/c"]);
    const second = useSessions.getState().reorderSpaces(["/c", "/b", "/a"]);
    await Promise.all([first, second]);
    expect(stripPaths()).toEqual(["/c", "/b", "/a"]);
    errSpy.mockRestore();
  });

  it("two tab drags whose commands BOTH fail restore the strip the DATABASE holds, not the first drag's", async () => {
    // The spaces half of the same defect, on the list whose rows carry their
    // position IN THE ARRAY. TWO COMPETING ANSWERS:
    //  - the bug answers ["/b","/a","/c"]: the SECOND drag snapshots the strip for
    //    its rollback from the store, which then already holds the FIRST drag's
    //    optimistic, never-committed order, and the epoch guard correctly discards
    //    the first drag's own rollback — so the tab strip ends on an arrangement
    //    `reorder_spaces` never wrote, and `removeSpace`'s leftmost-tab fallback
    //    then lands on a tab the DB does not think is leftmost;
    //  - the committed baseline answers ["/a","/b","/c"], what `list_spaces` still
    //    returns, because BOTH commands failed.
    // Seeded through `setSpaces` — the boot path that installs the DB's rows, i.e.
    // the last thing the store knows the database said.
    useSessions.getState().setSpaces([
      row("/a", 3000),
      row("/b", 2000),
      row("/c", 1000),
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // BOTH commands reject (every call, not just the first).
    vi.mocked(reorderSpacesCommand).mockRejectedValue(new Error("boom"));
    const first = useSessions.getState().reorderSpaces(["/b", "/a", "/c"]);
    const second = useSessions.getState().reorderSpaces(["/c", "/b", "/a"]);
    await Promise.all([first, second]);
    expect(stripPaths()).toEqual(["/a", "/b", "/c"]);
    // The rows themselves survived — the rollback restores the committed ARRAY, it
    // does not rebuild rows out of the drag's slice.
    expect(useSessions.getState().spaces).toEqual([
      row("/a", 3000),
      row("/b", 2000),
      row("/c", 1000),
    ]);
    expect(reorderSpacesCommand).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });

  it("two tab drags in one list reach the database in DRAG ORDER (the chain)", async () => {
    // The spaces half of the sessions chain pin, for the same reason: D4 says the
    // command rewrites a WHOLE slice, so two overlapping writes to the `spaces`
    // table have no order without a chain, and the DB could settle on the OLDER
    // drag. Without the chain both commands start as soon as they are called.
    useSessions.setState({
      spaces: [row("/a", 3000), row("/b", 2000), row("/c", 1000)],
    });
    let releaseFirst: () => void = () => {};
    const firstCommand = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(reorderSpacesCommand).mockImplementationOnce(() => firstCommand);

    const first = useSessions.getState().reorderSpaces(["/b", "/a", "/c"]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reorderSpacesCommand).toHaveBeenCalledTimes(1);

    const second = useSessions.getState().reorderSpaces(["/c", "/b", "/a"]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // THE DISCRIMINATING ASSERTION: the second command has not even started.
    expect(reorderSpacesCommand).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(reorderSpacesCommand).toHaveBeenNthCalledWith(1, ["/b", "/a", "/c"]);
    expect(reorderSpacesCommand).toHaveBeenNthCalledWith(2, ["/c", "/b", "/a"]);
    expect(stripPaths()).toEqual(["/c", "/b", "/a"]);
  });
});
