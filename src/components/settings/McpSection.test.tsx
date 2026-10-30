import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import McpSection from "./McpSection";
import { authMcpServer, testMcpServer, type AppSettings } from "@/lib/tauri";

// The `WebSearchSection.test.tsx` pattern: module-path mock of the barrel,
// spreading `importActual` so the value imports (`describeIpcError` rides in
// through `McpSection.tsx`'s direct `@/lib/ipcError` import, untouched) keep
// working, and overriding ONLY the two MCP commands this section calls.
vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    testMcpServer: vi.fn(),
    authMcpServer: vi.fn(),
  };
});

const mockedTest = vi.mocked(testMcpServer);
const mockedAuth = vi.mocked(authMcpServer);

/** The section's fixture: one OAuth HTTP entry + one plain HTTP entry. */
const settings: AppSettings = {
  theme: "dark",
  palette: null,
  paneLayout: {},
  defaultTrustNewSpaces: false,
  defaultModel: null,
  defaultThinkingLevel: null,
  enabledTools: [],
  providers: [],
  mcpServers: {
    oauth_srv: { url: "https://auth.example/mcp", auth: "oauth" },
    plain: { url: "https://plain.example/mcp" },
  },
  font: { sizePx: 14, uiFamily: null, codeFamily: null },
  defaultThinkingLevels: {},
  agentOverrides: {},
  spinnerStyle: null,
  emptyStateAnimation: null,
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
};

/** Render the section standalone — pure props, no store, no boot. */
function renderSection(): void {
  render(
    <McpSection
      settings={settings}
      dialog={null}
      setDialog={vi.fn()}
      onSave={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
}

/** Click the row's Test button and wait for the test to have been called. */
async function clickTest(name: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: `Test MCP server ${name}` }));
  await vi.waitFor(() => expect(mockedTest).toHaveBeenCalled());
}

beforeEach(() => {
  mockedTest.mockReset();
  mockedAuth.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("McpSection (the MCP rows, ADR 0019)", () => {
  it("a successful test shows the tool count (the green contract)", async () => {
    mockedTest.mockResolvedValue(3);
    renderSection();
    await clickTest("plain");
    expect(await screen.findByText("3 tools")).toBeTruthy();
    // The one-shot test passes the entry as saved + the name (the page-level
    // pin lives in SettingsPage.test.tsx; this one proves the standalone mock
    // machinery drives the real row).
    expect(mockedTest).toHaveBeenCalledWith(
      { url: "https://plain.example/mcp" },
      "plain",
    );
  });

  it("a generic envelope failure shows the error badge and no Sign-in button", async () => {
    // The honest wire shape: test_mcp_server rejects with the SettingsError
    // envelope, `kind` mcp_test_failed, the sentence from Rust verbatim.
    mockedTest.mockRejectedValue({
      kind: "mcp_test_failed",
      message: "MCP server test failed: connect timed out",
    });
    renderSection();
    await clickTest("plain");
    expect(await screen.findByText("error")).toBeTruthy();
    // `plain` is not an OAuth entry and the sentence carries no auth marker —
    // the Sign-in button must NOT appear for it.
    expect(
      screen.queryByRole("button", { name: "Authenticate MCP server plain" }),
    ).toBeNull();
  });

  it("the CURRENT needs-auth contract: the marker inside the sentence shows the badge + Sign-in", async () => {
    // Today's truth, pinned: the 401-on-OAuth test rejects with the envelope
    // whose message is "MCP server test failed: needs-auth" (the thiserror
    // sentence around the raw marker `manager::test_server` propagates), and
    // McpSection decides on `error.includes("needs-auth")`. The badge reads
    // "needs auth" and the Sign-in button is offered.
    mockedTest.mockRejectedValue({
      kind: "mcp_test_failed",
      message: "MCP server test failed: needs-auth",
    });
    renderSection();
    await clickTest("oauth_srv");
    expect(await screen.findByText("needs auth")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Authenticate MCP server oauth_srv" }),
    ).toBeTruthy();
  });

  // blocked-on-task14/14c: SettingsError needs an auth kind (candidate
  // "needs_auth"); the wire today produces only "mcp_test_failed".
  //
  // This case was OBSERVED RED before it was parked (run first, no component
  // change): `TestingLibraryElementError: Unable to find an element with the
  // text: needs auth` — the badge reads "error", not "needs auth", because the
  // component discriminates on the SENTENCE (`includes("needs-auth")`) and
  // `kind` is
  // always `mcp_test_failed` — the envelope carries no machine discriminator
  // to switch on (the exhaustive-switch design is spec'd in the task14b plan;
  // it cannot be green until the Rust side adds the kind). A reword of the
  // Rust sentence therefore breaks this badge silently while the envelope
  // stays valid. Unblocking: task14/14c adds the SettingsError auth kind
  // (produced in commands/settings.rs by matching test_server's raw
  // "needs-auth" marker before the McpTestFailed wrap); then McpSection
  // branches on `kind` (the parked design), McpTestErrorKind in @/lib/errors
  // gains the frozen spelling, and this case un-skips green.
  it.skip("a reworded needs-auth sentence still shows the badge (the envelope-contract red-first)", async () => {
    // The ensure_connected-style reworded sentence (the agent path's wording)
    // inside a VALID envelope with a STABLE kind: the decision must ride the
    // machine discriminator, never the sentence.
    mockedTest.mockRejectedValue({
      kind: "mcp_test_failed",
      message:
        "MCP server test failed: the server requires authentication (use the `auth` action)",
    });
    renderSection();
    await clickTest("oauth_srv");
    expect(await screen.findByText("needs auth")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Authenticate MCP server oauth_srv" }),
    ).toBeTruthy();
  });
});
