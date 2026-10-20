import { describe, expect, it, vi } from "vitest";
import { onSessionClosed } from "./sessionLifecycle";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import * as sessionsModule from "../store/sessions";

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
