import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import QueueRow from "./QueueRow";
import { useQueuedPrompts, type QueuedPrompt } from "../../store/queuedPrompts";
import type { ChatComposerAttachment } from "../../lib/chatAttachments";

/**
 * FULL matchMedia stub (the `braille-loader.test.tsx` / `ChatStream.test.tsx`
 * idiom). This jsdom exposes the `window.matchMedia` PROPERTY but no function
 * behind it (`"matchMedia" in window === true`, `typeof window.matchMedia ===
 * "undefined"`), so a component that only tests `in window` throws the moment
 * it calls it; the component under test guards with `typeof … !== "function"`
 * and needs the function installed here either way.
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

const SESSION = "s-queue";

function attachment(id: string): ChatComposerAttachment {
  return {
    id,
    file: new File(["x"], `${id}.png`, { type: "image/png" }),
    filename: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1,
    objectUrl: `blob:mock-${id}.png`,
  };
}

function prompt(over: Partial<QueuedPrompt> = {}): QueuedPrompt {
  return {
    id: "p1",
    text: "fix the flaky test",
    attachments: [],
    state: "queued",
    ...over,
  };
}

/** The store is the ONLY source of the entry (the row reads `prompt.state` /
 *  `prompt.leaving` from it), so the harness mirrors what `QueueRows` does. */
function Harness({ sessionId }: { sessionId: string }) {
  const list = useQueuedPrompts((s) => s.bySession[sessionId]);
  return (
    <>
      {(list ?? []).map((p) => (
        <QueueRow key={p.id} sessionId={sessionId} prompt={p} />
      ))}
    </>
  );
}

// `act` on every seed: a `setState` that lands while a tree from the PREVIOUS
// test is still mounted re-renders it outside `act`, and React's warning is
// attributed to whichever test happens to be running — a wall of stderr on
// unrelated tests.
function seed(...prompts: QueuedPrompt[]) {
  act(() => useQueuedPrompts.setState({ bySession: { [SESSION]: prompts } }));
}

function entry(id = "p1"): QueuedPrompt | undefined {
  return useQueuedPrompts.getState().bySession[SESSION]?.find((p) => p.id === id);
}

beforeAll(() => {
  URL.createObjectURL = vi.fn((file: File) => `blob:mock-${file.name}`);
  URL.revokeObjectURL = vi.fn();
});

beforeEach(() => {
  installMatchMediaStub(false);
  seed(prompt());
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => useQueuedPrompts.setState({ bySession: {} }));
});

describe("QueueRow display state", () => {
  it("renders the Queued label as its own element, separate from the text", () => {
    render(<Harness sessionId={SESSION} />);
    const label = screen.getByText("Queued");
    // Its OWN element — never `"Queued: " + text`, or selecting the row's text
    // drags the label with it.
    expect(label.textContent).toBe("Queued");
    expect(label.tagName).toBe("SPAN");
    expect(screen.getByText("fix the flaky test")).toBeTruthy();
    expect(label.textContent).not.toContain("fix the flaky test");
  });

  it("wears the composer island's surface and introduces no other background", () => {
    render(<Harness sessionId={SESSION} />);
    const classes = screen
      .getByTestId("queue-row")
      .className.split(/\s+/)
      .filter((c) => c.includes("bg-"));
    // The palette pin: `bg-composer` is the token the response band and the
    // composer wear, and a row that invents a token fails
    // `paletteCompleteness.test.ts`.
    expect(classes).toEqual(["bg-composer"]);
  });

  it("shows the attachment count with a paperclip, not thumbnails", () => {
    seed(prompt({ attachments: [attachment("a1"), attachment("a2")] }));
    const { container } = render(<Harness sessionId={SESSION} />);
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByRole("img", { name: "2 image attachments" })).toBeTruthy();
    // No thumbnails in a one-line row — they belong to the editor.
    expect(container.querySelector("img")).toBeNull();
  });

  it("marks a failed entry with the existing destructive colour", () => {
    seed(prompt({ failed: true }));
    render(<Harness sessionId={SESSION} />);
    const label = screen.getByText("Failed");
    expect(label.className).toContain("text-destructive");
    // A failed entry is LIVE — its text still shows, it never sends by itself.
    expect(screen.getByText("fix the flaky test")).toBeTruthy();
  });

  it("enters edit when the row body is clicked", () => {
    render(<Harness sessionId={SESSION} />);
    fireEvent.click(screen.getByTestId("queue-row-body"));
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.value).toBe("fix the flaky test");
    expect(entry()?.state).toBe("editing");
  });

  it("enters edit when the pencil is clicked", () => {
    render(<Harness sessionId={SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit queued prompt" }));
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(entry()?.state).toBe("editing");
  });

  it("marks the entry as leaving-deleted when the trash is clicked", async () => {
    render(<Harness sessionId={SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete queued prompt" }));
    expect(entry()?.leaving).toBe("deleted");
    // Still in the DOM — the exit is driven by `leaving`, not by removal.
    expect(screen.getByTestId("queue-row")).toBeTruthy();
    // Awaiting the drain inside `act` (via `waitFor`): the exit animation lands
    // ~0.3s later, and letting it fire after this test returns updates the
    // harness outside `act` and floods the NEXT test's stderr with warnings.
    await waitFor(() =>
      expect(useQueuedPrompts.getState().bySession[SESSION]).toBeUndefined(),
    );
  });
});

describe("QueueRow inline editor", () => {
  function openEditor() {
    render(<Harness sessionId={SESSION} />);
    fireEvent.click(screen.getByTestId("queue-row-body"));
    return screen.getByRole("textbox") as HTMLTextAreaElement;
  }

  it("leaves edit on Escape AND stops the keydown from bubbling", () => {
    const outer = vi.fn();
    render(
      <div data-testid="outer" onKeyDown={outer}>
        <Harness sessionId={SESSION} />
      </div>,
    );
    fireEvent.click(screen.getByTestId("queue-row-body"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(entry()?.state).toBe("queued");
    // `ChatStream`'s window-level listener answers Escape with `session/cancel`
    // whenever `inTurn` — exactly while rows are on screen.
    expect(outer).not.toHaveBeenCalled();
  });

  it("disables Save for an empty edit", () => {
    const box = openEditor();
    fireEvent.change(box, { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("disables Save when nothing but an image marker is left and no attachment exists", () => {
    const box = openEditor();
    fireEvent.change(box, { target: { value: "[image #1]" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("Save writes the new text to the store and leaves edit", () => {
    const box = openEditor();
    fireEvent.change(box, { target: { value: "fix the OTHER flaky test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(entry()?.text).toBe("fix the OTHER flaky test");
    expect(entry()?.state).toBe("queued");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Save clears a failed entry (saving an edit IS the retry)", () => {
    seed(prompt({ failed: true }));
    const box = openEditor();
    fireEvent.change(box, { target: { value: "retry with a fresh idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(entry()?.failed).toBeUndefined();
    expect(entry()?.text).toBe("retry with a fresh idea");
  });

  it("Save runs on Enter, and Shift+Enter keeps editing", () => {
    const box = openEditor();
    fireEvent.change(box, { target: { value: "first line" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(entry()?.text).toBe("first line");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Shift+Enter does not save", () => {
    const box = openEditor();
    fireEvent.change(box, { target: { value: "draft still" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(entry()?.text).toBe("fix the flaky test");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("draft still");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("Cancel discards the draft and leaves the entry as found", () => {
    const box = openEditor();
    fireEvent.change(box, { target: { value: "abandoned" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(entry()?.text).toBe("fix the flaky test");
    expect(entry()?.state).toBe("queued");
    expect(entry()?.leaving).toBeUndefined();
  });

  it("re-opening the editor after a Cancel starts from the stored text", () => {
    render(<Harness sessionId={SESSION} />);
    fireEvent.click(screen.getByTestId("queue-row-body"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "abandoned" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByTestId("queue-row-body"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "fix the flaky test",
    );
  });

  it("removing an attachment drops the store entry's copy AND renumbers the draft", () => {
    seed(
      prompt({
        text: "[image #1] and [image #2]",
        attachments: [attachment("a1"), attachment("a2")],
      }),
    );
    render(<Harness sessionId={SESSION} />);
    fireEvent.click(screen.getByTestId("queue-row-body"));
    fireEvent.click(screen.getAllByLabelText("Remove image attachment")[0]);
    expect(
      useQueuedPrompts.getState().bySession[SESSION]?.[0].attachments.map((a) => a.id),
    ).toEqual(["a2"]);
    // Position 1 was computed BEFORE the filter, so `[image #1]` went with the
    // thumbnail and `[image #2]` came down to name the surviving picture.
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("and [image #1]");
  });
});

describe("QueueRow exit paths", () => {
  it("calls forget when the exit animation completes", async () => {
    seed(prompt({ leaving: "deleted" }));
    render(<Harness sessionId={SESSION} />);
    await waitFor(
      () => expect(useQueuedPrompts.getState().bySession[SESSION]).toBeUndefined(),
      { timeout: 5000 },
    );
  });

  it("reduced motion sends the trash straight to forget, so no row strands", () => {
    installMatchMediaStub(true);
    render(<Harness sessionId={SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete queued prompt" }));
    // NO await: with the animation suppressed there is no completion to wait
    // for, so anything but a same-tick `forget` strands this entry `leaving`
    // forever — hidden from `livePrompts`, skipped by `takeHead`, and the only
    // remover never called.
    expect(useQueuedPrompts.getState().bySession[SESSION]).toBeUndefined();
  });

  it("reduced motion renders a plain div (no motion wrapper)", () => {
    installMatchMediaStub(true);
    seed(prompt());
    render(<Harness sessionId={SESSION} />);
    const row = screen.getByTestId("queue-row");
    // A `motion.div` writes inline transform/will-change styles on mount; a
    // plain div carries only the class list.
    expect(row.getAttribute("style")).toBeNull();
  });
});
