import { describe, expect, expectTypeOf, it } from "vitest";
import {
  asRequestId,
  asSessionId,
  type RequestId,
  type SessionId,
} from "./ids";

describe("branded id utilities", () => {
  it("returns identical string at runtime for asSessionId", () => {
    const raw = "session-123";
    const sessionId = asSessionId(raw);
    expect(sessionId).toBe(raw);
  });

  it("returns identical string at runtime for asRequestId", () => {
    const raw = "req-456";
    const requestId = asRequestId(raw);
    expect(requestId).toBe(raw);
  });

  it("allows branded types to be assignable to plain string", () => {
    const sessionId = asSessionId("session-abc");
    const requestId = asRequestId("req-xyz");

    const strFromSession: string = sessionId;
    const strFromRequest: string = requestId;

    expect(strFromSession).toBe("session-abc");
    expect(strFromRequest).toBe("req-xyz");
    expectTypeOf(sessionId).toBeString();
    expectTypeOf(requestId).toBeString();
  });

  it("proves SessionId and RequestId have distinct brands and are not interchangeable", () => {
    expectTypeOf<SessionId>().not.toBeNever();
    expectTypeOf<RequestId>().not.toBeNever();
    expectTypeOf<SessionId>().not.toEqualTypeOf<RequestId>();

    // Verify SessionId cannot be assigned to RequestId and vice versa
    expectTypeOf<SessionId>().not.toMatchTypeOf<RequestId>();
    expectTypeOf<RequestId>().not.toMatchTypeOf<SessionId>();
  });
});
