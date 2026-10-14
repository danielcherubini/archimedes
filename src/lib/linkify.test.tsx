import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { linkifyText } from "./linkify";

// The primitives are rendered inside the element the real surfaces use them
// in — a `whitespace-pre-wrap break-words` run — so a test can assert the
// text is byte-identical (no collapsed space, no lost newline) and that no
// extra wrapper element crept in.
function renderText(text: string) {
  return render(
    <div className="whitespace-pre-wrap break-words">
      {linkifyText(text)}
    </div>,
  );
}

function anchorsOf(text: string) {
  const { container } = renderText(text);
  return Array.from(container.querySelectorAll("a"));
}

describe("linkifyText", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    // Asserted for EVERY render in this file, not just one case: React emits
    // the missing-`key` warning once per element type, so a single test
    // checking it could be silenced by an earlier render.
    expect(consoleError).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("links an http(s) URL and leaves the sentence's full stop in the text", () => {
    const { container } = renderText("see https://x.test/a and done.");
    const anchors = Array.from(container.querySelectorAll("a"));
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("https://x.test/a");
    expect(anchors[0].textContent).toBe("https://x.test/a");
    // The run is otherwise untouched text, full stop included.
    expect(container.textContent).toBe("see https://x.test/a and done.");
  });

  it("trims trailing punctuation off the URL, not into the href", () => {
    for (const [input, href] of [
      ["go to https://x.test/a.", "https://x.test/a"],
      ["go to https://x.test/a!", "https://x.test/a"],
      ["(see https://x.test/a)", "https://x.test/a"],
      ['said "https://x.test/a"', "https://x.test/a"],
      ["see https://x.test/a, then stop", "https://x.test/a"],
    ] as const) {
      const { container } = renderText(input);
      const anchors = Array.from(container.querySelectorAll("a"));
      expect(anchors).toHaveLength(1);
      expect(anchors[0].getAttribute("href")).toBe(href);
      // Nothing lost: the trimmed characters come back as text.
      expect(container.textContent).toBe(input);
    }
  });

  it("turns a www. literal into an http:// href while showing the original text", () => {
    const anchors = anchorsOf("visit www.foo.com today");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("http://www.foo.com");
    expect(anchors[0].textContent).toBe("www.foo.com");
  });

  it("links a mailto: literal", () => {
    const anchors = anchorsOf("mail mailto:a@b.c now");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("mailto:a@b.c");
  });

  it("does not linkify a schemeless scp-style git remote", () => {
    const { container } = renderText("git@github.com:x/y.git");
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.textContent).toBe("git@github.com:x/y.git");
  });

  it("keeps newlines in the surrounding text segments", () => {
    const { container } = renderText("a\nhttps://x.test\nb");
    const anchors = Array.from(container.querySelectorAll("a"));
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("https://x.test");
    expect(container.textContent).toBe("a\nhttps://x.test\nb");
  });

  it("renders a URL-free string byte-for-byte with no anchor and no element wrapper", () => {
    const text = "two  spaces, (parens), a — dash\n  indented line\tand a tab\n";
    const { container } = renderText(text);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.textContent).toBe(text);
    // The children are bare strings, so only the wrapper element exists.
    expect(container.querySelector("div")?.childElementCount).toBe(0);
  });

  it("links two URLs in one run, repeatably, without a console error", () => {
    const text = "see https://x.test/one and www.two.test end";
    const first = anchorsOf(text);
    expect(first).toHaveLength(2);
    expect(first.map((a) => a.getAttribute("href"))).toEqual([
      "https://x.test/one",
      "http://www.two.test",
    ]);
    // Called twice on the same input: the helper must be stateless between
    // calls (a `g` regex whose `lastIndex` leaks finds fewer matches here).
    const second = anchorsOf(text);
    expect(second).toHaveLength(2);
    // And every element in the returned array must carry a `key` — React's
    // missing-key warning is deduped per element type, which is why the
    // assertion lives in `afterEach` for every render in this file.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns nodes usable as children directly", () => {
    const nodes: ReactNode[] = linkifyText("see https://x.test");
    expect(nodes.length).toBeGreaterThan(1);
    expect(typeof nodes[0]).toBe("string");
  });
});
