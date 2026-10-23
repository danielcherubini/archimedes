import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRef } from "react";
import type { RefObject } from "react";
import { useAutoGrowComposer } from "./useAutoGrowComposer";

/**
 * The composer's auto-grow (moved verbatim out of `ChatStream` by Phase D's Task
 * D4). jsdom has NO layout, so `scrollHeight` / `offsetHeight` / `clientHeight`
 * are all `0` and every assertion here has to install them — which is fine,
 * because the hook's whole contract is the arithmetic it does on those three
 * numbers and when it re-runs.
 *
 * The border term is the part worth pinning: `scrollHeight` is the CONTENT
 * height and `style.height` is the BORDER box, so a height of exactly
 * `scrollHeight` is short by the border and flickers a scrollbar near the
 * `max-h-32` clamp. Hence `scrollHeight + offsetHeight - clientHeight`.
 */

/** A real `<textarea>` in the document, with the three layout numbers under
 * test made settable (jsdom reports 0 for all of them). */
function attachTextarea(layout: {
  scrollHeight: number;
  offsetHeight: number;
  clientHeight: number;
}): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  Object.defineProperties(el, {
    scrollHeight: { get: () => layout.scrollHeight, configurable: true },
    offsetHeight: { get: () => layout.offsetHeight, configurable: true },
    clientHeight: { get: () => layout.clientHeight, configurable: true },
  });
  document.body.appendChild(el);
  return el;
}

/** The height the hook writes, parsed back to a number (`""` before the first
 * `apply()`). */
function writtenHeight(el: HTMLTextAreaElement): string {
  return el.style.height;
}

let el: HTMLTextAreaElement | undefined;

beforeEach(() => {
  el = undefined;
});

afterEach(() => {
  el?.remove();
  el = undefined;
});

/** Mount the hook against a ref pointing at `el`, with `draft` as the dep. */
function mount(
  layout: {
    scrollHeight: number;
    offsetHeight: number;
    clientHeight: number;
  },
  draft = "",
) {
  el = attachTextarea(layout);
  const element = el;
  return renderHook(
    ({ draft }: { draft: string }) => {
      const ref = useRef<HTMLTextAreaElement | null>(element);
      useAutoGrowComposer(ref, draft);
    },
    { initialProps: { draft } },
  );
}

describe("useAutoGrowComposer (the composer textarea sizes to its content)", () => {
  it("sizes to scrollHeight + the border on mount", () => {
    const element = attachTextarea({
      scrollHeight: 48,
      offsetHeight: 50,
      clientHeight: 48,
    });
    el = element;
    renderHook(() => {
      const ref = useRef<HTMLTextAreaElement | null>(element);
      useAutoGrowComposer(ref, "hello");
    });
    // 48 content + (50 − 48) border = 50.
    expect(writtenHeight(element)).toBe("50px");
  });

  it("re-applies when the draft changes (a taller draft must grow without a resize)", () => {
    const layout = { scrollHeight: 20, offsetHeight: 22, clientHeight: 20 };
    const { rerender } = mount(layout, "one line");
    expect(writtenHeight(el!)).toBe("22px");
    layout.scrollHeight = 60;
    layout.offsetHeight = 62;
    layout.clientHeight = 60;
    act(() => {
      rerender({ draft: "many\nmore\nlines\nhere" });
    });
    expect(writtenHeight(el!)).toBe("62px");
  });

  it("re-applies on a window resize (a stale height would linger until the next keystroke)", () => {
    const layout = { scrollHeight: 20, offsetHeight: 20, clientHeight: 20 };
    mount(layout, "same draft");
    expect(writtenHeight(el!)).toBe("20px");
    layout.scrollHeight = 40;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(writtenHeight(el!)).toBe("40px");
  });

  it("stops listening for resizes after unmount", () => {
    const layout = { scrollHeight: 20, offsetHeight: 20, clientHeight: 20 };
    const { unmount } = mount(layout, "");
    unmount();
    layout.scrollHeight = 999;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    // Still the mount-time height: the listener is gone, so nothing re-applied.
    expect(writtenHeight(el!)).toBe("20px");
  });

  it("is a no-op when the ref has no element yet (the composer is not mounted)", () => {
    expect(() => {
      renderHook(() => {
        const ref: RefObject<HTMLTextAreaElement | null> = { current: null };
        useAutoGrowComposer(ref, "draft");
      });
    }).not.toThrow();
  });
});
