/**
 * `MessageList`'s DELEGATION to the empty-state film — who it hands the empty
 * branch to, and under exactly which conditions it declines to.
 *
 * ## Why `./EmptyStateFilm` is mocked
 *
 * Task 5 (`EmptyStateFilm.test.tsx`) tests the film: its mode precedence, the
 * engine lifecycle, the 24 fps loop, the idle gates. This file must test the
 * OPPOSITE thing — that `MessageList` renders the film where the text hint used
 * to live, and renders nothing where the hint was suppressed. A real film here
 * would add a WebGL probe, a dynamic `import()` of the scene chunk, and a render
 * loop to every assertion about a boolean condition. So the module is replaced
 * with a marker that prints the prop it received into the DOM: `data-setting`
 * makes "the setting reached the film" an inspectable fact rather than an
 * inference, which is precisely the threading this mount is responsible for.
 *
 * The one exception is the last test, which un-mocks the module (and re-imports
 * `MessageList` fresh) to prove the shipped default is still the text line. With
 * the marker installed that statement cannot be made — the marker never prints
 * the hint.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import MessageList, { type MessageListProps } from "./MessageList";
import type { RenderUnit } from "../../lib/toolGroups";
import type { Message } from "../../store/sessions";

// No reference to a module-level const: `vi.mock` is hoisted above this file's
// imports and its factory runs while they are still initialising, so anything it
// closed over from below would be in its TDZ.
vi.mock("./EmptyStateFilm", () => ({
  default: ({ setting }: { setting: string | null }) => (
    <div data-testid="empty-film" data-setting={String(setting)} />
  ),
}));

const TEXT = "Send a prompt to start";

const textMsg = (id: string, text = "hello"): Message => ({
  kind: "agent-text",
  messageId: id,
  text,
  at: 1,
});

const single = (message: Message): RenderUnit => ({ kind: "single", message });

/**
 * The props of an idle, empty session — the state the film is meant for.
 *
 * `stopReason` is `null`-ish (`undefined`) so the footer is EMPTY by default and
 * the single footer assertion below is the only thing drawing a footer node.
 */
function makeProps(overrides: Partial<MessageListProps> = {}): MessageListProps {
  return {
    units: [],
    activeSessionId: "s1",
    inTurn: false,
    askRequests: [],
    prompts: [],
    stackedAskRequests: [],
    childGates: [],
    hasPendingRequest: false,
    workingOrInTurn: false,
    agentState: "idle",
    turnDiffs: [],
    stopReason: undefined,
    hasMore: false,
    loadingMore: false,
    generation: 0,
    onStartReached: () => {},
    ...overrides,
  };
}

afterEach(cleanup);

describe("MessageList: the empty branch delegates to the film", () => {
  it("renders the film for an idle empty session, with the setting threaded through", () => {
    // Two values, because a marker that always printed the same string would pass
    // with `setting` hard-coded anywhere in the chain.
    for (const setting of ["animated", "static", "off", null] as const) {
      const { unmount } = render(
        <MessageList {...makeProps({ emptyStateAnimation: setting })} />,
      );
      const film = screen.getByTestId("empty-film");
      expect(film.getAttribute("data-setting")).toBe(String(setting));
      unmount();
      cleanup();
    }
  });

  it("defaults the film to `off` when the prop is omitted", () => {
    // The prop is OPTIONAL and defaults to `"off"`, so a caller that knows nothing
    // about the feature (every pre-existing render in the suite) gets the text
    // line, not a canvas. `"off"` — not `null`, which means "the app default,
    // animated".
    render(<MessageList {...makeProps()} />);
    expect(screen.getByTestId("empty-film").getAttribute("data-setting")).toBe(
      "off",
    );
  });

  it("renders the film instead of the text hint", () => {
    // The film replaces the hint; it is not layered under it. (The hint returns
    // only when the FILM decides to fall back, which is Task 5's business.)
    render(<MessageList {...makeProps({ emptyStateAnimation: "animated" })} />);
    expect(screen.getByTestId("empty-film")).toBeTruthy();
    expect(screen.queryByText(TEXT)).toBeNull();
  });

  it("keeps the empty scroll region positioned for an overlay film", () => {
    // The film layer is `absolute inset-0`, so its containing block must be the
    // scroll region itself. Without `relative` on this wrapper the film would
    // position against the nearest ANCESTOR that happens to be positioned — and
    // the pane's `overflow-y-auto` is the thing that must not gain content height.
    render(<MessageList {...makeProps({ emptyStateAnimation: "animated" })} />);
    const scroll = screen.getByTestId("transcript-scroll");
    expect(scroll.className.split(/\s+/)).toContain("relative");
    expect(scroll.contains(screen.getByTestId("empty-film"))).toBe(true);
  });

  it("still renders the footer in the empty branch, beside the film", () => {
    // The film takes the hint's slot, NOT the branch: a stop-reason line (and by
    // the same construction a permission or `ask` card) must survive the mount, or
    // an empty session with a gate would show a film and hide the gate.
    render(
      <MessageList
        {...makeProps({ emptyStateAnimation: "animated", stopReason: "max_tokens" })}
      />,
    );
    expect(screen.getByTestId("empty-film")).toBeTruthy();
    expect(screen.getByText("Turn ended: max_tokens")).toBeTruthy();
  });
});

describe("MessageList: the film is suppressed by exactly the hint's three conditions", () => {
  // Each of the three terms of the unchanged suppression condition, asserted
  // SEPARATELY — a mount that dropped one term would otherwise be invisible to a
  // single combined case. These are the same three the 7 pre-existing
  // `queryByText(TEXT).toBeNull()` assertions cover for the hint.
  it("does not render the film while a request is pending", () => {
    render(<MessageList {...makeProps({ hasPendingRequest: true })} />);
    expect(screen.queryByTestId("empty-film")).toBeNull();
  });

  it("does not render the film while working or in a turn", () => {
    render(<MessageList {...makeProps({ workingOrInTurn: true })} />);
    expect(screen.queryByTestId("empty-film")).toBeNull();
  });

  it("does not render the film while the agent is blocked", () => {
    render(<MessageList {...makeProps({ agentState: "blocked" })} />);
    expect(screen.queryByTestId("empty-film")).toBeNull();
  });

  it("renders the film once every condition is clear", () => {
    // The positive control for the three above: the marker itself is not
    // conditional on something unrelated having drifted.
    render(
      <MessageList
        {...makeProps({
          hasPendingRequest: false,
          workingOrInTurn: false,
          agentState: "idle",
        })}
      />,
    );
    expect(screen.getByTestId("empty-film")).toBeTruthy();
  });
});

describe("MessageList: a non-empty transcript is untouched", () => {
  it("renders no film once units exist", () => {
    render(
      <MessageList
        {...makeProps({
          units: [single(textMsg("a"))],
          emptyStateAnimation: "animated",
        })}
      />,
    );
    expect(screen.queryByTestId("empty-film")).toBeNull();
    expect(screen.queryByText(TEXT)).toBeNull();
  });
});

describe("MessageList: the shipped default is still the text line", () => {
  it("renders 'Send a prompt to start' with the real film and no setting", async () => {
    // The one case the mock cannot express: with the marker installed, an empty
    // transcript renders a marker and never the hint. So the mock is removed and
    // `MessageList` is imported FRESH (the module cache still holds the mocked
    // graph), which is also the only place in this file where the real
    // `EmptyStateFilm` module is evaluated — and the assertion that follows is
    // what the prop default buys: `"off"` answers synchronously with the text
    // line, so no engine, no probe, no scene chunk.
    vi.doUnmock("./EmptyStateFilm");
    vi.resetModules();
    const { default: RealMessageList } = await import("./MessageList");
    const { default: RealEmptyStateFilm } = await import("./EmptyStateFilm");
    // Sanity: the un-mocking worked (a stale mock would make this test vacuous).
    expect(RealEmptyStateFilm).toBeTypeOf("function");

    render(
      <RealMessageList
        units={[]}
        activeSessionId="s1"
        inTurn={false}
        askRequests={[]}
        prompts={[]}
        stackedAskRequests={[]}
        childGates={[]}
        hasPendingRequest={false}
        workingOrInTurn={false}
        agentState="idle"
        turnDiffs={[]}
        stopReason={undefined}
        hasMore={false}
        loadingMore={false}
        generation={0}
        onStartReached={() => {}}
      />,
    );

    expect(screen.getByText(TEXT)).toBeTruthy();
    expect(screen.getByTestId("transcript-scroll")).toBeTruthy();
  });
});
