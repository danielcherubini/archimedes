import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWindowDropBackstop } from "./useWindowDropBackstop";

/**
 * The window-level file-drop backstop (moved verbatim out of `ChatStream` by
 * Phase D's Task D4). The behaviour is one sentence: a native file drop anywhere
 * in the webview must be SWALLOWED, because with `dragDropEnabled: false` the
 * webview's default for a drop is to NAVIGATE to the dropped file and replace
 * the app.
 *
 * `preventDefault` is the whole mechanism, and jsdom reports it faithfully: a
 * cancelable `Event` dispatched on `window` carries `defaultPrevented`, so this
 * file asserts the mechanism directly rather than through a component. The
 * composer's own `onDrop` (which STAGES the files) is tested in
 * `ChatStream.test.tsx`; nothing here duplicates it.
 */

/** A cancelable drop event — `cancelable` is what makes `defaultPrevented` mean
 * anything (a non-cancelable event can never be prevented). */
const drop = () => new Event("drop", { bubbles: true, cancelable: true });
const dragOver = () =>
  new Event("dragover", { bubbles: true, cancelable: true });

describe("useWindowDropBackstop (a dropped file must never navigate the webview)", () => {
  it("a window-level `drop` is prevented while mounted", () => {
    renderHook(() => useWindowDropBackstop());
    const e = drop();
    act(() => {
      window.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
  });

  it("a window-level `dragover` is prevented too (it is what makes the page a valid drop target)", () => {
    renderHook(() => useWindowDropBackstop());
    const e = dragOver();
    act(() => {
      window.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
  });

  it("both listeners are gone after unmount (nothing prevents a drop the app no longer owns)", () => {
    const { unmount } = renderHook(() => useWindowDropBackstop());
    unmount();
    const d = drop();
    const o = dragOver();
    act(() => {
      window.dispatchEvent(d);
      window.dispatchEvent(o);
    });
    expect(d.defaultPrevented).toBe(false);
    expect(o.defaultPrevented).toBe(false);
  });

  it("mounting twice installs two listeners and unmounting one leaves the other (no shared module state)", () => {
    const a = renderHook(() => useWindowDropBackstop());
    a.unmount();
    renderHook(() => useWindowDropBackstop());
    const e = drop();
    act(() => {
      window.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
  });
});
