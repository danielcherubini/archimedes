import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import NewSessionErrorBanner from "./NewSessionErrorBanner";
import { startSession } from "../lib/tauri";
import { useSessions } from "../store/sessions";

// The banner reads ONE store field, but importing the store pulls in the IPC
// module, whose real `invoke` does not exist in jsdom. The `importActual`
// pattern from `SessionStalledBanner.test.tsx`.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    startSession: vi.fn().mockResolvedValue({
      sessionId: "new1",
      cwd: "/tmp/ws",
      capabilities: {},
      archived: false,
    }),
    loadHistory: vi.fn().mockResolvedValue({ rows: [], hasMore: false, todos: null }),
  };
});

const row = (path: string) => ({
  path,
  createdAt: 0,
  lastOpenedAt: 1,
  trusted: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  useSessions.setState({
    newSessionError: null,
    activeSessionId: null,
    spaces: [row("/tmp/alpha")],
    activeSpacePath: "/tmp/alpha",
  });
  vi.mocked(startSession).mockRejectedValue("no such folder");
});

describe("NewSessionErrorBanner (the view-independent reason for a failed start)", () => {
  it("renders NOTHING while the last attempt did not fail", () => {
    render(<NewSessionErrorBanner />);
    expect(screen.queryByTestId("new-session-error")).toBeNull();
  });

  it("names the command's message once the store carries one", () => {
    useSessions.setState({ newSessionError: "no such folder" });
    render(<NewSessionErrorBanner />);
    // `role="alert"` — the same live-region contract `SessionStalledBanner`
    // uses, because nothing else about the UI changed when this failed.
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/no such folder/)).toBeTruthy();
  });

  it("shows the failure produced by the REAL command, not only a hand-seeded field", async () => {
    // The end-to-end half of the claim: the store's own catch is what lights
    // this up, so a renamed field or a dropped `set` reddens this rather than
    // leaving a component that renders a value nothing writes.
    render(<NewSessionErrorBanner />);
    await act(async () => {
      await useSessions.getState().startSessionInActiveSpace();
    });
    expect(screen.getByTestId("new-session-error")).toBeTruthy();
    expect(screen.getByText(/no such folder/)).toBeTruthy();
  });

  it("dismissal HIDES the notice without clearing the store's reason", () => {
    // The field is ALSO the sidebar actions-menu trigger's `title`
    // (`SpacesList`), and its contract says it is cleared only by the reset at
    // the top of the next run. Clearing it from a dismiss button would let one
    // surface's housekeeping un-inform another, so dismissal is local.
    useSessions.setState({ newSessionError: "no such folder" });
    render(<NewSessionErrorBanner />);
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss new-session error" }),
    );
    expect(screen.queryByTestId("new-session-error")).toBeNull();
    expect(useSessions.getState().newSessionError).toBe("no such folder");
  });

  it("a RETRIED failure re-arms the notice even when the message is identical", async () => {
    // The trap this component's shape exists to avoid. It is mounted at `App`
    // root, so it never remounts and never gets the fresh local state a
    // session-scoped banner gets for free: a plain boolean (or a
    // dismissal-keyed-on-message) would let one click swallow every later
    // failure, including this one — reintroducing the silent failure the banner
    // was added to close. The action clears the field before it can fail again,
    // and that clear is what re-arms the notice.
    render(<NewSessionErrorBanner />);
    await act(async () => {
      await useSessions.getState().startSessionInActiveSpace();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss new-session error" }),
    );
    expect(screen.queryByTestId("new-session-error")).toBeNull();
    await act(async () => {
      await useSessions.getState().startSessionInActiveSpace();
    });
    expect(screen.getByText(/no such folder/)).toBeTruthy();
  });

  it("a dismissed notice with no new attempt stays dismissed (no nagging, no re-show on its own)", () => {
    // The other half of the rule: re-arming is driven by the store's per-run
    // clear, not by a timer or a re-render, so a dismissed user is left alone
    // until they actually try again.
    useSessions.setState({ newSessionError: "no such folder" });
    render(<NewSessionErrorBanner />);
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss new-session error" }),
    );
    // A re-render with the SAME message (the field never cleared) must not
    // resurrect it.
    useSessions.setState({ activeSpacePath: "/tmp/alpha" });
    expect(screen.queryByTestId("new-session-error")).toBeNull();
  });
});
