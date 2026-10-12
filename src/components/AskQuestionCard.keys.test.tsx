import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
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

/**
 * React 19's two dev-mode list-key warnings. The first is the one observed in
 * the dev console during a live `ask`:
 *
 *   Each child in a list should have a unique "key" prop. … Check the render
 *   method of `AskQuestionCard`.
 *
 * It fires for a child whose key evaluates to `undefined` — NOT only for a
 * child rendered with no `key` attribute at all. The second fires when two
 * siblings share a key.
 */
const KEY_WARNING = /unique "key" prop|with the same key/;

/**
 * The payload a live `ask` actually sends — recovered from the desktop's own
 * session store (`~/.local/share/archimedes/archimedes.db`, 9 recorded asks of
 * this shape): 5 questions × 4 options, the options as **bare strings** rather
 * than `{ label }` objects, and the questions with **no `id`**. The Rust `ask`
 * flow forwards the model's tool arguments verbatim (`tc.arguments`), so
 * neither `question.id` nor `option.label` is guaranteed to exist — and a key
 * read off either one is `undefined`.
 */
const LIVE_ASK_QUESTIONS = Array.from({ length: 5 }, (_, q) => ({
  question: [
    "What kind of dog suits us?",
    "How much history do you want?",
    "Any controversial breeds?",
    "Tricks expected?",
    "Naming style?",
  ][q]!,
  options: [
    "Herding — whip-smart, needs a job (Border Collie, Australian Shepherd)",
    "Retrieving — friendly, eager, water-loving (Labrador, Golden, Chesapeake)",
    "Sighthound — quiet, sleek, surprisingly lazy (Greyhound, Whippet, Vizsla)",
    "Spitz — independent, dramatic, cat-like (Husky, Shiba, Samoyed)",
  ],
}));

/**
 * A well-formed payload (ids present, `{ label }` options) that merely repeats
 * a label inside ONE question — the shape that breaks any label-derived key,
 * including the `key={`${question.id}:${option.label}`}` "fix": a question id
 * scopes a key across questions, never *within* one.
 */
const REPEATED_LABEL_QUESTIONS = [
  {
    id: "q1",
    question: "Which of these are fruits?",
    multi: true,
    options: [{ label: "Apple" }, { label: "Apple" }, { label: "Leek" }],
  },
];

/** Add `questions` as a pending `ask` and render the card. */
function renderCard(questions: unknown[]) {
  useInteractive.getState().addRequest("s1", {
    requestId: "r1",
    method: "ask",
    source: "main",
    params: { questions },
  });
  return render(<AskQuestionCard sessionId="s1" requestId="r1" />);
}

/** Every `console.error` line React emitted so far, joined per call. */
function consoleErrors(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => call.map(String).join(" "));
}

/** The list-key warnings among them. */
function keyWarnings(spy: { mock: { calls: unknown[][] } }): string[] {
  return consoleErrors(spy).filter((e) => KEY_WARNING.test(e));
}

// React DEDUPES these warnings per call site, so the spy has to be in place
// for the card's FIRST render in the file — hence spying in `beforeEach`
// rather than inside a single test.
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useInteractive.getState().dismissSession("s1");
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("AskQuestionCard list keys", () => {
  it("gives every list a key for the payload shape a live ask sends", () => {
    const { container } = renderCard(LIVE_ASK_QUESTIONS);
    // The whole 5x4 grid really rendered — 5 questions × (4 options + the
    // `Other` row) + Cancel + Submit — and the multi-question Review list has
    // one row per question, so the assertion below cannot pass vacuously.
    expect(container.querySelectorAll("button")).toHaveLength(5 * 5 + 2);
    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(keyWarnings(consoleError)).toEqual([]);
  });

  it("keys options so a repeated label within one question cannot collide", () => {
    const { getAllByRole, getByRole } = renderCard(REPEATED_LABEL_QUESTIONS);
    // Both `Apple` options rendered (a key collision is a React identity
    // problem, not a missing row).
    expect(getAllByRole("button", { name: /^Apple/ })).toHaveLength(2);
    expect(getByRole("button", { name: /^Leek/ })).toBeTruthy();
    expect(keyWarnings(consoleError)).toEqual([]);
  });

  it("stays warning-free across the re-render a selection causes", () => {
    const { container, getAllByRole } = renderCard(REPEATED_LABEL_QUESTIONS);
    // Select → the keyed option list re-renders AND a note input mounts inside
    // the keyed row (a keyed sibling being inserted — where bad keys surface).
    fireEvent.click(getAllByRole("button", { name: /^Apple/ })[0]!);
    fireEvent.click(getAllByRole("button", { name: /^Leek/ })[0]!);
    expect(container.querySelectorAll("input")).toHaveLength(2);
    expect(keyWarnings(consoleError)).toEqual([]);
  });
});
