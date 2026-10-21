import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { onSessionClosed } from "./sessionLifecycle";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useQueuedPrompts } from "../store/queuedPrompts";
import type { ChatComposerAttachment } from "./chatAttachments";
import * as sessionsModule from "../store/sessions";

// `deleteSession` (the store action) calls the IPC wrapper, which would
// `invoke()` and reject in jsdom — no global Tauri mock exists. Everything
// else in `../lib/tauri` stays REAL (the close-path tests read no IPC).
vi.mock("./tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./tauri");
  return { ...actual, deleteSession: vi.fn().mockResolvedValue(undefined) };
});

/**
 * Attachment URLs are released through `URL.revokeObjectURL`. Node/jsdom's
 * real implementation accepts any string and does nothing, so an assertion on
 * it would be unprovable without these stubs (the `chatAttachments.test.ts`
 * shape).
 */
beforeAll(() => {
  URL.createObjectURL = vi.fn((file: File) => `blob:mock-${file.name}`);
  URL.revokeObjectURL = vi.fn();
});

function attachment(id: string, name: string): ChatComposerAttachment {
  const file = new File(["x"], name, { type: "image/png" });
  return {
    id,
    file,
    filename: file.name,
    mimeType: "image/png",
    sizeBytes: file.size,
    objectUrl: `blob:mock-${name}`,
  };
}

describe("onSessionClosed", () => {
  it("dismisses state deterministically across stores in order", () => {
    const callOrder: string[] = [];

    const dismissInteractiveSpy = vi
      .spyOn(useInteractive.getState(), "dismissSession")
      .mockImplementation((id: string) => {
        callOrder.push(`interactive.dismissSession:${id}`);
      });

    const dismissPermissionsSpy = vi
      .spyOn(usePermissions.getState(), "dismissSessionPrompts")
      .mockImplementation((id: string) => {
        callOrder.push(`permissions.dismissSessionPrompts:${id}`);
      });

    const handleSessionClosedSpy = vi
      .spyOn(sessionsModule.useSessions.getState(), "handleSessionClosed")
      .mockImplementation((id: string, reason: string) => {
        callOrder.push(`sessions.handleSessionClosed:${id}:${reason}`);
      });

    const discardSessionMessagesSpy = vi
      .spyOn(sessionsModule, "discardSessionMessages")
      .mockImplementation((id: string) => {
        callOrder.push(`sessions.discardSessionMessages:${id}`);
      });

    onSessionClosed("test-session-123", "user");

    expect(callOrder).toEqual([
      "interactive.dismissSession:test-session-123",
      "permissions.dismissSessionPrompts:test-session-123",
      "sessions.handleSessionClosed:test-session-123:user",
      "sessions.discardSessionMessages:test-session-123",
    ]);

    expect(dismissInteractiveSpy).toHaveBeenCalledWith("test-session-123");
    expect(dismissPermissionsSpy).toHaveBeenCalledWith("test-session-123");
    expect(handleSessionClosedSpy).toHaveBeenCalledWith("test-session-123", "user");
    expect(discardSessionMessagesSpy).toHaveBeenCalledWith("test-session-123");

    dismissInteractiveSpy.mockRestore();
    dismissPermissionsSpy.mockRestore();
    handleSessionClosedSpy.mockRestore();
    discardSessionMessagesSpy.mockRestore();
  });

  it("preserves todos in useInteractive when closing a session", () => {
    const sessionId = "test-session-todos";
    const initialTodos = [
      { content: "Task A", status: "pending" as const },
      { content: "Task B", status: "completed" as const },
    ];
    useInteractive.getState().applyTodoUpdate(sessionId, { todos: initialTodos });
    expect(useInteractive.getState().todos[sessionId]).toEqual(initialTodos);

    onSessionClosed(sessionId, "user");

    expect(useInteractive.getState().todos[sessionId]).toEqual(initialTodos);
  });
});

describe("prompt queue cleanup (ADR 0069)", () => {
  // The queue store is a module singleton — drop everything a previous test
  // (or the tests above) left behind, and count revokes from zero.
  beforeEach(() => {
    for (const id of Object.keys(useQueuedPrompts.getState().bySession)) {
      useQueuedPrompts.getState().clearSession(id);
    }
    (URL.revokeObjectURL as Mock).mockClear();
  });

  function seedS1() {
    useQueuedPrompts.getState().enqueue("s1", {
      id: "p1",
      text: "queued without attachments",
      attachments: [],
      state: "queued",
    });
    useQueuedPrompts.getState().enqueue("s1", {
      id: "p2",
      text: "queued with an attachment",
      attachments: [attachment("a2", "queued.png")],
      state: "queued",
    });
    // A different Session's queue must survive untouched.
    useQueuedPrompts.getState().enqueue("s2", {
      id: "p3",
      text: "another session",
      attachments: [],
      state: "queued",
    });
  }

  it("onSessionClosed empties the Session's queue and releases its attachments", () => {
    seedS1();
    expect(useQueuedPrompts.getState().bySession["s1"]).toHaveLength(2);

    onSessionClosed("s1", "user");

    expect("s1" in useQueuedPrompts.getState().bySession).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-queued.png");
    expect(useQueuedPrompts.getState().bySession["s2"]).toHaveLength(1);
  });

  it("deleteSession empties the Session's queue and releases its attachments", async () => {
    seedS1();

    await sessionsModule.useSessions.getState().deleteSession("s1");

    expect("s1" in useQueuedPrompts.getState().bySession).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-queued.png");
    expect(useQueuedPrompts.getState().bySession["s2"]).toHaveLength(1);
  });
});
