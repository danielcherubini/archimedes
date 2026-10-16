import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import ToolCallCard from "./ToolCallCard";
import { SpaceCwdProvider } from "./SpaceCwd";
import { externalOpen } from "../lib/tauri";
import {
  summarizeToolCall,
  normalizeToolOutput,
} from "../lib/toolOutput";
import * as toolOutput from "../lib/toolOutput";

// The IPC boundary: `externalOpen` is what a clickable chip and a linkified
// output URL call, and the real one would `invoke` Tauri, which does not exist
// in jsdom. The `importActual` SPREAD is required, not a factory-only mock:
// this component reaches `../lib/tauri` transitively through the stores, and a
// factory would blank the exports they need.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return { ...actual, externalOpen: vi.fn() };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("summarizeToolCall", () => {
  it("summarizes bash by its command", () => {
    expect(summarizeToolCall("bash", { command: "ls -la" })).toBe("ls -la");
  });
  it("summarizes read by path + line range when offset/limit present", () => {
    expect(
      summarizeToolCall("read", { path: "src/a.ts", offset: 5, limit: 50 }),
    ).toBe("src/a.ts (L5–54)");
  });
  it("summarizes read by path alone when no offset/limit", () => {
    expect(summarizeToolCall("read", { path: "src/a.ts" })).toBe("src/a.ts");
  });
  it("falls back to compact JSON for an unknown tool", () => {
    expect(summarizeToolCall("mystery_tool", { a: 1 })).toBe('{"a":1}');
  });
  it("returns undefined for empty or missing input", () => {
    expect(summarizeToolCall("mystery_tool", {})).toBeUndefined();
    expect(summarizeToolCall("mystery_tool", undefined)).toBeUndefined();
  });
});

describe("normalizeToolOutput", () => {
  it("joins text items of an AgentToolResult content array", () => {
    expect(
      normalizeToolOutput({
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
      }),
    ).toBe("line1\nline2");
  });
  it("counts image items", () => {
    expect(
      normalizeToolOutput({
        content: [
          { type: "text", text: "t" },
          { type: "image" },
          { type: "image" },
        ],
      }),
    ).toBe("t\n(+2 images)");
  });
  it("shows a bare string as-is", () => {
    expect(normalizeToolOutput("world")).toBe("world");
  });
  it("falls back to details JSON when there is no text", () => {
    expect(normalizeToolOutput({ content: [], details: { todos: [] } })).toBe(
      '{"todos":[]}',
    );
  });
  it("returns undefined for nothing showable", () => {
    expect(normalizeToolOutput(undefined)).toBeUndefined();
    expect(normalizeToolOutput({})).toBeUndefined();
  });
  it("treats an empty text item as no output (no metadata fallback)", () => {
    // e.g. a successful sudo_exec with empty stdout: an empty text item
    // plus command metadata in details.
    expect(
      normalizeToolOutput({
        content: [{ type: "text", text: "" }],
        details: { command: "true", exitCode: 0 },
      }),
    ).toBeUndefined();
  });
  it("falls back to details for a FAILED call with empty text", () => {
    // A failed/timed-out sudo_exec has an empty text item and puts the
    // failure reason in details — the expanded card must show it.
    expect(
      normalizeToolOutput(
        {
          content: [{ type: "text", text: "" }],
          details: { command: "true", error: "timed out after 120s" },
        },
        true,
      ),
    ).toBe('{"command":"true","error":"timed out after 120s"}');
  });
});

describe("ToolCallCard (rendering)", () => {
  it("renders the verb + command for a known tool", () => {
    render(
      <ToolCallCard
        title="bash"
        status="completed"
        rawInput={{ command: "ls -la" }}
      />,
    );
    expect(screen.getByText("Ran")).toBeTruthy();
    expect(screen.getByText("ls -la")).toBeTruthy();
  });
  it("shows the running verb with the shimmer while pending", () => {
    const { container } = render(
      <ToolCallCard
        title="bash"
        status="pending"
        rawInput={{ command: "ls" }}
      />,
    );
    expect(screen.getByText("Running")).toBeTruthy();
    expect(container.querySelector(".animated-gradient-text")).not.toBeNull();
  });
  it("shows the raw title for an unknown tool", () => {
    render(
      <ToolCallCard
        title="mystery_tool"
        status="completed"
        rawInput={{ a: 1 }}
      />,
    );
    expect(screen.getByText("mystery_tool")).toBeTruthy();
  });
  it("renders a file chip for read (basename + language icon)", () => {
    render(
      <ToolCallCard
        title="read"
        status="completed"
        rawInput={{ path: "/a/b/c.ts" }}
      />,
    );
    expect(screen.getByText("c.ts")).toBeTruthy();
    expect(
      screen.getByText("c.ts").closest("span[title]")?.getAttribute("title"),
    ).toBe("/a/b/c.ts");
  });
  it("renders edit change stats", () => {
    const { container } = render(
      <ToolCallCard
        title="edit"
        status="completed"
        rawInput={{
          path: "/a/b/c.ts",
          edits: [{ oldText: "a\nb", newText: "x\ny\nz" }],
        }}
      />,
    );
    // `DiffCount` renders `+` and the number in separate nested elements (the
    // `FlipMetricValue` span), so `getByText("+3")` can never match — use
    // `textContent`.
    expect(container.textContent).toContain("+3");
    expect(container.textContent).toContain("-2");
  });
  it("renders the read line range next to the file chip", () => {
    render(
      <ToolCallCard
        title="read"
        status="completed"
        rawInput={{ path: "/a/b/c.ts", offset: 5, limit: 50 }}
      />,
    );
    // The chip replaces the summary (which carried the range) — the range
    // must render next to the chip in the header.
    expect(screen.getByText("L5–54")).toBeTruthy();
    // The expanded body's chip row carries it too.
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText("L5–54").length).toBe(2);
  });
  it("renders the $ prompt + command in the expanded shell body", () => {
    render(
      <ToolCallCard
        title="bash"
        status="completed"
        rawInput={{ command: "node --check app.js" }}
        rawOutput={{ content: [{ type: "text", text: "ok" }] }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("$")).toBeTruthy();
    expect(screen.getByText("ok")).toBeTruthy();
    // The command text appears TWICE (header span + body `<pre>`), so
    // `getByText` would throw "multiple elements" — use `getAllByText` and
    // assert the second match is the `<pre>`.
    const pres = screen.getAllByText("node --check app.js");
    expect(pres.length).toBeGreaterThanOrEqual(2);
    expect(pres[1].tagName).toBe("PRE");
  });
  it("renders the Failed word on failure (stable header assertions)", () => {
    render(
      <ToolCallCard
        title="bash"
        status="failed"
        rawInput={{ command: "ls" }}
        rawOutput={{
          content: [{ type: "text", text: "" }],
          details: { error: "command not found" },
        }}
      />,
    );
    // The word is a plain header span — always rendered, no tooltip
    // interaction needed.
    const failed = screen.getByText("Failed");
    expect(failed).toBeTruthy();
    expect(failed.className).toContain("cursor-help");
    expect(failed.className).toContain("text-destructive");
  });
  it("opens the failure tooltip with the error text + copy button on pointer interaction", () => {
    render(
      <ToolCallCard
        title="bash"
        status="failed"
        rawInput={{ command: "ls" }}
        rawOutput={{
          content: [{ type: "text", text: "" }],
          details: { error: "command not found" },
        }}
      />,
    );
    // Radix `TooltipTrigger` listens to pointer/focus events —
    // `fireEvent.mouseEnter` / `fireEvent.pointerMove` do NOT open it in
    // this Radix version; `fireEvent.focus` does. `TooltipProvider` sets
    // `delayDuration = 0`, so the portal mounts synchronously (no fake
    // timers needed).
    fireEvent.focus(screen.getByText("Failed"));
    // The content renders into a portal outside the card container — assert
    // on `document.body`.
    expect(document.body.textContent).toContain("command not found");
    expect(screen.getByRole("button", { name: "Copy error" })).toBeTruthy();
  });
  it("renders the output text when expanded", () => {
    render(
      <ToolCallCard
        title="bash"
        status="completed"
        rawInput={{ command: "ls" }}
        rawOutput={{ content: [{ type: "text", text: "fileA\nfileB" }] }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/fileA/)).toBeTruthy();
  });
  it("renders a bare-string rawOutput when expanded", () => {
    render(
      <ToolCallCard title="read" status="completed" rawOutput="file contents" />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("file contents")).toBeTruthy();
  });
  it("caps output at 20k chars with a truncation note", () => {
    render(
      <ToolCallCard
        title="bash"
        status="completed"
        rawOutput={"x".repeat(20001)}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/truncated — 20001 chars total/)).toBeTruthy();
  });
  it("renders (no output) when there is no rawOutput", () => {
    render(<ToolCallCard title="bash" status="completed" />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("No output.")).toBeTruthy();
  });
  it("renders (no output) for a result with only an empty text item", () => {
    render(
      <ToolCallCard
        title="sudo_exec"
        status="completed"
        rawInput={{ command: "true" }}
        rawOutput={{
          content: [{ type: "text", text: "" }],
          details: { command: "true", exitCode: 0 },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("No output.")).toBeTruthy();
  });
  it("shows the failure reason from details for a failed call with empty text", () => {
    render(
      <ToolCallCard
        title="sudo_exec"
        status="failed"
        rawInput={{ command: "true" }}
        rawOutput={{
          content: [{ type: "text", text: "" }],
          details: { command: "true", error: "timed out after 120s" },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/timed out after 120s/)).toBeTruthy();
  });
  it("defers output normalization until the card is expanded", () => {
    const spy = vi.spyOn(toolOutput, "normalizeToolOutput");
    render(
      <ToolCallCard
        title="bash"
        status="completed"
        rawOutput={"x".repeat(50000)}
      />,
    );
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button"));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
  it("stays COLLAPSED when a file edit finishes (no auto-open)", () => {
    const input = {
      path: "/a/b/c.ts",
      edits: [{ oldText: "a", newText: "b" }],
    };
    const { container, rerender } = render(
      <ToolCallCard title="edit" status="pending" rawInput={input} />,
    );
    expect(screen.queryByText("No output.")).toBeNull();
    expect(container.querySelector(".bg-panel")).toBeNull();
    // Finishes → and NOTHING opens. The card used to open itself once on this
    // edge (ZCode's one-shot `autoOpen`), which meant a run of edits each
    // dumped its diff into the transcript unasked; the user asked for the
    // rows to stay rows.
    rerender(
      <ToolCallCard
        title="edit"
        status="completed"
        rawInput={input}
        rawOutput={{ content: [{ type: "text", text: "done" }] }}
      />,
    );
    expect(container.querySelector(".bg-panel")).toBeNull();
    // The content is not rendered while collapsed (output normalization stays
    // deferred — the reason the body is conditional rather than hidden).
    expect(screen.queryByText("done")).toBeNull();
    // ONE click opens it, and the body is the same body auto-open used to show
    // (so this change removes the SURPRISE, not the feature).
    // NOTE the optional space: the header's accessible name is its inline
    // spans concatenated WITHOUT a separator ("Editedc.ts+1-1").
    fireEvent.click(screen.getByRole("button", { name: /^Edited\s?c\.ts/ }));
    expect(container.querySelector(".bg-panel")).not.toBeNull();
    expect(screen.getByText("done")).toBeTruthy();
  });
  it("does not auto-open a completed WRITE either (the rule matched both)", () => {
    // The removed auto-open keyed on `title === "write" || "edit"`, so a write
    // needs its own guard: a future "restore the diff reveal" change could
    // re-add one title and still pass the edit test above.
    const { container, rerender } = render(
      <ToolCallCard title="write" status="pending" rawInput={{ path: "/a/b/c.ts" }} />,
    );
    rerender(
      <ToolCallCard
        title="write"
        status="completed"
        rawInput={{ path: "/a/b/c.ts" }}
        rawOutput={{ content: [{ type: "text", text: "created" }] }}
      />,
    );
    expect(container.querySelector(".bg-panel")).toBeNull();
  });
  it("does not auto-open non-file tools", () => {
    const { container, rerender } = render(
      <ToolCallCard
        title="bash"
        status="pending"
        rawInput={{ command: "ls" }}
      />,
    );
    rerender(
      <ToolCallCard
        title="bash"
        status="completed"
        rawInput={{ command: "ls" }}
        rawOutput={{ content: [{ type: "text", text: "ok" }] }}
      />,
    );
    // Manual expand only.
    expect(container.querySelector(".bg-panel")).toBeNull();
  });

  it("renders file chip row with min-w-0 overflow-hidden when expanded", () => {
    render(
      <ToolCallCard
        title="read"
        status="completed"
        rawInput={{ path: "very/long/path/to/some/nested/file/here.ts" }}
        rawOutput="data"
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const chipRow = screen.getByTestId("tool-call-file-row");
    expect(chipRow.className).toContain("min-w-0");
    expect(chipRow.className).toContain("overflow-hidden");
    expect(chipRow.className).not.toContain("truncate");
  });
});

// --- External open: the tool-output surfaces. A `<pre>` is one settled text
// node, so a URL printed by `bash` needs `linkifyText` to become clickable; the
// file chip is a FILE (not a URL), so it is a `<button>`, and only where it is
// not nested in the header's toggle `<button>`.
//
// Every header-row filter below is a prefix regex with an OPTIONAL space: the
// toggle button's accessible name is its inline spans concatenated verbatim
// ("Ranls", "Readc.ts"), so a natural-phrase name would not match.
describe("ToolCallCard (External open)", () => {
  it("linkifies a URL in the expanded output and External-opens it with the Space cwd", () => {
    render(
      <SpaceCwdProvider cwd="/home/u/proj">
        <ToolCallCard
          title="bash"
          status="completed"
          rawInput={{ command: "ls" }}
          rawOutput={{
            content: [{ type: "text", text: "docs: https://x.test/a done" }],
          }}
        />
      </SpaceCwdProvider>,
    );
    // Collapsed: nothing is linkified (the body is the only linkified surface).
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Ran\s?ls$/ }));
    const anchor = screen.getByRole("link", { name: "https://x.test/a" });
    expect(anchor.getAttribute("href")).toBe("https://x.test/a");
    fireEvent.click(anchor);
    expect(externalOpen).toHaveBeenCalledTimes(1);
    expect(externalOpen).toHaveBeenCalledWith(
      "https://x.test/a",
      "/home/u/proj",
    );
  });

  it("passes a null cwd when no SpaceCwdProvider is mounted", () => {
    render(
      <ToolCallCard
        title="bash"
        status="completed"
        rawOutput={{ content: [{ type: "text", text: "https://x.test/a" }] }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Ran$/ }));
    fireEvent.click(screen.getByRole("link", { name: "https://x.test/a" }));
    expect(externalOpen).toHaveBeenCalledWith("https://x.test/a", null);
  });

  it("preserves the output's whitespace byte-for-byte around the link", () => {
    // `textContent` — not `getByText` — because the assertion IS the raw
    // whitespace: linkifyText must add no box and drop no character.
    const text = "line1\n  line2\thttps://x.test/a\nline4";
    const { container } = render(
      <ToolCallCard title="bash" status="completed" rawOutput={text} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Ran$/ }));
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe(text);
    expect(pre?.contains(screen.getByRole("link"))).toBe(true);
  });

  it("keeps the 20k cap (ellipsis + note) and linkifies only the shown text", () => {
    // The URL sits PAST the cut, so the truncation still happens first: the
    // shown text ends in the ellipsis and carries no anchor.
    const huge = `${"x".repeat(20000)}https://x.test/a`;
    const { container } = render(
      <ToolCallCard title="bash" status="completed" rawOutput={huge} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Ran$/ }));
    expect(container.querySelector("pre")?.textContent).toBe(
      `${"x".repeat(20000)}…`,
    );
    expect(screen.getByText(/truncated — 20016 chars total/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("linkifies a URL in the shell command line (the commonest printed URL)", () => {
    const { container } = render(
      <SpaceCwdProvider cwd="/home/u/proj">
        <ToolCallCard
          title="bash"
          status="completed"
          rawInput={{ command: "curl https://x.test/api" }}
          rawOutput="ok"
        />
      </SpaceCwdProvider>,
    );
    const header = screen.getByRole("button", {
      name: /^Ran\s?curl/,
    });
    // The header summary sits inside the toggle button, so it stays inert.
    expect(within(header).queryByRole("link")).toBeNull();
    fireEvent.click(header);
    // The body's command `<pre>` (the first `<pre>` in the panel) carries the
    // link, and its text is unchanged byte-for-byte.
    const commandPre = container.querySelector(".bg-panel pre");
    expect(commandPre?.textContent).toBe("curl https://x.test/api");
    expect(commandPre?.querySelector("a")?.getAttribute("href")).toBe(
      "https://x.test/api",
    );
  });

  it("makes the expanded body's file chip a button that External-opens the path with the Space cwd", () => {
    render(
      <SpaceCwdProvider cwd="/home/u/proj">
        <ToolCallCard
          title="read"
          status="completed"
          rawInput={{ path: "/a/b/c.ts" }}
          rawOutput="data"
        />
      </SpaceCwdProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Read\s?c\.ts$/ }));
    const chip = screen.getByRole("button", { name: "c.ts" });
    // It is the BODY chip, and it carries the full path as its tooltip (the
    // inert variant keeps that `title` on its own `<span>`).
    expect(chip.closest('[data-testid="tool-call-file-row"]')).not.toBeNull();
    expect(chip.getAttribute("title")).toBe("/a/b/c.ts");
    // Not nested in any other interactive element.
    expect(chip.closest("button")).toBe(chip);
    fireEvent.click(chip);
    expect(externalOpen).toHaveBeenCalledTimes(1);
    expect(externalOpen).toHaveBeenCalledWith("/a/b/c.ts", "/home/u/proj");
  });

  it("leaves the header's file chip inert — no element nested inside the toggle button", () => {
    const { container } = render(
      <SpaceCwdProvider cwd="/home/u/proj">
        <ToolCallCard
          title="read"
          status="completed"
          rawInput={{ path: "/a/b/c.ts" }}
          rawOutput="data"
        />
      </SpaceCwdProvider>,
    );
    const header = screen.getByRole("button", { name: /^Read\s?c\.ts$/ });
    // The nesting pin: the header row is itself a `<button>` (four of
    // `FileChip`'s five call sites render inside one), so its chip must not be
    // interactive — a nested `<button>` is invalid HTML whose click would also
    // toggle the card.
    expect(within(header).queryByRole("button", { name: "c.ts" })).toBeNull();
    expect(within(header).getByText("c.ts").tagName).toBe("SPAN");
    expect(
      within(header)
        .getByText("c.ts")
        .closest("span[title]")
        ?.getAttribute("title"),
    ).toBe("/a/b/c.ts");
    // Expanded: the header row stays inert, and nothing interactive ends up
    // inside any button anywhere in the card.
    fireEvent.click(header);
    expect(within(header).queryByRole("button")).toBeNull();
    expect(within(header).queryByRole("link")).toBeNull();
    expect(
      container.querySelectorAll("button button, button a, button input"),
    ).toHaveLength(0);
  });

  it("keeps the diff/edit view inert — no anchor in the DiffBlock", () => {
    render(
      <SpaceCwdProvider cwd="/home/u/proj">
        <ToolCallCard
          title="edit"
          status="completed"
          rawInput={{
            path: "/a/b/c.ts",
            edits: [{ oldText: "a", newText: "b" }],
          }}
          diff={{ path: "/a/b/c.ts", patch: "+go to https://x.test/a" }}
        />
      </SpaceCwdProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Edited\s?c\.ts/ }));
    // The patch line renders as plain text — the user asked for links in the
    // main text, not in the edit view.
    expect(screen.getByText("+go to https://x.test/a")).toBeTruthy();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
