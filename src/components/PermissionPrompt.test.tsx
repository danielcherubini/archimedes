import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import PermissionPrompt from "./PermissionPrompt";
import { usePermissions } from "../store/permissions";
import { resetStores } from "../test/resetStores";

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    respondPermission: vi.fn().mockResolvedValue(undefined),
  };
});

import { respondPermission } from "../lib/tauri";

const mockedRespond = vi.mocked(respondPermission);

const request = {
  toolCall: { toolCallId: "tc1", title: "run a tool" },
  options: [
    { optionId: "opt-1", name: "Allow", kind: "allow_once" },
    { optionId: "opt-2", name: "Deny", kind: "reject_once" },
  ],
};

describe("PermissionPrompt", () => {
  beforeEach(() => {
    // Every store back to its own initial state. The hand-written version was
    // `usePermissions.getState().dismissSessionPrompts("s1")`, which cleared ONE
    // session's prompts and left every other store key standing.
    resetStores();
    mockedRespond.mockReset();
    mockedRespond.mockResolvedValue(undefined);
  });

  it("renders the tool title and every offered option", () => {
    usePermissions.getState().addPrompt("s1", "r1", request);
    render(<PermissionPrompt sessionId="s1" requestId="r1" />);
    expect(screen.getByText("run a tool")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("renders the confirmation treatment with one button per option + Cancel", () => {
    usePermissions.getState().addPrompt("s1", "r1", request);
    const { container } = render(
      <PermissionPrompt sessionId="s1" requestId="r1" />,
    );
    // The green confirmation treatment: a `bg-interaction-confirmation-surface`
    // header strip with the tool name in the confirmation foreground.
    const header = container.querySelector(
      ".bg-interaction-confirmation-surface",
    )!;
    expect(header).toBeTruthy();
    const title = header.querySelector(
      ".text-interaction-confirmation-foreground",
    )!;
    expect(title.textContent).toContain("run a tool");
    // The footer renders ONE button per fixture option (the fixture has 2)
    // + a Cancel button.
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("renders nothing when no prompt is pending for the request id", () => {
    const { container } = render(
      <PermissionPrompt sessionId="s1" requestId="missing" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("calls respondPermission with the selected option id", async () => {
    usePermissions.getState().addPrompt("s1", "r1", request);
    render(<PermissionPrompt sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(mockedRespond).toHaveBeenCalledTimes(1));
    // THE backward-compatibility pin (permissions-section acceptance criterion
    // 2): a STRICT structural compare on the raw third argument, NOT
    // `toHaveBeenCalledWith` — asymmetric equality would stay green if the
    // payload picked up a stray `value` key (even `value: undefined`), which is
    // precisely the regression this test exists to catch. An option WITHOUT
    // `path` must emit the OLD payload shape: no `value` key at all.
    expect(mockedRespond.mock.calls[0]?.[2]).toStrictEqual({
      selected: { option_id: "opt-1" },
    });
  });

  it("sends the second option id when a different option is chosen", async () => {
    usePermissions.getState().addPrompt("s1", "r1", request);
    render(<PermissionPrompt sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(mockedRespond).toHaveBeenCalledTimes(1));
    // The second half of the backward-compatibility pin (see the test above):
    // strict compare, no `value` key for a `path`-less option.
    expect(mockedRespond.mock.calls[0]?.[2]).toStrictEqual({
      selected: { option_id: "opt-2" },
    });
  });

  it("renders one button per option for the 3-option guard payload and echoes the allow-directory path back as value (guard)", async () => {
    // The guard prompt's option list is PER-PROMPT (permissions-section spec):
    // `allow` / `allow-directory` / `reject`, and `trust-space` is DELIBERATELY
    // ABSENT — the spec removes that shortcut from the guard's own prompt (the
    // prompt that protects the agent's instructions must not carry a one-click
    // permanent way to disable it). The component stays generic — one button per
    // option, first = primary, the rest = outline, no hardcoded count — so this
    // fixture proves the generic renderer absorbs the new ids AND the `value`
    // echo with ZERO layout work.
    usePermissions.getState().addPrompt("s1", "r2", {
      toolCall: { toolCallId: "tc2", title: "run a tool" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow" },
        {
          optionId: "allow-directory",
          name: "Always allow this directory",
          path: "~/.pi/agent",
          kind: "allow",
        },
        { optionId: "reject", name: "Block", kind: "reject" },
      ],
    });
    const { container } = render(
      <PermissionPrompt sessionId="s1" requestId="r2" />,
    );
    // All three option buttons render with the payload's names, plus Cancel.
    // Container-scoped for the collidable "Allow" (the shared boundary fixture
    // above seeds an option with the same name; a page-wide query would be one
    // render away from an ambiguity).
    expect(within(container).getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Block" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Always allow this directory" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    // First option is primary, the rest (incl. allow-directory) are outline.
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(4);
    expect(buttons[0].className).toContain("bg-primary");
    expect(buttons[1].className).toContain("border-border");
    expect(buttons[2].className).toContain("border-border");
    // Clicking the option that carries `path` answers with its option id AND
    // echoes the path back as `value` — the wire shape is
    // `{ selected: { option_id, value } }`.
    fireEvent.click(
      screen.getByRole("button", { name: "Always allow this directory" }),
    );
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r2", {
        selected: { option_id: "allow-directory", value: "~/.pi/agent" },
      }),
    );
  });

  it("cancels via the Cancel button", async () => {
    usePermissions.getState().addPrompt("s1", "r1", request);
    render(<PermissionPrompt sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", "cancelled"),
    );
  });

  it("removes the prompt from the store after answering", async () => {
    usePermissions.getState().addPrompt("s1", "r1", request);
    render(<PermissionPrompt sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(usePermissions.getState().prompts["s1"]).toHaveLength(0),
    );
  });

  it("announces a failed answer through role=\"alert\" with the pre-migration classes", async () => {
    // Task C3 (finding 7): the failure line used to be a bare `<p>` with
    // `text-destructive`, so a screen-reader user clicked Allow and heard
    // NOTHING when the answer was rejected. `IpcErrorLine` adds the live
    // region; the class string must stay byte-identical so nothing about the
    // card's spacing moves.
    usePermissions.getState().addPrompt("s1", "r1", request);
    mockedRespond.mockRejectedValueOnce("respond-permission failed");
    render(<PermissionPrompt sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("respond-permission failed");
    // Byte-identical to the hand-written `px-3 pb-2 text-ui-sm text-destructive`
    // line this replaced (`cn` reorders; it drops nothing).
    expect(alert.getAttribute("class")).toBe(
      "text-ui-sm text-destructive px-3 pb-2",
    );
    // And the prompt is NOT removed on failure — the card stays answerable.
    expect(usePermissions.getState().prompts["s1"]).toHaveLength(1);
  });

  it("renders no alert region while nothing has failed", () => {
    usePermissions.getState().addPrompt("s1", "r1", request);
    render(<PermissionPrompt sessionId="s1" requestId="r1" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("applies min-w-0 and [overflow-wrap:anywhere] to option buttons / container to handle long text gracefully", () => {
    usePermissions.getState().addPrompt("s1", "r1", request);
    render(<PermissionPrompt sessionId="s1" requestId="r1" />);
    const buttonGroup = screen.getByTestId("permission-options-row");
    expect(buttonGroup.className).toContain("min-w-0");
    const optionButton = screen.getByRole("button", { name: "Allow" });
    expect(optionButton.className).toContain("min-w-0");
    expect(optionButton.className).toContain("[overflow-wrap:anywhere]");
    expect(optionButton.className).not.toContain("break-words");
  });
});
