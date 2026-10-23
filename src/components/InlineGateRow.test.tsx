import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { InlineGateRow } from "./InlineGateRow";
import { SubagentModals } from "./SubagentModals";
import TranscriptFooter from "./chat/TranscriptFooter";
import { respondInteractiveRequest, respondPermission } from "../lib/tauri";
import { useSubagents } from "../store/subagents";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSessions } from "../store/sessions";
import { useSubagentSelection } from "../store/subagentSelection";
import { makeSubagentEntry } from "../test/fixtures";
import { resetStores } from "../test/resetStores";
import type { ChildGate } from "../hooks/useChildGates";

/**
 * `InlineGateRow` — the CHILD-GATE CARD, extracted from its two copies (finding 5).
 *
 * The card is the half that `TranscriptFooter` (the inline row inside the
 * parent's transcript) and `SubagentModals` (the corner overlay) each used to
 * spell out separately: the `↳ {agentName}` attribution chip, then the `ask`
 * card or the `PermissionPrompt`. These tests pin the card AS THE SHARED
 * COMPONENT, so both call sites inherit them; the per-site wrappers (the
 * transcript's `data-testid="gate-row"` row, the overlay's
 * `pointer-events-auto` div) belong to their own sites and are pinned there.
 *
 * WHAT THIS FILE DELIBERATELY PINS, beyond "the card renders":
 *  1. the card adds NO element of its own — a React boundary is not a DOM node,
 *     so the chip and the card land as DIRECT children of whatever wraps them.
 *     A wrapper element here would change the tree at both sites (and break the
 *     overlay's `panel.children` card count and the transcript's row rhythm).
 *  2. `autoFocus` is OFF, always — a lifted child gate must never take the
 *     caret out from under the composer (`AskQuestionCard`'s own doc), and that
 *     is a property of being a lifted gate, i.e. of THIS component.
 *  3. the card does NOT stop `Escape`. Each site stops it at its own level
 *     (per-row for the transcript, per-region for the overlay) and neither stop
 *     may be duplicated here — see the doc-comment on the component.
 *  4. the card never re-decides which kinds it renders: it is handed an
 *     already-filtered gate (`isInlineChildGate` upstream), because a local kind
 *     list is how a fifth `ChildGateKind` ends up rendered in BOTH sites.
 */

// The IPC layer only — the stores and both card components are the real code,
// so these tests exercise the DOM the user actually gets.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    respondInteractiveRequest: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn().mockResolvedValue(undefined),
  };
});

/** The child the gates below belong to. */
const CHILD = "sub1";
const PARENT = "main1";

function seedChild() {
  useSubagents.getState().addSession(
    makeSubagentEntry({
      sessionId: CHILD,
      parentSessionId: PARENT,
      agentName: "reviewer",
      task: "review the diff",
    }),
  );
}

/** One pending `ask`, in the store the REAL `AskQuestionCard` reads. */
function seedAsk(requestId = "r1") {
  useInteractive.getState().addRequest(CHILD, {
    requestId,
    method: "ask",
    source: "subagent:reviewer",
    params: {
      questions: [
        {
          id: "q1",
          question: "Which color?",
          options: [{ label: "Red" }, { label: "Blue" }],
        },
      ],
    },
  });
}

function seedPermission(requestId = "p1") {
  act(() => {
    usePermissions.getState().addPrompt(CHILD, requestId, {
      toolCall: { title: "Bash (apt install ripgrep)" },
      options: [{ optionId: "allow", name: "Allow" }],
    });
  });
}

/** One gate of each kind, shaped like `childGatesOf`'s output. */
const gate = (kind: ChildGate["kind"], requestId: string): ChildGate => ({
  childSessionId: CHILD,
  parentSessionId: PARENT,
  agentName: "reviewer",
  requestId,
  kind,
  childStartedAt: 1,
});

beforeEach(() => {
  resetStores();
  useSessions.setState({ activeSessionId: "other", messages: {} });
  useSubagentSelection.getState().select(null);
});

describe("InlineGateRow (the child-gate card, once)", () => {
  it("renders the attribution chip naming the CHILD, with the chip's own classes", () => {
    seedChild();
    seedAsk();
    const { container } = render(<InlineGateRow gate={gate("ask", "r1")} />);
    // The exact chip text both call sites' tests pin (`↳ reviewer`).
    expect(screen.getByText("↳ reviewer")).toBeTruthy();
    const chip = container.querySelector("p")!;
    expect(chip.className.split(/\s+/)).toEqual([
      "mb-1",
      "text-ui-xs",
      "text-foreground-subtle",
    ]);
  });

  it("renders an `ask` gate as the real answerable card, routed to the CHILD's session id", async () => {
    seedChild();
    seedAsk();
    render(<InlineGateRow gate={gate("ask", "r1")} />);
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
    // The answer routes to the CHILD, not to whatever session is active —
    // `gate.childSessionId` is the key every respond command takes.
    const card = screen.getByText("Which color?").closest("[tabindex='-1']")!;
    fireEvent.keyDown(card, { key: "Escape" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(respondInteractiveRequest)).toHaveBeenCalledWith(
      CHILD,
      "r1",
      { cancelled: true, results: [] },
    );
  });

  it("renders a `permission` gate as the PermissionPrompt, routed to the CHILD's session id", async () => {
    seedChild();
    seedPermission();
    render(<InlineGateRow gate={gate("permission", "p1")} />);
    expect(screen.getByText("Bash (apt install ripgrep)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(respondPermission)).toHaveBeenCalledWith(
      CHILD,
      "p1",
      expect.anything(),
    );
  });

  it("never takes focus on mount (`autoFocus` is off for a lifted gate)", () => {
    seedChild();
    seedAsk();
    render(<InlineGateRow gate={gate("ask", "r1")} />);
    // `AskQuestionCard` focuses its own root when unanchored AND `autoFocus`; a
    // child's `ask` can arrive while the user is mid-sentence in the composer,
    // so the lifted card must not steal the caret. `document.body` still holds
    // focus (the composer's caret is untouched).
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it("adds NO element of its own — the chip and the card are direct children of the caller's wrapper", () => {
    seedChild();
    seedAsk();
    const { container } = render(
      <div data-testid="site-wrapper">
        <InlineGateRow gate={gate("ask", "r1")} />
      </div>,
    );
    const wrapper = screen.getByTestId("site-wrapper");
    // A React component boundary emits no DOM: exactly two children, the chip
    // then the card. A wrapper `<div>` here would be a third DOM level and would
    // change the tree at BOTH sites (the overlay counts its cards as
    // `panel.children`, and the transcript's row rhythm is positional).
    expect([...wrapper.children].map((el) => el.tagName)).toEqual(["P", "DIV"]);
    expect(wrapper.firstElementChild!.textContent).toBe("↳ reviewer");
    expect(wrapper.children[1]!.textContent).toContain("Which color?");
    // And nothing is orphaned outside the wrapper.
    expect(container.children).toHaveLength(1);
  });

  it("does NOT stop `Escape` — the CALLER's handler still sees it (one stop per site, not two)", () => {
    seedChild();
    seedAsk();
    const siteHandler = vi.fn();
    render(
      <div onKeyDown={siteHandler}>
        <InlineGateRow gate={gate("ask", "r1")} />
      </div>,
    );
    // An Esc on the CHIP (outside the card's own root): the transcript's
    // `gate-row` wrapper and the overlay's `role="region"` are what stop this
    // today, each at its own level. The card must not stop it too, or the two
    // sites' documented Escape contracts become two independent implementations
    // that can drift — and the region-level stop, which also covers the region's
    // padding and the gaps between cards, could not be reproduced in a card.
    fireEvent.keyDown(screen.getByText("↳ reviewer"), { key: "Escape" });
    expect(siteHandler).toHaveBeenCalledTimes(1);
  });

  it("does not re-decide kinds: a gate handed to it renders whatever its kind is", () => {
    // The card is fed an ALREADY-FILTERED gate (`isInlineChildGate` upstream at
    // both sites). This is the shape of that contract: the component has no kind
    // list of its own to fall out of step with the predicate — the only branch
    // is WHICH card a gate draws (`ask` vs the permission card), never WHETHER
    // this site draws it. A `confirm` gate handed in (which neither site does
    // today) therefore draws the permission card rather than being silently
    // dropped: dropping it here would be a gate rendered NOWHERE, the exact
    // ADR 0040 violation the partition exists to prevent.
    seedChild();
    seedPermission();
    render(<InlineGateRow gate={gate("confirm", "p1")} />);
    expect(screen.getByText("Bash (apt install ripgrep)")).toBeTruthy();
  });

  it("carries no `pt-*` utility (the transcript's no-gap-above rule)", () => {
    // `MessageList.gap.test.tsx` filters `/^pt-/` on the gate row and asserts it
    // is empty: gate rows ride the container's base gap and never breathe. The
    // card is the row's whole content, so a `pt-*` here would land inside that
    // assertion's reach.
    seedChild();
    seedAsk();
    const { container } = render(<InlineGateRow gate={gate("ask", "r1")} />);
    const padded = [...container.querySelectorAll<HTMLElement>("*")]
      .flatMap((el) => el.className.toString().split(/\s+/))
      .filter((token) => /^pt-/.test(token));
    expect(padded).toEqual([]);
  });
});

/**
 * THE TWO ESCAPE STOPS, pinned at both sites, from ONE file.
 *
 * Every case below passes byte-identically against the pre-extraction copies
 * (verified by stashing both call sites and re-running), which is the point:
 * these are CHARACTERISATION pins for behaviour the extraction must not move.
 * They live here because the extraction is what made them cross-component — the
 * chip is now rendered by `InlineGateRow` while the stop that covers it lives in
 * the CALLER's wrapper — so a later "tidy up" that pushes a stop into the card
 * would leave the transcript green and silently narrow the overlay's coverage
 * (a card-level stop can never cover the region's padding, the gaps between its
 * cards, or the chip's sibling position). The five guard files these touch
 * (`SubagentModals.test.tsx`, `SubagentModals.renderSite.test.tsx`,
 * `TranscriptFooter.test.tsx`, `MessageList.gap.test.tsx`,
 * `subagentSheetLayout.test.ts`) stay byte-identical, so the pins are ADDITIVE —
 * `TranscriptFooter.test.tsx` had no Escape assertion at all before this, and
 * this file is where the row-level stop now gets one.
 */
describe("the card's two sites keep their own Escape stop (per-row vs per-region)", () => {
  /** An Esc on the CHIP — the node the card renders but neither site's stop is
   *  attached to, so it is the case a card-level stop would appear to fix. */
  const expectChipEscStopped = () => {
    const windowEsc = vi.fn();
    window.addEventListener("keydown", windowEsc);
    fireEvent.keyDown(screen.getByText("↳ reviewer"), { key: "Escape" });
    window.removeEventListener("keydown", windowEsc);
    expect(windowEsc).not.toHaveBeenCalled();
    // Stopping answers nothing: the gate stays pending.
    expect(screen.getByText("Which color?")).toBeTruthy();
  };

  const renderFooter = () =>
    render(
      <TranscriptFooter
        activeSessionId={PARENT}
        prompts={[]}
        stackedAskRequests={[]}
        childGates={[gate("ask", "r1")]}
        turnDiffs={[]}
        stopReason={undefined}
        inTurn={false}
      />,
    );

  it("the TRANSCRIPT stops an Esc on the chip at the ROW (per gate)", () => {
    seedChild();
    seedAsk();
    renderFooter();
    expect(screen.getByTestId("gate-row")).toBeTruthy();
    expectChipEscStopped();
    expect(useInteractive.getState().requests[CHILD]).toHaveLength(1);
  });

  it("the TRANSCRIPT stops an Esc on a permission button at the ROW (`PermissionPrompt` has no handler of its own)", () => {
    seedChild();
    seedPermission();
    render(
      <TranscriptFooter
        activeSessionId={PARENT}
        prompts={[]}
        stackedAskRequests={[]}
        childGates={[gate("permission", "p1")]}
        turnDiffs={[]}
        stopReason={undefined}
        inTurn={false}
      />,
    );
    const windowEsc = vi.fn();
    window.addEventListener("keydown", windowEsc);
    fireEvent.keyDown(screen.getByRole("button", { name: "Allow" }), {
      key: "Escape",
    });
    window.removeEventListener("keydown", windowEsc);
    expect(windowEsc).not.toHaveBeenCalled();
    expect(screen.getByText("Bash (apt install ripgrep)")).toBeTruthy();
  });

  it("the OVERLAY stops an Esc on the chip at the REGION", () => {
    seedChild();
    seedAsk();
    render(<SubagentModals />);
    expectChipEscStopped();
  });

  it("the OVERLAY also stops an Esc on the region's own padding — the coverage a card-level stop could never provide", () => {
    seedChild();
    seedAsk();
    render(<SubagentModals />);
    const windowEsc = vi.fn();
    window.addEventListener("keydown", windowEsc);
    fireEvent.keyDown(screen.getByTestId("subagent-gate-overlay"), {
      key: "Escape",
    });
    window.removeEventListener("keydown", windowEsc);
    expect(windowEsc).not.toHaveBeenCalled();
    // This is why the overlay's stop stays on the region: the frame is a scroll
    // container and `pointer-events-none` does not stop KEY events, so its
    // padding and the gaps between cards are reachable by an Esc.
  });

  it("the OVERLAY's sudo `Dialog`s are unaffected — they are the region's SIBLINGS, so its stop never reaches them", () => {
    seedChild();
    useInteractive.getState().addRequest(CHILD, {
      requestId: "r2",
      method: "password",
      source: "main",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<SubagentModals />);
    const windowEsc = vi.fn();
    window.addEventListener("keydown", windowEsc);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    window.removeEventListener("keydown", windowEsc);
    expect(windowEsc).toHaveBeenCalled();
  });
});
