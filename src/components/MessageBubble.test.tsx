import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import ReactMarkdown from "react-markdown";
import MessageBubble from "./MessageBubble";
import { Message } from "../store/sessions";
import { expandMentions, expandSkillMentions } from "../lib/skills";
import type {
  AgentDefinitionDto,
  McpServerInfo,
  SkillInfo,
} from "../lib/tauri";
import { useSubagents } from "../store/subagents";

/** A full `SkillInfo` fixture (mirrors the `skills.test.ts` factory). */
function makeSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: "debug",
    description: "A debug skill",
    path: "/s/.agents/skills/debug/SKILL.md",
    dir: "/s/.agents/skills/debug",
    scope: "space",
    body: "Step 1. Step 2.",
    disableModelInvocation: false,
    ...overrides,
  };
}

/** An `AgentDefinitionDto` fixture (the `@`-mention catalog row). */
function makeAgent(overrides: Partial<AgentDefinitionDto> = {}): AgentDefinitionDto {
  return {
    name: "scout",
    description: "Fast recon.",
    model: null,
    scope: "user",
    ...overrides,
  };
}

/** An `McpServerInfo` fixture (the `#`-mention catalog row). */
function makeMcp(overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    name: "postgres",
    kind: "stdio",
    summary: "npx -y x-mcp",
    ...overrides,
  };
}

// Spy on the markdown renderer: the streaming-perf test below counts how
// often it runs when a bubble re-renders with an UNCHANGED message
// reference (what happens to every non-touched bubble when a new thought
// chunk arrives — the reducer only replaces the last message object).
vi.mock("react-markdown", () => ({ default: vi.fn() }));
const markdownSpy = ReactMarkdown as unknown as ReturnType<typeof vi.fn>;

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.useRealTimers();
  markdownSpy.mockClear();
});

describe("MessageBubble", () => {
  it("renders agent-thought as collapsed Reasoning block", () => {
    const message: Message = { kind: "agent-thought", messageId: "m1", text: "pondering", at: 1 };
    render(<MessageBubble message={message} />);
    
    // Check for "Thought" label and "a few seconds"
    expect(screen.getByText("Thought")).toBeTruthy();
    expect(screen.getByText("a few seconds")).toBeTruthy();
    
    // Content should be absent (Reasoning component behavior)
    expect(screen.queryByText("pondering")).toBeNull();
  });

  it("renders agent-thought as streaming with isStreaming", () => {
    const message: Message = { kind: "agent-thought", messageId: "m1", text: "pondering", at: 1 };
    render(<MessageBubble message={message} isStreaming={true} />);
    
    // Trigger should show "Thinking"
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByText("pondering")).toBeTruthy(); // streaming content is visible
  });

  it("renders existing kinds unaffected", () => {
    const userMsg: Message = { kind: "user", text: "hello", at: 1 };
    render(<MessageBubble message={userMsg} />);
    expect(screen.getByText("hello")).toBeTruthy();
  });

  // --- User-message images: read-only thumbnail grid (the transcript is
  // history — no remove buttons). ---

  it("renders a user message's images as a read-only thumbnail grid", () => {
    const message: Message = {
      kind: "user",
      text: "look",
      at: 1,
      images: [{ name: "a.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" }],
    };
    render(<MessageBubble message={message} />);
    const img = screen.getByAltText("a.png");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AQID");
  });

  it("renders an image-only user message (empty text)", () => {
    const message: Message = {
      kind: "user",
      text: "",
      at: 1,
      images: [{ name: "a.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" }],
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByAltText("a.png")).toBeTruthy();
  });

  it("renders a plain user message (no images) without an <img>", () => {
    const message: Message = { kind: "user", text: "hello", at: 1 };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    // The wrapping lives on the BAND, not on the unit wrapper (`firstElementChild`
    // is now the wrapper, so reaching by position would assert nothing).
    const userContainer = screen.getByTestId("user-band");
    expect(userContainer.className).toContain("[overflow-wrap:anywhere]");
    expect(userContainer.className).not.toContain("break-words");
  });

  // --- The user's text sits on the composer's own surface (item 4) -----------

  it("paints the user's text on the COMPOSER's fill, with NO shrink-wrap of its own", () => {
    // WHAT MAKES IT FULL WIDTH is the ABSENCE of three classes, so that is
    // what this asserts — jsdom has no layout engine, so measuring the band is
    // not possible here. The width itself comes from `MessageList`'s `flex-col`
    // row wrapper (children stretch), which the bubble must not override; the
    // rendered band was checked in a real browser against the built CSS.
    const message: Message = { kind: "user", text: "hello", at: 1 };
    render(<MessageBubble message={message} />);
    const band = screen.getByTestId("user-band");
    // `bg-composer` and not `bg-input`: the palettes give them the same value
    // TODAY and split them so a theme can move one without the other, and this
    // surface must follow the box the text was typed in.
    expect(band.className).toContain("bg-composer");
    // `inline-block` shrink-wraps even inside a flex column, `self-start`
    // overrides the stretch, `max-w-[85%]` caps the band — none of the three
    // may creep back, because each ONE silently re-narrows it.
    expect(band.className).not.toContain("inline-block");
    expect(band.className).not.toContain("self-start");
    expect(band.className).not.toContain("max-w");
    // NO border: the user asked for the plain fill. The cost, MEASURED from
    // rendered pixels in a real browser: fill vs chat column is 1.11 (Dracula),
    // 1.12 (zai dark), 1.08 (zai light — `#ffffff` on a `#f6f6f6` column). All
    // faint, zai light faintest. Accepted knowingly; do not "fix" it by
    // re-adding a border without asking.
    expect(band.className).not.toContain("border");
    // The corners STAY: the user asked to lose the border and the width cap,
    // not the shape — a full-width band with square corners would read as a
    // table row rather than as their message.
    expect(band.className).toContain("rounded-xl");
  });

  it("puts the 20px on the USER MESSAGE, not on the band", () => {
    // `my-5` = 20px on this scale (`--spacing` is `.25rem`; the root font-size
    // is never overridden, and `--ui-font-size` drives only the text tokens).
    // The margin belongs on the UNIT because the mention rows and the image
    // grid are SIBLINGS of the band — 8px below it via `mt-2` — so a margin on
    // the band would push a sentence away from its OWN annotations while
    // leaving those annotations 12px from the next message. Measured both ways
    // in a browser: on the band, band→annotation = 28px and annotation→next =
    // 12px (the association inverts); on the unit, band→annotation = 8px and
    // the whole message stands 32px from a plain neighbour (48px beside a tool
    // row, where the breathing `mt-4` stacks).
    const message: Message = {
      kind: "user",
      text: expandMentions("ping @scout", {
        skills: [],
        agents: [makeAgent()],
        mcpServers: [],
      }),
      at: 1,
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByTestId("user-message").className).toContain("my-5");
    // The band itself carries NO margin, so the annotation row keeps its 8px.
    expect(screen.getByTestId("user-band").className).not.toContain("my-");
  });

  it("keeps the mention rows OUT of the band (they paint bg-input, which would vanish in it)", () => {
    const message: Message = {
      kind: "user",
      text: expandMentions("ping @scout", {
        skills: [],
        agents: [makeAgent()],
        mcpServers: [],
      }),
      at: 1,
    };
    const { container } = render(<MessageBubble message={message} />);
    const band = screen.getByTestId("user-band");
    expect(screen.getByText("Agent")).toBeTruthy();
    // The chip row is a SIBLING of the band, never a descendant: in the zai
    // palettes `--color-input` == `--color-composer`, so a `bg-input` card
    // inside the band would have an edge of exactly the band's colour.
    expect(band.textContent).toBe("ping @scout");
    expect(container.querySelector(".bg-input")!.closest('[data-testid="user-band"]')).toBeNull();
  });

  // --- The agent's reply rides a BAND (the mirror of the user band) + the
  // copy button that lives OUTSIDE it. ---

  it("paints the agent's reply on the COMPOSER's fill (the user band's token, not a copy of its hex)", () => {
    // Same reasoning as the user band: `--color-composer` is the TOKEN the
    // palette owns, so a theme that moves it moves BOTH bands together. A
    // hardcoded hex here would drift the moment a palette moves the token.
    const message: Message = {
      kind: "agent-text",
      messageId: "m1",
      text: "the reply",
      at: 1,
    };
    render(<MessageBubble message={message} />);
    const band = screen.getByTestId("agent-band");
    expect(band.className).toContain("bg-composer");
    expect(band.className).toContain("rounded-xl");
    expect(band.className).toContain("px-3");
    expect(band.className).toContain("py-2");
    expect(band.className).toContain("text-ui-base");
    expect(band.className).toContain("text-foreground");
    // `[overflow-wrap:anywhere]` stays OFF: the user band needs it because it
    // renders the raw sentence (a long URL must break), while `AgentMarkdown`
    // renders block elements that prose already wraps.
    expect(band.className).not.toContain("[overflow-wrap:anywhere]");
    // And the reply's text rides the band: `AgentMarkdown`'s root is the band's
    // own child (`react-markdown` is mocked in this file, so the root is the
    // deepest node available here — the markdown scale itself is pinned by
    // `MessageBubble.markdown.test.tsx`).
    const root = screen.getByTestId("agent-band").firstElementChild;
    expect(root).toBeTruthy();
    expect(root!.className).toContain("leading-[1.75]");
  });

  it("carries -mt-2 / mb-5 on the band (the Thought pair closes to 4px, the gap below matches a user message)", () => {
    // `MessageList`'s scroll container is `flex flex-col gap-3` (12px) and a
    // flex MARGIN ADDS to a gap — it can never subtract, so `mt-0` cannot pull
    // the reply closer than 12px. `-mt-2` (−8px) is what reaches the agreed 4px
    // (12 − 8); `mb-5` (20px) is what a user message's `my-5` measures below the
    // user band (12 + 20 = 32px).
    const message: Message = {
      kind: "agent-text",
      messageId: "m1",
      text: "the reply",
      at: 1,
    };
    render(<MessageBubble message={message} />);
    const tokens = screen.getByTestId("agent-band").className.split(/\s+/);
    expect(tokens).toContain("-mt-2");
    expect(tokens).toContain("mb-5");
    // One place, the whole band shape, so a class cannot quietly leave the
    // class list without reddening this test too.
    expect(tokens).toContain("bg-composer");
    expect(tokens).toContain("rounded-xl");
    // The margin lives on the BAND because `agent-text` has no siblings — the
    // user case puts `my-5` on its UNIT only because its mention cards and
    // image grid are siblings of that band.
    expect(tokens).not.toContain("my-5");
  });

  it("returns a fragment (band + button), so the markdown root keeps its DOM path", () => {
    // `MessageBubble.markdown.test.tsx` walks
    // `container.firstElementChild.firstElementChild` to reach the markdown
    // root; wrapping the two nodes in a `<div>` would shift that path by one.
    const message: Message = {
      kind: "agent-text",
      messageId: "m1",
      text: "the reply",
      at: 1,
    };
    const { container } = render(<MessageBubble message={message} />);
    expect(container.firstElementChild).toBe(screen.getByTestId("agent-band"));
    // The copy button is the band's SIBLING — not a wrapper child, not inside
    // the band.
    const button = screen.getByTestId("copy-response");
    expect(screen.getByTestId("agent-band").contains(button)).toBe(false);
    expect(button.parentElement).toBe(container);
  });

  it("renders the copy response button WITHOUT any hover or focus (it is always visible)", () => {
    const message: Message = {
      kind: "agent-text",
      messageId: "m1",
      text: "the reply",
      at: 1,
    };
    render(<MessageBubble message={message} />);
    // No `fireEvent.mouseOver`, no `focus()` — the node is simply there.
    expect(screen.getByTestId("copy-response")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy response" }),
    ).toBeTruthy();
  });

  it("sits the copy response button at the END (right) edge of the row", () => {
    const message: Message = {
      kind: "agent-text",
      messageId: "m1",
      text: "the reply",
      at: 1,
    };
    render(<MessageBubble message={message} />);
    // The row wrapper is a `flex-col` (MessageList), whose children default to
    // `stretch` — without an explicit cross-axis alignment the icon renders at
    // the LEFT edge, which reads as a control BEFORE the reply rather than a
    // caption for it. Pinned as a class assertion: jsdom runs no layout, so
    // the painted position is not directly assertable (the convention every
    // other position-pin in this repo follows).
    const button = screen.getByTestId("copy-response");
    expect(button.className).toContain("self-end");
    expect(button.className).not.toContain("self-start");
  });

  it("copies the reply's RAW markdown (not the rendered output) and confirms visibly", async () => {
    const raw = "Use `npm test`:\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const message: Message = {
      kind: "agent-text",
      messageId: "m1",
      text: raw,
      at: 1,
    };
    render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByTestId("copy-response"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Byte-for-byte the PROP: backticks and table pipes intact (a rendered-DOM
    // read-back would lose both).
    expect(writeText).toHaveBeenCalledWith(raw);
    expect(
      screen.getByRole("button", { name: "Copied" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Copy response" }),
    ).toBeNull();
  });

  it("resets the response copy button from Copied back to Copy response after 1.5s", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const message: Message = {
      kind: "agent-text",
      messageId: "m1",
      text: "the reply",
      at: 1,
    };
    const { unmount } = render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByTestId("copy-response"));
    vi.useFakeTimers();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Copied" })).toBeTruthy();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
    });
    expect(
      screen.queryByRole("button", { name: "Copy response" }),
    ).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
    // The unmount cleanup clears the pending timer (no `setState` on a dead tree).
    fireEvent.click(screen.getByTestId("copy-response"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      unmount();
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("excludes thinking from the copy button (thoughts are a different render unit)", () => {
    const message: Message = {
      kind: "agent-text",
      messageId: "m1",
      text: "the reply",
      at: 1,
    };
    render(<MessageBubble message={message} />);
    // No thought text anywhere in the bubble, and the ONE button it owns is the
    // response copy — the `Thought` row is a separate `agent-thought` unit.
    expect(screen.getByTestId("copy-response")).toBeTruthy();
    expect(screen.queryByText("Thought")).toBeNull();
  });

  it("skips re-rendering when the message reference is unchanged (streaming perf)", () => {
    // A live thought chunk replaces ONLY the trailing message object in the
    // reducer; every other bubble gets the SAME reference. Re-rendering all
    // of them (incl. a full ReactMarkdown re-parse per agent-text bubble)
    // on every chunk is what made the app render real slow — the bubble
    // must be memoized so only the changed bubble re-renders.
    const message: Message = { kind: "agent-text", messageId: "m1", text: "hello world", at: 1 };
    const { rerender } = render(<MessageBubble message={message} />);
    const first = markdownSpy.mock.calls.length;
    expect(first).toBe(1);
    rerender(<MessageBubble message={message} />);
    expect(markdownSpy.mock.calls.length).toBe(first);
  });

  // --- `subagent` tool call: render the `SubagentDelegatingCard` (not the
  // plain `ToolCallCard`); every other tool is unchanged. ---

  beforeEach(() => {
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
  });

  it("renders a subagent tool call as SubagentDelegatingCard (not the plain ToolCallCard)", () => {
    const message: Message = {
      kind: "tool-call",
      id: "t1",
      title: "subagent",
      status: "pending",
      at: 1,
    };
    render(<MessageBubble message={message} sessionId="main1" />);
    // The `SubagentDelegatingCard` is OPEN by default (no seeded entries →
    // the empty-state marker, unique to it, is visible).
    expect(screen.getByText("No subagents yet.")).toBeTruthy();
    // The plain `ToolCallCard` is collapsed by default and shows "No
    // output." when expanded — toggling here must NOT surface a plain-card
    // body (the nested card's empty state just hides).
    act(() => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(screen.queryByText("No subagents yet.")).toBeNull();
    expect(screen.queryByText("No output.")).toBeNull();
  });

  it("renders a non-subagent tool call as the plain ToolCallCard (unchanged)", () => {
    const message: Message = {
      kind: "tool-call",
      id: "t1",
      title: "bash",
      status: "completed",
      rawInput: { command: "ls -la" },
      at: 1,
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("Ran")).toBeTruthy();
    expect(screen.getByText("ls -la")).toBeTruthy();
    // No `SubagentDelegatingCard` for a plain tool.
    expect(screen.queryByText("No subagents yet.")).toBeNull();
  });

  it("renders the session's subagent rows nested under the subagent tool call", () => {
    useSubagents.getState().addSession({
      sessionId: "sub1",
      parentSessionId: "main1",
      agentName: "reviewer",
      task: "review the diff",
      status: "running",
    });
    const message: Message = {
      kind: "tool-call",
      id: "t1",
      title: "subagent",
      status: "pending",
      at: 1,
    };
    render(<MessageBubble message={message} sessionId="main1" />);
    expect(screen.getByText("reviewer")).toBeTruthy();
    expect(screen.getByText("review the diff")).toBeTruthy();
    expect(screen.queryByText("No subagents yet.")).toBeNull();
  });

  // --- User-message skill blocks: collapsible cards (collapsed by default —
  // ZCode's `ToolLayout` defaults `isOpen` to `false`). ---

  it("a_user_message_with_no_skills_renders_verbatim", () => {
    const message: Message = { kind: "user", text: "hello world", at: 1 };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("hello world")).toBeTruthy();
    // No skill card: no toggle button at all.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a_skill_block_renders_collapsed_by_default", () => {
    const message: Message = {
      kind: "user",
      text: expandSkillMentions("fix $debug", [makeSkill()]),
      at: 1,
    };
    render(<MessageBubble message={message} />);
    // The user's text renders verbatim and the card header (the skill name)
    // is visible ... 
    expect(screen.getByText("fix $debug")).toBeTruthy();
    expect(screen.getByText("debug")).toBeTruthy();
    // ... but the card's BODY is NOT (collapsed default), `aria-expanded`
    // is `false`.
    expect(screen.queryByText("Step 1. Step 2.")).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("clicking_the_header_expands_the_body", () => {
    const message: Message = {
      kind: "user",
      text: expandSkillMentions("fix $debug", [makeSkill()]),
      at: 1,
    };
    render(<MessageBubble message={message} />);
    const header = screen.getByRole("button");
    act(() => {
      fireEvent.click(header);
    });
    expect(screen.getByText("Step 1. Step 2.")).toBeTruthy();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    // Click again → collapsed again.
    act(() => {
      fireEvent.click(header);
    });
    expect(screen.queryByText("Step 1. Step 2.")).toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("multiple_skill_blocks_render_in_order", () => {
    const a = makeSkill({
      name: "alpha",
      path: "/s/.agents/skills/alpha/SKILL.md",
      dir: "/s/.agents/skills/alpha",
      body: "A body",
    });
    const b = makeSkill({
      name: "beta",
      path: "/s/.agents/skills/beta/SKILL.md",
      dir: "/s/.agents/skills/beta",
      body: "B body",
    });
    const message: Message = {
      kind: "user",
      text: expandSkillMentions("x $alpha y $beta", [a, b]),
      at: 1,
    };
    render(<MessageBubble message={message} />);
    const headers = screen.getAllByRole("button");
    expect(headers).toHaveLength(2);
    // Both headers visible in first-mention order ... 
    expect(headers[0].textContent).toContain("alpha");
    expect(headers[1].textContent).toContain("beta");
    // ... and both collapsed by default (bodies absent).
    expect(
      headers.every((h) => h.getAttribute("aria-expanded") === "false"),
    ).toBe(true);
    expect(screen.queryByText("A body")).toBeNull();
    expect(screen.queryByText("B body")).toBeNull();
  });

  // --- Task 6 (composer-mentions): the `@` agent / `#` MCP soft-hint chip.
  // These blocks are SHORT hints (unlike a skill body), so they render as a
  // compact SINGLE-LINE chip — no collapse affordance at all.

  it("an_agent_block_renders_the_named_by_the_user_chip",
    () => {
      const message: Message = {
        kind: "user",
        text: expandMentions("ping @scout", {
          skills: [],
          agents: [makeAgent()],
          mcpServers: [],
        }),
        at: 1,
      };
      const { container } = render(<MessageBubble message={message} />);
      // The user's text renders verbatim (the `@scout` token stays in it).
      expect(screen.getByText("ping @scout")).toBeTruthy();
      // The chip: the kind label + the name + the soft-hint suffix.
      expect(screen.getByText("Agent")).toBeTruthy();
      expect(screen.getByText("scout")).toBeTruthy();
      expect(screen.getByText("named by the user")).toBeTruthy();
      // NO collapse affordance: the chip is not a button (no chevron, no
      // expand) …
      expect(screen.queryByRole("button")).toBeNull();
      // … and the block's HINT BODY is not rendered anywhere.
      expect(
        screen.queryByText(/Dispatch a subagent with agentName/),
      ).toBeNull();
      // Exactly one chip row.
      expect(container.querySelectorAll(".bg-input")).toHaveLength(1);
    });

  it("an_mcp_block_renders_the_named_by_the_user_chip", () => {
    const message: Message = {
      kind: "user",
      text: expandMentions("query #postgres", {
        skills: [],
        agents: [],
        mcpServers: [makeMcp()],
      }),
      at: 1,
    };
    const { container } = render(<MessageBubble message={message} />);
    expect(screen.getByText("query #postgres")).toBeTruthy();
    expect(screen.getByText("MCP")).toBeTruthy();
    expect(screen.getByText("postgres")).toBeTruthy();
    expect(screen.getByText("named by the user")).toBeTruthy();
    // No collapse affordance, and the hint body is not rendered.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Connect to it via the mcp tool/)).toBeNull();
    expect(container.querySelectorAll(".bg-input")).toHaveLength(1);
  });

  it("a_skill_block_still_renders_the_collapsible_card",
    () => {
      // Regression: the skill card (icon / collapse behaviour) is UNCHANGED
      // by the generalization — only the block SPLITTER is new.
      const message: Message = {
        kind: "user",
        text: expandMentions("fix $debug", {
          skills: [makeSkill()],
          agents: [],
          mcpServers: [],
        }),
        at: 1,
      };
      render(<MessageBubble message={message} />);
      expect(screen.getByText("Skill")).toBeTruthy();
      expect(screen.getByText("debug")).toBeTruthy();
      // NO soft-hint suffix on a skill card (the skill is a HARD
      // instruction, not a hint).
      expect(screen.queryByText("named by the user")).toBeNull();
      // Collapsed by default; the header toggles it.
      const header = screen.getByRole("button");
      expect(header.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("Step 1. Step 2.")).toBeNull();
      act(() => {
        fireEvent.click(header);
      });
      expect(screen.getByText("Step 1. Step 2.")).toBeTruthy();
    });

  it("a_mixed_message_renders_the_card_and_both_chips_in_order",
    () => {
      const message: Message = {
        kind: "user",
        text: expandMentions("x $debug @scout #postgres", {
          skills: [makeSkill()],
          agents: [makeAgent()],
          mcpServers: [makeMcp()],
        }),
        at: 1,
      };
      const { container } = render(<MessageBubble message={message} />);
      expect(screen.getByText("x $debug @scout #postgres")).toBeTruthy();
      // First-mention order: the skill card, then the agent chip, then the
      // MCP chip (the block rows are the `.bg-input` elements).
      const rows = [...container.querySelectorAll(".bg-input")];
      expect(rows).toHaveLength(3);
      expect(rows[0]!.textContent).toContain("Skill");
      expect(rows[0]!.textContent).toContain("debug");
      expect(rows[1]!.textContent).toContain("Agent");
      expect(rows[1]!.textContent).toContain("scout");
      expect(rows[2]!.textContent).toContain("MCP");
      expect(rows[2]!.textContent).toContain("postgres");
      // Both chips carry the soft-hint suffix; the card does not collapse
      // anything but the skill body (collapsed by default).
      expect(screen.getAllByText("named by the user")).toHaveLength(2);
      expect(screen.queryByText("Step 1. Step 2.")).toBeNull();
      // Only the skill card is a button (the chips have no affordance).
      expect(screen.getAllByRole("button")).toHaveLength(1);
    });

  it("a_message_with_no_mention_blocks_renders_verbatim",
    () => {
      // Regression for the `mergeDedupeKey` display invariant: no blocks →
      // the text renders byte-identically and no chip/card shows up.
      const message: Message = { kind: "user", text: "just text @not-an-agent", at: 1 };
      render(<MessageBubble message={message} />);
      expect(screen.getByText("just text @not-an-agent")).toBeTruthy();
      expect(screen.queryByText("named by the user")).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
    });


  // --- ADR 0033: a `?` File-completion path renders VERBATIM (no chip, no
  // card, nothing stripped). The pin for the OTHER half of the split — the
  // picker shares `MentionRow`/`selectMention` with the three Mentions, so the
  // risk is drift into the DISPLAY path as much as into `expandMentions`. The
  // block-rendering tests above are deliberately left untouched: they are the
  // positive control that the chip/card path still works, and this one is the
  // negative control that `?` never enters it.

  it("a user message containing a ? path renders VERBATIM with no chip and no card", () => {
    // The persisted text is what `send()` wrote — i.e. `expandMentions` output.
    // Fed through the REAL expander with every catalog populated (a `readme`
    // entry in all three, so a `?`-aware expansion would have produced a block
    // to render here), so this pins the END-TO-END display consequence rather
    // than a hand-written string.
    const drafts = [
      "read ?README.md",
      "~/.bashrc",
      "/etc/hosts",
      "?? file",
      "a?.b",
      "x ? y : z",
    ];
    for (const draft of drafts) {
      const message: Message = {
        kind: "user",
        text: expandMentions(draft, {
          skills: [makeSkill({ name: "readme" }), makeSkill({ name: "file" })],
          agents: [makeAgent({ name: "readme" }), makeAgent({ name: "file" })],
          mcpServers: [makeMcp({ name: "readme" }), makeMcp({ name: "file" })],
        }),
        at: 1,
      };
      const { container, unmount } = render(<MessageBubble message={message} />);
      // The text is the draft byte-for-byte — no chip replaced it, no path was
      // stripped or rewritten (compare with the chip tests above, where the
      // token stays in the text AND a row appears beside it).
      expect(screen.getByText(draft)).toBeTruthy();
      // No chip, no collapsible card, no soft-hint suffix, no button at all.
      expect(screen.queryByText("named by the user")).toBeNull();
      expect(screen.queryByText("Skill")).toBeNull();
      expect(screen.queryByText("Agent")).toBeNull();
      expect(screen.queryByText("MCP")).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      expect(container.querySelectorAll(".bg-input")).toHaveLength(0);
      // And no file CONTENTS leaked into the bubble — the security half of the
      // invariant: the composer inserts a path, the agent opens it.
      expect(container.textContent).toBe(draft);
      unmount();
    }
  });

  it("a ? path alongside a real Mention renders the chip AND the untouched path", () => {
    // The split, on the display side: the `@` chip appears while the `?` path
    // stays in the user's text exactly as typed.
    const message: Message = {
      kind: "user",
      text: expandMentions("ask @scout about ?README.md", {
        skills: [makeSkill()],
        agents: [makeAgent()],
        mcpServers: [makeMcp()],
      }),
      at: 1,
    };
    const { container } = render(<MessageBubble message={message} />);
    expect(screen.getByText("ask @scout about ?README.md")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("named by the user")).toBeTruthy();
    // ONE row — the agent chip. The `?` path produced no row of its own.
    expect(container.querySelectorAll(".bg-input")).toHaveLength(1);
    expect(screen.queryByText("readme")).toBeNull();
  });
});
