import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AskQuestionCard from "./AskQuestionCard";
import { useInteractive } from "../store/interactive";

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    respondInteractiveRequest: vi.fn().mockResolvedValue(undefined),
  };
});

import { respondInteractiveRequest } from "../lib/tauri";

const mockedRespond = vi.mocked(respondInteractiveRequest);

const singleRequest = {
  requestId: "r1",
  method: "ask" as const,
  source: "main",
  params: {
    questions: [
      {
        id: "q1",
        question: "Which color?",
        options: [{ label: "Red" }, { label: "Blue" }],
      },
    ],
  },
};

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  useInteractive.getState().dismissSession("s1");
  mockedRespond.mockReset();
  mockedRespond.mockResolvedValue(undefined);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  if (originalScrollIntoView === undefined) {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  } else {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  }
  vi.restoreAllMocks();
});

describe("AskQuestionCard", () => {
  it("renders the question and its options", () => {
    useInteractive.getState().addRequest("s1", singleRequest);
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Blue" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Other (type your own)" }),
    ).toBeTruthy();
  });

  it("renders nothing when no request is pending for the id", () => {
    const { container } = render(
      <AskQuestionCard sessionId="s1" requestId="missing" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("submits the selected option via respondInteractiveRequest and collapses", async () => {
    useInteractive.getState().addRequest("s1", singleRequest);
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", {
        cancelled: false,
        results: [{ id: "q1", selectedOptions: ["Red"] }],
      }),
    );
    // The card collapses: the request is removed from the store.
    expect(useInteractive.getState().requests["s1"]).toHaveLength(0);
  });

  it("collects multiple selections for a multi question", async () => {
    useInteractive.getState().addRequest("s1", {
      requestId: "r1",
      method: "ask",
      source: "main",
      params: {
        questions: [
          {
            id: "q1",
            question: "Pick some",
            multi: true,
            options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
          },
        ],
      },
    });
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", {
        cancelled: false,
        results: [{ id: "q1", selectedOptions: ["Red", "Blue"] }],
      }),
    );
  });

  it("renders the ask treatment (tint header, question + options, fill on select)", () => {
    useInteractive.getState().addRequest("s1", singleRequest);
    const { container } = render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    // The `--color-interaction-ask-*` treatment: a `bg-interaction-ask-surface`
    // tint header with the label in the ask foreground.
    const header = container.querySelector(
      ".bg-interaction-ask-surface",
    )!;
    expect(header).toBeTruthy();
    expect(
      header.querySelector(".text-interaction-ask-foreground")?.textContent,
    ).toBe("Agent question");
    // The option list renders the question + options.
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Blue" })).toBeTruthy();
    // No option is selected yet: no `bg-interaction-ask-fill`.
    expect(container.querySelector(".bg-interaction-ask-fill")).toBeNull();
    // Selecting an option gets the ask-fill treatment.
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    expect(container.querySelector(".bg-interaction-ask-fill")).toBeTruthy();
  });

  it("receives focus on mount when unanchored (Enter/Esc are live)", () => {
    useInteractive.getState().addRequest("s1", singleRequest);
    const { container } = render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    // A `main` ask without a `toolCallId` is unanchored: the card takes
    // focus on mount so the keyboard shortcuts work immediately (a
    // `focus-visible` ring is the visible indicator — `outline-none` would
    // suppress it).
    expect(document.activeElement).toBe(container.firstChild);
  });

  it("does NOT take focus on mount with `autoFocus={false}` (a lifted child card)", () => {
    // A child gate is lifted into its PARENT's transcript (or the overlay), and
    // it can NEVER anchor: `anchored` needs `source === "main"` AND a
    // `toolCallId`, and a child's `interactive-request` carries neither — the
    // backend emits `"native"` for both of its emitters (`ask_flow` in
    // `src-tauri/src/agent/harness/ask.rs`, and the sudo sub-prompts in
    // `src-tauri/src/agent/interactive/mod.rs`, which the `AgentLoop`'s
    // `sudo_exec` arm hands `"native"` too) with `toolCallId: null` on both.
    // So the unanchored auto-focus above would fire for EVERY child ask —
    // yanking focus out of the composer mid-keystroke. `autoFocus={false}` is how
    // both lifted sites opt out; the shortcuts still work once the user clicks
    // into the card. (Not that `source` could carry that check alone: the only
    // value the desktop's transport really emits is `native` — `main` and `sudo`
    // exist only in fixtures, `bin/fake_worker.rs` and the Rust gate fixtures — so
    // a `subagent:<name>` test value here exercises the store's shape and the
    // label branch, not a string the transport sends.)
    useInteractive.getState().addRequest("s1", {
      ...singleRequest,
      source: "subagent:reviewer",
    });
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    const { container } = render(
      <AskQuestionCard sessionId="s1" requestId="r1" autoFocus={false} />,
    );
    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(container.firstChild);
    input.remove();
  });

  it("labels a subagent request by its source", () => {
    useInteractive.getState().addRequest("s1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:x",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which color?",
            options: [{ label: "Red" }],
          },
        ],
      },
    });
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    expect(screen.getByText("subagent:x")).toBeTruthy();
  });

  it("cancels with cancelled=true and empty results, and collapses", async () => {
    useInteractive.getState().addRequest("s1", singleRequest);
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", {
        cancelled: true,
        results: [],
      }),
    );
    expect(useInteractive.getState().requests["s1"]).toHaveLength(0);
  });

  it("sends customInput for the Other option", async () => {
    useInteractive.getState().addRequest("s1", singleRequest);
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Other (type your own)" }),
    );
    fireEvent.change(screen.getByPlaceholderText("Type your own answer"), {
      target: { value: "purple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", {
        cancelled: false,
        results: [{ id: "q1", selectedOptions: [], customInput: "purple" }],
      }),
    );
  });

  it("sends the option note as a 'label - note' entry", async () => {
    useInteractive.getState().addRequest("s1", singleRequest);
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    fireEvent.change(screen.getByPlaceholderText("note (optional)"), {
      target: { value: "the warm one" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", {
        cancelled: false,
        results: [{ id: "q1", selectedOptions: ["Red - the warm one"] }],
      }),
    );
  });

  it("shows a (Recommended) suffix on the recommended option", () => {
    useInteractive.getState().addRequest("s1", {
      requestId: "r1",
      method: "ask",
      source: "main",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which color?",
            recommended: 0,
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
    });
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    expect(screen.getByText("Red (Recommended)")).toBeTruthy();
  });

  it("sends one result per question for a multi-question ask", async () => {
    useInteractive.getState().addRequest("s1", {
      requestId: "r1",
      method: "ask",
      source: "main",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which color?",
            options: [{ label: "Red" }, { label: "Blue" }],
          },
          {
            id: "q2",
            question: "Which shape?",
            options: [{ label: "Square" }, { label: "Circle" }],
          },
        ],
      },
    });
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    fireEvent.click(screen.getByRole("button", { name: "Circle" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", {
        cancelled: false,
        results: [
          { id: "q1", selectedOptions: ["Blue"] },
          { id: "q2", selectedOptions: ["Circle"] },
        ],
      }),
    );
  });

  it("scrolls footer into view when an option is selected", async () => {
    useInteractive.getState().addRequest("s1", singleRequest);
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    const footer = screen.getByTestId("ask-footer");
    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: "nearest",
        behavior: "smooth",
      });
      const scrollMock = vi.mocked(Element.prototype.scrollIntoView);
      expect(scrollMock.mock.contexts).toContain(footer);
    });
  });

  it("scrolls footer into view when 'Other (type your own)' is selected", async () => {
    useInteractive.getState().addRequest("s1", singleRequest);
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Other (type your own)" }),
    );
    const footer = screen.getByTestId("ask-footer");
    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: "nearest",
        behavior: "smooth",
      });
      const scrollMock = vi.mocked(Element.prototype.scrollIntoView);
      expect(scrollMock.mock.contexts).toContain(footer);
    });
  });

  it("does not trigger scrollIntoView when typing into the note input", async () => {
    useInteractive.getState().addRequest("s1", singleRequest);
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    const noteInput = screen.getByPlaceholderText("note (optional)");
    fireEvent.change(noteInput, { target: { value: "some note" } });

    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
