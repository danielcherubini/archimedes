import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import QueueRows from "./QueueRows";
import { useQueuedPrompts, type QueuedPrompt } from "../../store/queuedPrompts";

/**
 * FULL matchMedia stub — the `braille-loader.test.tsx` / `ChatStream.test.tsx`
 * idiom, required here too because `QueueRows` renders real `QueueRow`s and a
 * row reads the reduced-motion query. The stub answers `matches: false`, so the
 * rows take the MOTION path and mid-exit entries stay mounted (a
 * reduced-motion row calls `forget` on the same tick, which would empty the
 * store under the assertions below).
 */
function installMatchMediaStub(reduced: boolean) {
  const impl = ((q: string) => ({
    matches: q === "(prefers-reduced-motion: reduce)" ? reduced : false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as (q: string) => MediaQueryList;
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = impl;
  }
  return vi.spyOn(window, "matchMedia").mockImplementation(impl);
}

const SESSION = "s-stack";
const OTHER = "s-other";

function prompt(id: string, over: Partial<QueuedPrompt> = {}): QueuedPrompt {
  return { id, text: `prompt ${id}`, attachments: [], state: "queued", ...over };
}

function seed(list: QueuedPrompt[] | undefined) {
  act(() =>
    useQueuedPrompts.setState({
      bySession: list === undefined ? {} : { [SESSION]: list },
    }),
  );
}

/** The rendered row texts, top of the stack first. */
function rowTexts(): string[] {
  return screen
    .getAllByTestId("queue-row")
    .map((row) => row.textContent ?? "");
}

beforeEach(() => {
  installMatchMediaStub(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => useQueuedPrompts.setState({ bySession: {} }));
});

describe("QueueRows", () => {
  it("renders nothing when the session has no queue at all", () => {
    seed(undefined);
    const { container } = render(<QueueRows sessionId={SESSION} />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing for an empty list", () => {
    seed([]);
    const { container } = render(<QueueRows sessionId={SESSION} />);
    expect(container.textContent).toBe("");
  });

  it("renders a list whose every entry is mid-exit — those rows are the ones animating out", () => {
    seed([prompt("p1", { leaving: "sent" }), prompt("p2", { leaving: "deleted" })]);
    const { container } = render(<QueueRows sessionId={SESSION} />);
    // A row's exit is the `leaving` field on `animate`, and `forget` runs from
    // `onAnimationComplete` — so a row has to STAY MOUNTED to finish leaving.
    // Gating on `livePrompts` here would unmount exactly these rows, their
    // animation would never run, `forget` would never be called, and the
    // entries would sit `leaving` in `bySession` until `clearSession`.
    expect(rowTexts()).toHaveLength(2);
    expect(container.textContent).toContain("prompt p1");
    expect(container.textContent).toContain("prompt p2");
    // No drain awaited here, deliberately: an entry SEEDED already-`leaving`
    // mounts straight onto its exit target, so motion reports no animation and
    // therefore no completion (measured). That state is the stranded phantom
    // this gate exists to prevent, not a production shape — the two cases below
    // drive a real live→leaving edge, which DOES change `animate` and DOES reach
    // `forget` and empty the store.
  });

  it("keeps the LAST live row mounted when it is deleted, then drains to nothing", async () => {
    seed([prompt("only")]);
    const { container } = render(<QueueRows sessionId={SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete queued prompt" }));
    // THE DEFECT THIS PINS: `markLeaving` and the unmount gate used to land on
    // the same render, so the row vanished instead of flying right. It must
    // still be in the DOM on the tick the delete lands.
    expect(screen.queryAllByTestId("queue-row")).toHaveLength(1);
    expect(container.textContent).toContain("prompt only");
    // And once its exit animation ends, the entry is gone from the store and
    // the stack collapses — no phantom, no band above the composer.
    await waitFor(() =>
      expect(useQueuedPrompts.getState().bySession[SESSION]).toBeUndefined(),
    );
    expect(screen.queryAllByTestId("queue-row")).toHaveLength(0);
    expect(container.textContent).toBe("");
  });

  it("drains a row taken by Flush to the transcript instead of stranding it", async () => {
    seed([prompt("head"), prompt("tail")]);
    const { container } = render(<QueueRows sessionId={SESSION} />);
    // `takeHead` MARKS the entry `leaving: "sent"` (it does not remove it), so
    // this is the other exit path the gate has to keep mounted.
    act(() => useQueuedPrompts.getState().takeHead(SESSION));
    expect(screen.queryAllByTestId("queue-row")).toHaveLength(2);
    await waitFor(() =>
      expect(
        useQueuedPrompts
          .getState()
          .bySession[SESSION]?.map((p) => p.id),
      ).toEqual(["tail"]),
    );
    expect(container.textContent).toContain("prompt tail");
  });

  it("renders one row per entry, head first (nearest the transcript)", () => {
    seed([prompt("head"), prompt("middle"), prompt("newest")]);
    render(<QueueRows sessionId={SESSION} />);
    const texts = rowTexts();
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("prompt head");
    expect(texts[1]).toContain("prompt middle");
    expect(texts[2]).toContain("prompt newest");
  });

  it("keeps a mid-exit row mounted while its siblings stay live", () => {
    seed([prompt("head"), prompt("going", { leaving: "sent" })]);
    render(<QueueRows sessionId={SESSION} />);
    const texts = rowTexts();
    // The leaving entry is rendered from `raw`, NOT from `livePrompts` — it is
    // the row currently animating out, and dropping it to "hide" it is exactly
    // what the `leaving` field exists to avoid.
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("prompt going");
    expect(texts[0]).toContain("prompt head");
  });

  it("shows only its own session's queue", () => {
    act(() =>
      useQueuedPrompts.setState({
        bySession: { [SESSION]: [prompt("mine")], [OTHER]: [prompt("theirs")] },
      }),
    );
    render(<QueueRows sessionId={SESSION} />);
    expect(screen.queryByText("prompt theirs")).toBeNull();
    expect(screen.getByText("prompt mine")).toBeTruthy();
  });

  it("every row wears bg-composer and no other background class (the palette pin)", () => {
    seed([prompt("head"), prompt("newest")]);
    render(<QueueRows sessionId={SESSION} />);
    for (const row of screen.getAllByTestId("queue-row")) {
      const backgrounds = row.className.split(/\s+/).filter((c) => c.includes("bg-"));
      expect(backgrounds).toEqual(["bg-composer"]);
    }
  });
});
