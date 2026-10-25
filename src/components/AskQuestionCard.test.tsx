import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AskQuestionCard, { isAskRowRenderable } from "./AskQuestionCard";
import type { InteractiveRequestData } from "../store/interactive";
import { useInteractive } from "../store/interactive";
import { useSubagents } from "../store/subagents";
import { resetStores } from "../test/resetStores";

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
  // Every store back to its own initial state. The hand-written version named
  // three sessions to dismiss (`s1`, `child1` twice); `resetStores` covers those
  // plus every key this file never thought to clear.
  resetStores();
  mockedRespond.mockReset();
  mockedRespond.mockResolvedValue(undefined);
  // NOT the shared `setup.tsx` stub: this file asserts on the MOCK CONTEXTS of
  // `scrollIntoView`, so each case needs a FRESH mock, and the `afterEach`
  // below restores what was there at import. `src/test/setup.tsx`'s own
  // deletion checklist names this file for exactly that reason.
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

  it("cancels and clears a request it has no questions to draw, instead of stranding the session on an invisible gate", async () => {
    // The card renders nothing for an empty list, but the request is still a
    // GATE in the store (the sidebar `?`, a locked composer) and in the
    // Worker (the turn blocked). Nothing else can answer it, so the card must.
    useInteractive.getState().addRequest("s1", {
      ...singleRequest,
      params: { questions: [] },
    });
    const { container } = render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    expect(container.firstChild).toBeNull();
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", {
        cancelled: true,
        results: [],
      }),
    );
    await waitFor(() =>
      expect(useInteractive.getState().requests["s1"]).toHaveLength(0),
    );
  });

  it("does not auto-cancel a request that has questions", async () => {
    useInteractive.getState().addRequest("s1", singleRequest);
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedRespond).not.toHaveBeenCalled();
    expect(useInteractive.getState().requests["s1"]).toHaveLength(1);
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
    // `queued` gate's `isSubagent` arm, not a string the transport sends.)
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

  it("labels a child's ask by its RESOLVED agent name, never by the transport label", () => {
    // The label is keyed on the resolved name, NOT on `request.source`.
    // `source: "native"` is the value production actually emits — every
    // `interactive-request` the desktop builds carries it (`ask_flow` in
    // `src-tauri/src/agent/harness/ask.rs`, and the sudo sub-prompts in
    // `src-tauri/src/agent/interactive/mod.rs`), for a main session and a
    // Subagent session alike. A child's card is mounted with the CHILD's
    // session id (`TranscriptFooter` / `SubagentModals` pass
    // `gate.childSessionId`), which is exactly the key `useSubagents`
    // entries are stored under, so the name resolves from there.
    //
    // This is the ONLY shape that can prove the fix: the old
    // `"subagent:x"` fixture exercised a branch production never enters
    // (`isSubagent` needs a `subagent:` prefix no emitter sends), so a test
    // built on it would stay green even if the label resolved nothing.
    useSubagents.getState().addSession({
      sessionId: "child1",
      parentSessionId: "s1",
      agentName: "scout",
      task: "recon the auth code",
      status: "running",
    });
    useInteractive.getState().addRequest("child1", {
      requestId: "r1",
      method: "ask",
      source: "native",
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
    const { container } = render(
      <AskQuestionCard sessionId="child1" requestId="r1" autoFocus={false} />,
    );
    expect(screen.getByText("scout")).toBeTruthy();
    // The transport label is never user-facing copy (`native` is a transport
    // detail, never a name — CONTEXT.md's Todo board `_Avoid_` list).
    expect(container.textContent).not.toContain("native");
    expect(screen.queryByText("Agent question")).toBeNull();
  });

  it("labels the queued placeholder of a child's ask by the resolved name too", () => {
    // The queued arm (the request arrived before any `tool_call` frame) is a
    // second label site, and it has the same problem: it rendered
    // `${request.source} is asking…` behind the dead `isSubagent` gate. A
    // `native` frame with a `toolCallId` is exactly what reaches it.
    useSubagents.getState().addSession({
      sessionId: "child1",
      parentSessionId: "s1",
      agentName: "scout",
      task: "recon the auth code",
      status: "running",
    });
    useInteractive.getState().addRequest("child1", {
      requestId: "r1",
      method: "ask",
      source: "native",
      toolCallId: "t1",
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
    const { container } = render(
      <AskQuestionCard sessionId="child1" requestId="r1" autoFocus={false} />,
    );
    expect(screen.getByText("scout is asking…")).toBeTruthy();
    expect(container.textContent).not.toContain("native");
  });

  it("falls back to the generic label when the child has NO agent name (a config-less dispatch)", () => {
    // `SubagentEntry.agentName` is a required string and the Rust dispatch
    // writes `""` for an omitted/unknown `agentName`
    // (`src-tauri/src/agent/harness/dispatch.rs`, `unwrap_or_default()` — a
    // config-less, label-only dispatch). So a nullish coalesce would render
    // an EMPTY label between the accent rules; the check must be truthiness.
    useSubagents.getState().addSession({
      sessionId: "child1",
      parentSessionId: "s1",
      agentName: "",
      task: "recon the auth code",
      status: "running",
    });
    useInteractive.getState().addRequest("child1", {
      requestId: "r1",
      method: "ask",
      source: "native",
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
    const { container } = render(
      <AskQuestionCard sessionId="child1" requestId="r1" autoFocus={false} />,
    );
    expect(screen.getByText("Agent question")).toBeTruthy();
    expect(container.textContent).not.toContain("native");
  });

  it("falls back to a generic Agent label when no agent name resolves", () => {
    // A MAIN session's own ask has no `useSubagents` entry under its id, so
    // nothing resolves and the generic copy renders — the fallback is the
    // normal path for a main session, not an error state.
    useInteractive.getState().addRequest("s1", {
      requestId: "r1",
      method: "ask",
      source: "native",
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
    const { container } = render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    expect(screen.getByText("Agent question")).toBeTruthy();
    expect(container.textContent).not.toContain("native");
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

  it("announces a failed submit through role=\"alert\" with the pre-migration classes", async () => {
    // Task C3 (finding 7): the failure line was a bare `<p>`, so a
    // screen-reader user who submitted an answer into a dead IPC channel heard
    // nothing at all.
    useInteractive.getState().addRequest("s1", singleRequest);
    mockedRespond.mockRejectedValueOnce("ask-response failed");
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("ask-response failed");
    // Byte-identical to the hand-written `px-3 pb-2 text-ui-sm text-destructive`
    // line this replaced, so the card's height and padding do not move.
    expect(alert.getAttribute("class")).toBe(
      "text-ui-sm text-destructive px-3 pb-2",
    );
    // And a failed answer keeps the card: the request is NOT removed, so the
    // gate stays answerable (ADR 0040 — a gate rendered nowhere strands the run).
    expect(useInteractive.getState().requests["s1"]).toHaveLength(1);
  });

  it("renders no alert region while nothing has failed", () => {
    useInteractive.getState().addRequest("s1", singleRequest);
    render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/**
 * `isAskRowRenderable` — the ONE emptiness rule shared by this card and
 * `MessageList`'s anchored row (issue #86: a row whose ask had nothing to draw
 * was emitted padded and empty instead of not at all).
 *
 * Tested here, in the component's own file, because the predicate lives in
 * `AskQuestionCard.tsx`. A separate file would have had to mock `../lib/tauri`,
 * and `src/lib/tauriBarrel.test.ts:390` pins how many test files may do that.
 */
describe("isAskRowRenderable", () => {
  const request = (params: Record<string, unknown>): InteractiveRequestData => ({
    requestId: "r1",
    method: "ask",
    source: "main",
    toolCallId: "call_ask",
    params,
  });

  it("is true for a request carrying at least one question", () => {
    expect(isAskRowRenderable(request({ questions: singleRequest.params.questions }))).toBe(
      true,
    );
  });

  it("is false for a request with `questions: []` — the card renders nothing", () => {
    expect(isAskRowRenderable(request({ questions: [] }))).toBe(false);
  });

  it("is false for a request whose params carry no `questions` at all", () => {
    expect(isAskRowRenderable(request({}))).toBe(false);
  });

  it("is false for `undefined` — the dismissed request the anchor still points at", () => {
    expect(isAskRowRenderable(undefined)).toBe(false);
  });

  it("agrees with the card: a request it calls unrenderable renders no DOM", () => {
    // The pairing that matters — card and row must never disagree, which is why
    // both call this function instead of re-spelling the condition.
    useInteractive.getState().addRequest("s1", request({ questions: [] }));
    const { container } = render(<AskQuestionCard sessionId="s1" requestId="r1" />);
    expect(isAskRowRenderable(useInteractive.getState().requests["s1"]?.[0])).toBe(false);
    expect(container.firstChild).toBeNull();
  });
});
