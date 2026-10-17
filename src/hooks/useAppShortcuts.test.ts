import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { startSession } from "../lib/tauri";
import { useSessions } from "../store/sessions";
import {
  getNewSpaceDialogOpen,
  setNewSpaceDialogOpen,
} from "../lib/newSpaceDialogState";
import { useAppShortcuts } from "./useAppShortcuts";

/**
 * The app-wide ⌘N / ⌘O chord, tested through the hook that owns it.
 *
 * EVERY dispatch here targets a REAL ELEMENT (a `textarea`, an `input` inside a
 * `role="dialog"`, a `contenteditable="false"` div), never `window`. That is the
 * whole point of this file: the guard reads `e.target`, and a dispatch on
 * `window` gives `e.target === window`, so the guard clause is never even
 * reached — the old suite dispatched that way and therefore pinned nothing
 * about the guard while appearing to.
 *
 * The host component exists for the same reason: the hook must run inside a
 * rendered component for its effect to attach. A host that takes `children` lets
 * the target element live INSIDE the React tree (RTL cleans it up, so nothing
 * leaks into the next case) rather than being hand-appended to `document.body`
 * and hand-removed. (`createElement`, not JSX: this file is `.ts`, which the
 * plan names, and the transform rejects JSX there.)
 *
 * `fireEvent.keyDown` returns `false` iff a handler called `preventDefault`, so
 * every case asserts the return value too. It is the only assertion that can
 * tell "the chord was ignored" from "the chord fired and its action happened to
 * be a no-op" — with no Space selected `startSessionInActiveSpace` opens the
 * dialog instead of starting anything, so a flag-only assertion would read as
 * "fired" in one case and "ignored" in the next for the same code path.
 */

// Mock the Tauri IPC layer (the `importActual` pattern, as in
// `../components/NewSpaceDialog.test.tsx`): the chord reaches the store's
// `startSessionInActiveSpace`, which calls the real `startSession` — an
// un-mocked `invoke` rejects in jsdom (`window.__TAURI_INTERNALS__` is
// undefined) and prints noise.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    startSession: vi.fn().mockResolvedValue({
      sessionId: "new1",
      cwd: "/tmp/alpha",
      capabilities: { loadSession: false },
      archived: false,
    }),
  };
});

const mockedStartSession = vi.mocked(startSession);

/** The hook needs a mounted component; `children` are the key targets. */
function Host({ children }: { children?: ReactNode }) {
  useAppShortcuts();
  return createElement("div", { "data-testid": "host" }, children);
}

/** Render the hook's host around one target element, inside the React tree. */
function renderHost(children: ReactNode): void {
  render(createElement(Host, null, children));
}

const TARGET = "chord-target";

beforeEach(() => {
  // One SELECTED Space: the chord's `⌘N` must reach `startSession`, not the
  // dialog fallback. Seed via `setState` (never `setSpaces` — that runs boot
  // auto-selection and issues `loadHistory` IPC).
  useSessions.setState({
    spaces: [{ path: "/tmp/alpha", createdAt: 1, lastOpenedAt: 1, trusted: false }],
    sessions: [],
    historySessions: [],
    archivedSessions: [],
    activeSessionId: null,
    activeSpacePath: "/tmp/alpha",
    closeReasons: {},
    messages: {},
    inTurn: {},
    stopReasons: {},
    newSessionError: null,
  });
  // The dialog flag is MODULE-scoped: it outlives every case. A leaked `true`
  // would make the next case's `getNewSpaceDialogOpen()` assertion pass for the
  // wrong reason.
  setNewSpaceDialogOpen(false);
  vi.clearAllMocks();
});

describe("useAppShortcuts (the ⌘N / ⌘O chord, app-wide)", () => {
  it("⌘N on a focused textarea starts a Session", async () => {
    // THE case the old suite never covered: the composer IS a textarea, nothing
    // ever blurs it, and the old guard treated "caret in a text field" as "not
    // our key" — so after ONE keystroke both chords were dead for the rest of
    // the session. A `Cmd`/`Ctrl` chord is an app command, not text editing.
    renderHost(createElement("textarea", { "data-testid": TARGET }));
    const composer = screen.getByTestId(TARGET);
    composer.focus();
    expect(document.activeElement).toBe(composer);
    // `false` = the handler called `preventDefault`, i.e. the chord WAS taken.
    expect(fireEvent.keyDown(composer, { key: "n", metaKey: true })).toBe(false);
    await vi.waitFor(() =>
      expect(mockedStartSession).toHaveBeenCalledWith("/tmp/alpha"),
    );
  });

  it("⌘O on a focused textarea opens the Open Space dialog", () => {
    renderHost(createElement("textarea", { "data-testid": TARGET }));
    const composer = screen.getByTestId(TARGET);
    composer.focus();
    expect(fireEvent.keyDown(composer, { key: "o", ctrlKey: true })).toBe(false);
    expect(getNewSpaceDialogOpen()).toBe(true);
  });

  it('⌘O on an <input> inside role="dialog" does nothing', () => {
    // The guard stands aside ONLY inside an open modal — and it must reach the
    // field by ANCESTRY: Radix moves focus INSIDE the content, so the target is
    // the `input`, not the dialog. Hence `closest`, not `target ===`.
    renderHost(
      createElement(
        "div",
        { role: "dialog", "aria-label": "New space" },
        createElement("input", { "data-testid": TARGET }),
      ),
    );
    const input = screen.getByTestId(TARGET);
    input.focus();
    expect(fireEvent.keyDown(input, { key: "o", metaKey: true })).toBe(true);
    expect(getNewSpaceDialogOpen()).toBe(false);
  });

  it('⌘O on an <input> inside role="alertdialog" does nothing', () => {
    // The half a `[role="dialog"]`-only selector SILENTLY fails: Radix's
    // AlertDialog renders `role="alertdialog"`, which does NOT match
    // `[role="dialog"]`, and the Settings remove-confirmations ARE AlertDialogs —
    // so ⌘N under a "Remove provider?" confirm would move the active Space out
    // from under the confirmation the user is answering.
    renderHost(
      createElement(
        "div",
        { role: "alertdialog", "aria-label": "Remove provider?" },
        createElement("input", { "data-testid": TARGET }),
      ),
    );
    const input = screen.getByTestId(TARGET);
    input.focus();
    expect(fireEvent.keyDown(input, { key: "o", metaKey: true })).toBe(true);
    expect(getNewSpaceDialogOpen()).toBe(false);
    expect(fireEvent.keyDown(input, { key: "n", metaKey: true })).toBe(true);
    expect(mockedStartSession).not.toHaveBeenCalled();
  });

  it('⌘O targeted at a contenteditable="false" element fires', () => {
    // MOVED from `SpacesList.test.tsx` rather than dropped: per HTML,
    // `contenteditable=""` and a bare `contenteditable` BOTH mean editable, so a
    // guard matching the attribute's PRESENCE would also match `="false"`, which
    // is not editable at all. This hook claims no text-field rule at all, so the
    // behaviour holds — and this pins that it still does.
    renderHost(
      createElement("div", {
        "data-testid": TARGET,
        contentEditable: false,
      }),
    );
    expect(
      fireEvent.keyDown(screen.getByTestId(TARGET), { key: "o", metaKey: true }),
    ).toBe(false);
    expect(getNewSpaceDialogOpen()).toBe(true);
  });

  it("⌘N ignores auto-repeat and Ctrl+Shift+N", async () => {
    renderHost(createElement("textarea", { "data-testid": TARGET }));
    const composer = screen.getByTestId(TARGET);
    // Auto-repeat fires a fresh `keydown` per repeat, and each SEQUENTIAL repeat
    // would start a Session — the store's in-flight guard absorbs only
    // CONCURRENT ones. Held-key repeat must therefore be ignored outright.
    expect(
      fireEvent.keyDown(composer, { key: "n", metaKey: true, repeat: true }),
    ).toBe(true);
    // Shift/Alt combinations belong to somebody else (a terminal, a window
    // manager, the browser) — not ours to claim.
    expect(
      fireEvent.keyDown(composer, { key: "n", ctrlKey: true, shiftKey: true }),
    ).toBe(true);
    expect(
      fireEvent.keyDown(composer, { key: "n", ctrlKey: true, altKey: true }),
    ).toBe(true);
    await vi.waitFor(() => expect(mockedStartSession).not.toHaveBeenCalled());
    expect(getNewSpaceDialogOpen()).toBe(false);
  });

  it("a bare key with no modifier does nothing", async () => {
    renderHost(createElement("textarea", { "data-testid": TARGET }));
    const composer = screen.getByTestId(TARGET);
    // Typing `n` in the composer must stay typing.
    expect(fireEvent.keyDown(composer, { key: "n" })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: "o" })).toBe(true);
    await vi.waitFor(() => expect(mockedStartSession).not.toHaveBeenCalled());
    expect(getNewSpaceDialogOpen()).toBe(false);
  });

  it("⌘O with nothing focused opens the dialog (the `document.body` target)", () => {
    // The shape `App.test.tsx` dispatches, and the real-world "nothing focused
    // yet": `document.body` matches neither a text field nor a dialog, so the
    // chord is taken.
    render(createElement(Host));
    expect(fireEvent.keyDown(document.body, { key: "o", ctrlKey: true })).toBe(
      false,
    );
    expect(getNewSpaceDialogOpen()).toBe(true);
  });
});
