import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import OpenAnchor from "./OpenAnchor";
import { SpaceCwdProvider, useSpaceCwd } from "./SpaceCwd";
import { externalOpen } from "../lib/tauri";

// The IPC boundary: `externalOpen` is the only thing this component does, and
// the real one would `invoke` Tauri, which doesn't exist in jsdom.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return { ...actual, externalOpen: vi.fn().mockResolvedValue(undefined) };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OpenAnchor", () => {
  it("External-opens the href with the cwd from the SpaceCwd provider", () => {
    render(
      <SpaceCwdProvider cwd="/home/u/proj">
        <OpenAnchor href="src/main.rs">m</OpenAnchor>
      </SpaceCwdProvider>,
    );
    fireEvent.click(screen.getByText("m"));
    expect(externalOpen).toHaveBeenCalledTimes(1);
    expect(externalOpen).toHaveBeenCalledWith("src/main.rs", "/home/u/proj");
  });

  it("passes a null cwd when no provider is mounted (external_open refuses it)", () => {
    render(<OpenAnchor href="src/main.rs">m</OpenAnchor>);
    fireEvent.click(screen.getByText("m"));
    expect(externalOpen).toHaveBeenCalledTimes(1);
    expect(externalOpen).toHaveBeenCalledWith("src/main.rs", null);
  });

  it("keeps the href on the element (hover, focus, copy-link still work)", () => {
    render(
      <SpaceCwdProvider cwd="/tmp">
        <OpenAnchor href="https://x.test" className="text-link">
          doc
        </OpenAnchor>
      </SpaceCwdProvider>,
    );
    const anchor = screen.getByText("doc");
    expect(anchor.getAttribute("href")).toBe("https://x.test");
    expect(anchor.getAttribute("class")).toBe("text-link");
    expect(anchor.hasAttribute("target")).toBe(false);
    expect(anchor.hasAttribute("rel")).toBe(false);
  });

  it("cancels the default navigation", () => {
    const seen: boolean[] = [];
    const spy = (e: React.MouseEvent) => seen.push(e.defaultPrevented);
    render(
      <div onClick={spy}>
        <OpenAnchor href="https://x.test">doc</OpenAnchor>
      </div>,
    );
    const anchor = screen.getByText("doc");
    const notCancelled = anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(notCancelled).toBe(false);
    // The parent sees the SAME React synthetic event, already cancelled.
    expect(seen).toEqual([true]);
  });

  it("intercepts modifier-clicks too — the Client has no new tab", () => {
    render(
      <SpaceCwdProvider cwd="/tmp">
        <OpenAnchor href="https://x.test">doc</OpenAnchor>
      </SpaceCwdProvider>,
    );
    const anchor = screen.getByText("doc");
    fireEvent.click(anchor, { ctrlKey: true });
    fireEvent.click(anchor, { metaKey: true });
    fireEvent.click(anchor, { shiftKey: true });
    expect(externalOpen).toHaveBeenCalledTimes(3);
  });

  it("owns no mousedown/auxclick handler (Enter rides click; middle click rides the navigation guard)", () => {
    render(
      <SpaceCwdProvider cwd="/tmp">
        <OpenAnchor href="docs/a.md">a</OpenAnchor>
      </SpaceCwdProvider>,
    );
    const anchor = screen.getByText("a");
    fireEvent.mouseDown(anchor);
    anchor.dispatchEvent(
      new MouseEvent("auxclick", { bubbles: true, cancelable: true }),
    );
    fireEvent.keyDown(anchor, { key: "Enter" });
    expect(externalOpen).not.toHaveBeenCalled();
  });
});

describe("useSpaceCwd", () => {
  function Probe(): ReactElement {
    return <span data-testid="probe">{String(useSpaceCwd())}</span>;
  }

  it("returns null with no provider, rather than throwing", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("null");
  });

  it("returns the provider's cwd, including an explicit null", () => {
    const { unmount } = render(
      <SpaceCwdProvider cwd="/home/u/proj">
        <Probe />
      </SpaceCwdProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("/home/u/proj");
    unmount();
    render(
      <SpaceCwdProvider cwd={null}>
        <Probe />
      </SpaceCwdProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("null");
  });
});
