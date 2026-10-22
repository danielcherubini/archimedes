import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", {
        selected: { option_id: "opt-1" },
      }),
    );
  });

  it("sends the second option id when a different option is chosen", async () => {
    usePermissions.getState().addPrompt("s1", "r1", request);
    render(<PermissionPrompt sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", {
        selected: { option_id: "opt-2" },
      }),
    );
  });

  it("renders one button per option for the 3-option trusted-space payload (guard)", async () => {
    // The Rust side (Task 2) appends a third `trust-space` option to the
    // permission payload. The component is generic — one button per option,
    // first = primary, the rest = outline — so the third option must appear
    // with ZERO component changes. This guard pins that assumption.
    usePermissions.getState().addPrompt("s1", "r2", {
      toolCall: { toolCallId: "tc2", title: "run a tool" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow" },
        { optionId: "reject", name: "Block", kind: "reject" },
        {
          optionId: "trust-space",
          name: "Don't ask again for this Space",
          kind: "allow",
        },
      ],
    });
    const { container } = render(
      <PermissionPrompt sessionId="s1" requestId="r2" />,
    );
    // All three option buttons render with the payload's names, plus Cancel.
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Block" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Don't ask again for this Space" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    // First option is primary, the rest (incl. trust-space) are outline.
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(4);
    expect(buttons[0].className).toContain("bg-primary");
    expect(buttons[1].className).toContain("border-border");
    expect(buttons[2].className).toContain("border-border");
    // Clicking the third option answers with its option id.
    fireEvent.click(
      screen.getByRole("button", { name: "Don't ask again for this Space" }),
    );
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r2", {
        selected: { option_id: "trust-space" },
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
