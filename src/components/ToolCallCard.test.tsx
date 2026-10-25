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
  it("colours the SETTLED verb with the row token, and the pending one not at all", () => {
    // ADR 0062's pending consequence, graded on the rendered classes: the
    // shimmer is the "this call is working" cue and outranks a static colour, so
    // `text-row-verb` must appear only once the call has settled. The two
    // branches are asserted from BOTH renders on purpose — checking only the
    // settled one would pass a component that dropped the shimmer, and checking
    // only the pending one would pass a verb that never got a colour at all.
    const { container: pendingContainer, unmount } = render(
      <ToolCallCard title="bash" status="pending" rawInput={{ command: "ls" }} />,
    );
    const pendingVerb = within(pendingContainer).getByText("Running");
    expect(pendingVerb.className).toContain("animated-gradient-text");
    expect(pendingVerb.className).not.toContain("text-row-verb");
    unmount();

    const { container: settledContainer } = render(
      <ToolCallCard title="bash" status="completed" rawInput={{ command: "ls" }} />,
    );
    const settledVerb = within(settledContainer).getByText("Ran");
    expect(settledVerb.className).toContain("text-row-verb");
    expect(settledVerb.className).not.toContain("animated-gradient-text");
    // And the glyph takes the icon token, so a Palette re-hues both halves of
    // the row without the component being touched.
    expect(settledContainer.querySelector(".text-row-icon")).not.toBeNull();
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
/**
 * C7: the exact set `<Button variant="ghost" size="default">` adds to the
 * failure tooltip's copy button, PINNED as a literal (see the test at the bottom
 * of this block for why it is not recomputed from `buttonVariants`).
 */
const COPY_BUTTON_ADDITIONS = [
  "[&_svg:not([class*='size-'])]:size-3.5",
  "[&_svg]:pointer-events-none",
  "[&_svg]:shrink-0",
  "aria-expanded:bg-hover",
  "aria-expanded:text-foreground",
  "aria-invalid:border-destructive",
  "aria-invalid:ring-2",
  "aria-invalid:ring-destructive/20",
  "bg-clip-padding",
  "border-0",
  "border-transparent",
  "dark:aria-invalid:border-destructive/50",
  "dark:aria-invalid:ring-destructive/40",
  "disabled:opacity-50",
  "disabled:pointer-events-none",
  "gap-1",
  "group/button",
  "h-auto",
  "has-data-[icon=inline-end]:pr-1.5",
  "has-data-[icon=inline-start]:pl-1.5",
  "hover:bg-transparent",
  "inline-flex",
  "items-center",
  "justify-center",
  "outline-none",
  "px-0",
  "rounded-md",
  "select-auto",
  "text-[length:inherit]",
  "transition-none",
  "whitespace-normal",
].sort();

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

  // C7 (finding 6d): the failure tooltip's copy button is a `<Button>`.
  //
  // The nesting pin above (`container.querySelectorAll("button button")`) runs
  // on the CARD's container, and this button lives in a Radix `Tooltip` PORTAL
  // mounted on `document.body` — verified, not assumed: with the tooltip open
  // the copy button's nearest ancestor `<button>` is `null` and the document
  // total for `button button` is 0. So routing it through `Button` (which
  // renders a `<button>`) cannot re-nest it inside the header row. The
  // assertion below repeats that check so the fact is pinned rather than
  // commented.
  //
  // The set comparison is the same shape C7 group 3 introduced: every
  // pre-extraction token survives, and the additions are a PINNED literal (not
  // recomputed from `buttonVariants`, so a repaint of the primitive moves one
  // side and fails).
  it("the tooltip's copy button is a <Button variant=\"ghost\" size=\"default\">, portal-rendered and never nested", () => {    const { container } = render(
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
    fireEvent.focus(screen.getByText("Failed"));
    const copy = screen.getByRole("button", { name: "Copy error" });

    // It is a `Button`, with both axes named (a bare `<Button>` would report
    // `default`/`default` and paint `bg-primary text-primary-foreground`).
    expect(copy.getAttribute("data-slot")).toBe("button");
    expect(copy.getAttribute("data-variant")).toBe("ghost");
    expect(copy.getAttribute("data-size")).toBe("default");

    // The portal: outside the card's container, with no `<button>` ancestor.
    expect(container.contains(copy), "the copy button is no longer portalled").toBe(
      false,
    );
    expect(copy.parentElement?.closest("button")).toBeNull();
    expect(document.querySelectorAll("button button")).toHaveLength(0);

    const WAS = [
      "shrink-0",
      "text-foreground-subtle",
      "hover:text-foreground",
    ].sort();
    const painted = [
      ...new Set(copy.className.split(/\s+/).filter(Boolean)),
    ].sort();
    for (const token of WAS) {
      expect(painted, `the copy button lost ${token}`).toContain(token);
    }
    expect(
      painted.filter((t) => !WAS.includes(t)),
      "the copy button's additions are not the pinned inert set",
    ).toEqual(COPY_BUTTON_ADDITIONS);

    // The icon-resize hazard, checked: the glyph sizes itself by CLASS
    // (`size-3`), so the base's `[&_svg:not([class*='size-'])]:size-3.5` cannot
    // select it (the `:not([class*='size-'])` guard) and it stays 12px.
    const svg = copy.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("size-3");
    // Lucide's own `width`/`height` ATTRIBUTES are the viewBox size (24) and are
    // unchanged by the sweep — the class is what sizes the glyph, which is why
    // the guard, not the attribute, is the thing this site depends on.
    expect(svg.getAttribute("width")).toBe("24");
  });
});

/**
 * CHARACTERISATION (issue #86 — "just empty/blank instead of hidden").
 *
 * The reporter's blank row is a ROW, and a row is `MessageList`'s wrapper
 * (`MessageList.tsx:276-290`), which pads whatever its child renders. So the
 * question this block answers is narrow: for which inputs does a COLLAPSED card
 * render nothing the user can see? Each case asserts what ACTUALLY renders today
 * — a glyph, a title, a verb — rather than asserting the fix. Task 2 inverts
 * whichever one turns out to be the culprit.
 *
 * Three distinct outcomes are kept deliberately distinct, because conflating
 * them is how the wrong fix gets written:
 *   - a TRULY EMPTY row (no element at all) — the symptom;
 *   - an ICON-ONLY row (`textContent === ""` but a visible glyph) — degenerate,
 *     and NOT the symptom;
 *   - a row with TEXT — fine.
 * Hence: never assert `textContent === ""` alone; always pair it with the
 * element count that says WHY it is empty.
 */
describe("a collapsed card renders no blank row", () => {
  /** The collapsed header row — the only thing a collapsed card draws. */
  function renderCollapsed(props: {
    title: string;
    status: "completed" | "pending" | "failed";
    rawInput?: unknown;
  }) {
    const { container } = render(<ToolCallCard {...props} />);
    const header = container.querySelector("button");
    return { container, header };
  }

  it("`title=\"\"` renders an ICON-ONLY row (a glyph, no text) — degenerate, but not a truly empty row", () => {
    // `toolVerb("")` is `undefined` (`toolOutput.ts:537-541`, verbs keyed by
    // exact title) so `ToolCallCardHeader.tsx:186-190`'s `{verb ?? title}`
    // prints the empty title, and every summary arm is closed
    // (`rawInput === undefined` → `summarizeToolCall` returns `undefined` at
    // `toolOutput.ts:35`; `fileSummaries` returns `[]`). What is left is the
    // row glyph + the hover chevron — an empty `textContent` that still shows a
    // glyph.
    //
    // NOT the suspected cause: `normalize.rs:63-65` refuses to synthesise a
    // `tool-call` message from a title-less frame, so production never hands the
    // card `title === ""`. This case pins the guard's behaviour only.
    const { header } = renderCollapsed({ title: "", status: "completed", rawInput: undefined });
    expect(header).not.toBeNull();
    const row = header!;
    // The distinguishing pair: no TEXT, but ELEMENTS — so this is icon-only,
    // not the blank row.
    expect(row.textContent).toBe("");
    expect(row.querySelectorAll("svg").length).toBeGreaterThan(0);
    expect(row.childElementCount).toBeGreaterThan(0);
  });

  it("`title=\"unknown_tool\"` renders the TITLE as text (the `verb ?? title` fallback)", () => {
    // An unrecognised verb is not an empty row: `{verb ?? title}` prints the
    // title, so the row has visible text even with no input at all.
    const { header } = renderCollapsed({
      title: "unknown_tool",
      status: "completed",
      rawInput: undefined,
    });
    expect(header!.textContent).toContain("unknown_tool");
    expect(header!.childElementCount).toBeGreaterThan(0);
  });

  it("`title=\"read\"` with `rawInput={}` renders the VERB even though the file chip arm is closed", () => {
    // `fileSummaries` returns `[]` when `path` is missing (`toolOutput.ts:579-586`)
    // and `summarizeToolCall("read", {})` is `undefined` — but `read` is a known
    // tool, so the verb prints.
    const { header } = renderCollapsed({ title: "read", status: "completed", rawInput: {} });
    expect(header!.textContent).toContain("Read");
    expect(header!.childElementCount).toBeGreaterThan(0);
  });

  it("`title=\"edit\"` with `edits: []` renders the verb + chip and NO change stat", () => {
    // `editChangeStat` is `undefined` for an empty `edits` array, so the
    // `+N -M` arm closes; `fileSummaries` still has a `path`, so the chip keeps
    // the row textual.
    const { container, header } = renderCollapsed({
      title: "edit",
      status: "completed",
      rawInput: { path: "/a/b", edits: [] },
    });
    expect(header!.textContent).toContain("Edited");
    expect(header!.textContent).toContain("b");
    // No `+`/`-` stat was rendered anywhere in the collapsed card.
    expect(container.textContent).not.toContain("+");
    expect(container.textContent).not.toContain("-");
  });

  it("`title=\"bash\"` with `command: \"\"` renders the verb and NO empty command span", () => {
    // Both command arms guard on `command !== ""`
    // (`ToolCallCard.tsx:99`, `ToolCallCardHeader.tsx:193-197`), and the summary
    // arm's `summary ?` is false for `""` — so an empty command prints nothing
    // extra rather than a blank span. The verb keeps the row textual.
    const { header } = renderCollapsed({
      title: "bash",
      status: "completed",
      rawInput: { command: "" },
    });
    expect(header!.textContent).toBe("Ran");
    expect(header!.childElementCount).toBeGreaterThan(0);
  });
});
