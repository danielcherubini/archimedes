import { fireEvent, render } from "@testing-library/react";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import MessageBubble, { safeUrlTransform } from "./MessageBubble";
import { Message } from "../store/sessions";
import { SpaceCwdProvider } from "./SpaceCwd";
import { externalOpen } from "../lib/tauri";

// The IPC module is mocked with the `importActual` SPREAD form (the shape
// `SessionStalledBanner.test.tsx:11-22` uses) rather than a factory-only mock:
// this file's import graph reaches `../lib/tauri` TRANSITIVELY
// (`MessageBubble` → `SubagentDelegatingCard` / `ToolCallCard` → the stores), so
// a factory listing only `externalOpen` would delete every other export and red
// the whole file. Only `externalOpen` is replaced — the real one would `invoke`
// Tauri, which does not exist in jsdom.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return { ...actual, externalOpen: vi.fn() };
});

/**
 * The `AgentMarkdown` scale, asserted through the REAL `ReactMarkdown`
 * renderer (unlike `MessageBubble.test.tsx`, which mocks the module to spy
 * on parse frequency). These tests pin the ZCode markdown scale that
 * `AgentMarkdown` ports from `zcode/packages/ui/src/components/ai-elements/`:
 * root `leading-[1.75] tracking-wide`, `mt-6 mb-4` headings, margin-less
 * plain `p`s, `my-3`/`space-y-1.5` lists with subtle markers, the
 * `border-l-2` blockquote, the bordered scrollable table frame with
 * `px-3 py-2` cells, and the dotted hover-underline link.
 */
/**
 * `cwd` mounts the `SpaceCwdProvider` — the active **Space**'s folder that
 * `OpenAnchor` passes to `external_open` so a RELATIVE path has something to
 * resolve against. `undefined` (the default) mounts NO provider, which is what
 * a surface outside the app tree sees, and `null` is the in-tree "no active
 * Space" value.
 */
function renderAgentText(text: string, cwd?: string | null) {
  const message: Message = { kind: "agent-text", messageId: "m1", text, at: 1 };
  const bubble = <MessageBubble message={message} />;
  return render(
    cwd === undefined ? (
      bubble
    ) : (
      <SpaceCwdProvider cwd={cwd}>{bubble}</SpaceCwdProvider>
    ),
  );
}

// The agent-text band (`data-testid="agent-band"`) is the bubble's first node
// and `AgentMarkdown`'s root is its first child, so the path below is exactly
// what the arm returns — a fragment, with no wrapper element in between.
function markdownRoot(container: HTMLElement): HTMLElement {
  const wrapper = container.firstElementChild as HTMLElement;
  return wrapper.firstElementChild as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

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

describe("AgentMarkdown (the ZCode markdown scale)", () => {
  it("renders the markdown root on the ZCode reading scale", () => {
    const { container } = renderAgentText("hello");
    const root = markdownRoot(container);
    expect(root.className).toContain("text-ui-base");
    expect(root.className).toContain("leading-[1.75]");
    expect(root.className).toContain("tracking-wide");
    expect(root.className).toContain("[overflow-wrap:anywhere]");
    expect(root.className).not.toContain("break-words");
    expect(root.className).toContain("min-w-0");
    expect(root.className).toContain("max-w-full");
    expect(root.className).toContain("[&>*:first-child]:mt-0");
    expect(root.className).toContain("[&>*:last-child]:mb-0");
  });

  it("renders inline code with [overflow-wrap:anywhere]", () => {
    const { container } = renderAgentText("here is `some_code` text");
    const code = container.querySelector("code");
    expect(code?.className).toContain("[overflow-wrap:anywhere]");
    expect(code?.className).not.toContain("break-words");
  });

  it("renders h1 on the ZCode heading scale (mt-6 mb-4 text-ui-xl font-semibold)", () => {
    const { container } = renderAgentText("# Big");
    const h1 = container.querySelector("h1");
    expect(h1?.className).toContain("mt-6");
    expect(h1?.className).toContain("mb-4");
    expect(h1?.className).toContain("text-ui-xl");
    expect(h1?.className).toContain("font-semibold");
  });

  it("renders h6 at the bottom of the ZCode weight ramp (text-ui-base font-normal)", () => {
    const { container } = renderAgentText("###### Small");
    const h6 = container.querySelector("h6");
    expect(h6?.className).toContain("mt-6");
    expect(h6?.className).toContain("mb-4");
    expect(h6?.className).toContain("text-ui-base");
    expect(h6?.className).toContain("font-normal");
  });

  it("renders a plain p WITHOUT a margin class (the ZCode scale — paragraphs ride the 1.75 leading)", () => {
    const { container } = renderAgentText("para one\n\npara two");
    const ps = container.querySelectorAll("p");
    expect(ps.length).toBe(2);
    // Unmapped (or margin-less) p: no `my-*` class of its own.
    for (const p of ps) {
      expect(p.className).not.toMatch(/my-/);
    }
  });

  it("renders strong as font-medium (not the default bold)", () => {
    const { container } = renderAgentText("some **bold** text");
    const strong = container.querySelector("strong");
    expect(strong?.className).toContain("font-medium");
  });

  it("renders ul on the ZCode list scale (my-3, space-y-1.5, subtle marker)", () => {
    const { container } = renderAgentText("- a\n- b");
    const ul = container.querySelector("ul");
    expect(ul?.className).toContain("my-3");
    expect(ul?.className).toContain("list-disc");
    expect(ul?.className).toContain("space-y-1.5");
    expect(ul?.className).toContain("marker:text-foreground-subtlest");
    const li = container.querySelector("li");
    expect(li?.className).toContain("pl-1");
  });

  it("renders blockquote on the ZCode scale (border-l-2 pl-3, subtle text)", () => {
    const { container } = renderAgentText("> quoted words");
    const blockquote = container.querySelector("blockquote");
    expect(blockquote?.className).toContain("my-4");
    expect(blockquote?.className).toContain("border-l-2");
    expect(blockquote?.className).toContain("pl-3");
    expect(blockquote?.className).toContain("text-foreground-subtle");
  });

  it("renders links on the ZCode scale (icon-blue, dotted, underline on hover)", () => {
    const { container } = renderAgentText("[example](https://example.com)");
    const a = container.querySelector("a");
    expect(a?.className).toContain("text-ui-base");
    expect(a?.className).toContain("font-medium");
    expect(a?.className).toContain("text-icon-blue");
    expect(a?.className).toContain("no-underline");
    expect(a?.className).toContain("decoration-dotted");
    expect(a?.className).toContain("hover:underline");
  });

  describe("tables (the ZCode markdown-table scale)", () => {
    const tableMarkdown = "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |";

    it("wraps the table in a bordered, horizontally-scrollable frame", () => {
      const { container } = renderAgentText(tableMarkdown);
      const table = container.querySelector("table");
      const frame = table?.parentElement;
      expect(frame?.className).toContain("overflow-x-auto");
      expect(frame?.className).toContain("rounded-xl");
      expect(frame?.className).toContain("border-border");
      // The table itself is content-width but at least fills the frame.
      expect(table?.className).toContain("w-max");
      expect(table?.className).toContain("min-w-full");
    });

    it("styles header cells (px-3 py-2, border-b, unbolded, subtle)", () => {
      const { container } = renderAgentText(tableMarkdown);
      const th = container.querySelector("th");
      expect(th?.className).toContain("px-3");
      expect(th?.className).toContain("py-2");
      expect(th?.className).toContain("border-b");
      expect(th?.className).toContain("border-border");
      expect(th?.className).toContain("font-normal");
      expect(th?.className).toContain("text-foreground-subtlest");
      expect(th?.className).toContain("text-left");
    });

    it("styles body cells (px-3 py-2, border-b, align-top, wrapping)", () => {
      const { container } = renderAgentText(tableMarkdown);
      const td = container.querySelector("td");
      expect(td?.className).toContain("px-3");
      expect(td?.className).toContain("py-2");
      expect(td?.className).toContain("border-b");
      expect(td?.className).toContain("border-border");
      expect(td?.className).toContain("align-top");
      expect(td?.className).toContain("break-words");
    });

    it("highlights rows on hover and drops the last row's border", () => {
      const { container } = renderAgentText(tableMarkdown);
      const tr = container.querySelector("tbody tr");
      expect(tr?.className).toContain("hover:bg-hover/20");
      expect(tr?.className).toContain("last:[&>td]:border-b-0");
    });
  });
});

/**
 * A transcript anchor is an **External open** (ADR 0051), never a navigation of
 * the Client's own webview — which is what a bare `<a href>` did before (and the
 * bug the user reported: clicking a link in an agent's reply replaced the app).
 * These tests pin the three things that make that true, through the REAL
 * `ReactMarkdown` renderer rather than by inspecting the component:
 * (1) the click goes to `external_open` with the context cwd; (2) the click is
 * CANCELLED, so no navigation is even attempted; (3) the `href` SURVIVES to the
 * DOM for the schemes the Rust policy allows — which needs `safeUrlTransform`,
 * because `react-markdown`'s own filter blanks everything outside
 * `http|https|irc|ircs|mailto|xmpp` and would make the wide policy unreachable.
 */
describe("AgentMarkdown links (External open)", () => {
  const anchor = (container: HTMLElement) =>
    container.querySelector("a") as HTMLAnchorElement;

  it("keeps the href and External-opens it on click, with no cwd outside the provider", () => {
    const { container } = renderAgentText("[docs](https://x.test/a)");
    const a = anchor(container);
    expect(a.getAttribute("href")).toBe("https://x.test/a");
    // `fireEvent.click` returns FALSE when the handler called `preventDefault`
    // — the pin for "this anchor cannot navigate the Client" (a bare `<a>`
    // returns true, i.e. the browser would have navigated).
    expect(fireEvent.click(a)).toBe(false);
    expect(externalOpen).toHaveBeenCalledTimes(1);
    expect(externalOpen).toHaveBeenCalledWith("https://x.test/a", null);
  });

  it("resolves a relative path against the provider's Space cwd", () => {
    const { container } = renderAgentText(
      "[main.rs](src/main.rs)",
      "/home/u/proj",
    );
    const a = anchor(container);
    expect(a.getAttribute("href")).toBe("src/main.rs");
    fireEvent.click(a);
    // The cwd is the whole point of the provider: `main.rs` means
    // `<Space>/main.rs`, and Rust owns the join (a Windows join is not a `/`).
    expect(externalOpen).toHaveBeenCalledWith("src/main.rs", "/home/u/proj");
  });

  it("refuses a relative path when the Space is known to be absent (cwd null inside the provider)", () => {
    // The in-tree "no active Session" state. `external_open` answers
    // `relative-without-cwd`; the Client must not invent a base.
    const { container } = renderAgentText("[main.rs](src/main.rs)", null);
    fireEvent.click(anchor(container));
    expect(externalOpen).toHaveBeenCalledWith("src/main.rs", null);
  });

  it("carries the allowed schemes through to the DOM (ssh:// / slack:// / file://)", () => {
    // THE regression this pins: react-markdown's DEFAULT `urlTransform` returns
    // `""` for anything outside `http|https|irc|ircs|mailto|xmpp`, so without
    // `safeUrlTransform` these render `href=""` and the Rust-side policy never
    // sees them. If this test passes BEFORE the override exists, the renderer is
    // not the default filter — investigate rather than moving on.
    for (const href of ["ssh://host/repo", "slack://join", "file:///tmp/x"]) {
      const { container } = renderAgentText(`[GH](${href})`);
      expect(anchor(container).getAttribute("href"), href).toBe(href);
    }
  });

  it("renders an executable scheme as an empty href, and does not throw", () => {
    // The href is blanked BEFORE the DOM (so no script-bearing href is ever in
    // it — a middle click or an `Enter` on a focused anchor does not pass
    // through a cancelable click), and the click hands `""` to Rust, which
    // refuses it as `empty`.
    const { container } = renderAgentText("[x](javascript:alert(1))");
    const a = anchor(container);
    expect(a.getAttribute("href")).toBe("");
    expect(() => fireEvent.click(a)).not.toThrow();
    expect(externalOpen).toHaveBeenCalledWith("", null);
  });

  it("rides the GFM autolink literal for a bare URL in prose (same handler)", () => {
    // `remark-gfm@4` already turns a bare `https://…` into a link node, so the
    // autolink inherits all of the above with no extra code — pinned here so a
    // future "let's add a prose linkifier" is visibly redundant.
    const { container } = renderAgentText("see https://x.test/a");
    const a = anchor(container);
    expect(a.getAttribute("href")).toBe("https://x.test/a");
    expect(a.textContent).toBe("https://x.test/a");
    fireEvent.click(a);
    expect(externalOpen).toHaveBeenCalledWith("https://x.test/a", null);
  });

  it("leaves inline code inert (no anchor inside a code span)", () => {
    const { container } = renderAgentText("run `https://x.test/a` now");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe(
      "https://x.test/a",
    );
  });
});

/**
 * The transform in isolation. The External-open POLICY is Rust-side (ADR 0051);
 * this function exists only to stop `react-markdown` blanking the schemes the
 * policy ALLOWS, while still refusing the executable ones so no script-bearing
 * href is ever in the DOM. It is deliberately NOT percent-encoding — the href
 * reaches the OS verbatim.
 */
describe("safeUrlTransform", () => {
  it("passes through the destinations whose scheme Rust decides (or that have none)", () => {
    for (const url of [
      "https://a",
      "a/b.md",
      "C:/x",
      "ssh://h/r",
      "slack://join",
      "file:///tmp/x",
      "mailto:a@b.test",
      "#fragment",
      "?q=1",
    ]) {
      expect(safeUrlTransform(url), url).toBe(url);
    }
  });

  it("refuses the executable schemes, case-insensitively", () => {
    expect(safeUrlTransform("JavaScript:alert(1)")).toBe("");
    expect(safeUrlTransform("javascript:alert(1)")).toBe("");
    expect(safeUrlTransform("data:text/html,x")).toBe("");
    expect(safeUrlTransform("VBScript:msgbox(1)")).toBe("");
    expect(safeUrlTransform("blob:https://a/uuid")).toBe("");
    expect(safeUrlTransform("filesystem:http://a/p")).toBe("");
  });

  it("refuses a scheme that is not a legal scheme token (java%09script:)", () => {
    // THE row that earns the scheme-shape test its place. micromark hands this
    // function an ALREADY-percent-encoded destination, so markdown
    // `[x](java&#9;script:alert(1))` arrives as `java%09script:alert(1)`. A `%`
    // is illegal in a scheme, so the token before `:` fails the shape test —
    // without it this override would let through a class the DEFAULT filter
    // refused. (Rust normalises tabs/newlines before it parses; this layer does
    // not need to, because it refuses the encoded form outright.)
    expect(safeUrlTransform("java%09script:alert(1)")).toBe("");
    expect(safeUrlTransform("java%0Ascript:alert(1)")).toBe("");
  });

  it("treats a colon that is not a scheme separator as relative", () => {
    // `docs/notes:2024.md` and `a?b:c#d:p` are paths/queries, not schemes — the
    // first `/`, `?` or `#` before the `:` decides that (and Rust owns what the
    // path means).
    expect(safeUrlTransform("docs/notes:2024.md")).toBe("docs/notes:2024.md");
    expect(safeUrlTransform("a?b:c")).toBe("a?b:c");
    expect(safeUrlTransform("a#b:c")).toBe("a#b:c");
    expect(safeUrlTransform("")).toBe("");
  });

  it("is what the markdown renderer runs, so `ssh://` reaches the DOM", () => {
    // The wiring pin: the DOM case above proves the override is installed, but
    // this states the causality — the DEFAULT transform is what broke `ssh://`.
    expect(safeUrlTransform("ssh://h/r")).toBe("ssh://h/r");
  });
});

