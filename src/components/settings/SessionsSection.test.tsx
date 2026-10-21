import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { deleteSession, type SessionInfo } from "@/lib/tauri";
import { useSessions, type Message } from "@/store/sessions";
import SessionsSection from "./SessionsSection";

/**
 * The ONLY module mock is the IPC wrapper the store's `deleteSession` action
 * calls (the pattern `WebSearchSection.test.tsx` uses: `importActual` + one
 * `vi.fn()`). Everything else — `detachedSessions`, `titleFor`, both dialogs —
 * is the real thing, so a green run here is the section wired to the real
 * derivation, not to a stand-in for it.
 */
vi.mock("@/lib/tauri", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    deleteSession: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedDeleteSession = vi.mocked(deleteSession);

const NOW = 1_700_000_000_000;

/** One stored row (`SessionInfo`'s wire shape — there is no `createdAt` field). */
function row(
  sessionId: string,
  cwd: string,
  archived = false,
): SessionInfo {
  return { sessionId, cwd, capabilities: {}, archived };
}

/**
 * Seed the sessions store.
 *
 * `/tmp/alpha` is the ONE open Space, and it carries a stored row of its own —
 * the negative pin ("an open Space's rows are absent") needs a row that IS
 * stored and IS matched by a Space path, or the assertion would pass for an
 * empty input. `/tmp/beta` (stored) and `/tmp/gamma` (archived) are the two
 * **Detached** rows this section must list, so the counts below are exactly 2
 * sessions in exactly 2 folders.
 *
 * `addSpace` and `openSession` are OVERRIDDEN here and read back out of the
 * store by the tests that assert on them: they are zustand actions reached by
 * selector, so `vi.spyOn(useSessions, …)` cannot see them. Overriding
 * `openSession` additionally keeps the Reopen pin from firing a real
 * `loadHistory` IPC into jsdom.
 */
function seed(
  overrides: Partial<ReturnType<typeof useSessions.getState>> = {},
) {
  useSessions.setState({
    spaces: [
      { path: "/tmp/alpha", createdAt: NOW, lastOpenedAt: NOW, trusted: false },
    ],
    sessions: [],
    historySessions: [row("h-beta", "/tmp/beta"), row("h-alpha", "/tmp/alpha")],
    archivedSessions: [row("a-gamma", "/tmp/gamma", true)],
    activeSessionId: null,
    activeSpacePath: "/tmp/alpha",
    messages: {},
    addSpace: vi.fn(),
    openSession: vi.fn(),
    ...overrides,
  });
}

/** The two fns this section calls on Reopen, read back out of the store AFTER
 * the seed (a capture taken before it holds the REAL actions). */
function reopenFns(): {
  addSpace: ReturnType<typeof vi.fn>;
  openSession: ReturnType<typeof vi.fn>;
} {
  const state = useSessions.getState();
  return {
    addSpace: state.addSpace as ReturnType<typeof vi.fn>,
    openSession: state.openSession as ReturnType<typeof vi.fn>,
  };
}

/** The nearest row root for a row's path text (the `border-t` row wrapper). */
function rowRootFor(path: string): HTMLElement {
  const cell = screen.getByText(path).closest('[class*="border-t"]');
  if (!cell) throw new Error(`no row wrapper found for ${path}`);
  return cell as HTMLElement;
}

beforeEach(() => {
  seed();
  vi.clearAllMocks();
  // `clearAllMocks` drops call records but NOT the factory's resolved value;
  // restate the default so an unconsumed `…Once` rejection from an earlier test
  // cannot decide what this test's delete answers.
  mockedDeleteSession.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  // RESTORE THE CLOCK HERE, not at the end of a test body: an assertion that
  // throws would otherwise skip the restore and leak fake time into every
  // remaining test in the file (the relative-time test pins `Date.now()`).
  vi.useRealTimers();
});

describe("SessionsSection (Settings → Detached sessions)", () => {
  it("lists every detached row with its full path, and none of an open Space's", () => {
    render(<SessionsSection onBack={vi.fn()} />);
    // Both Detached rows — the stored one AND the archived one (an unarchived
    // session of a closed Space is just as invisible, so both belong here).
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.getByText("gamma")).toBeTruthy();
    // The full `cwd`, not the folder name: this list is cross-Space and the
    // path is the one thing that says which folder a row came from.
    expect(screen.getByText("/tmp/beta")).toBeTruthy();
    expect(screen.getByText("/tmp/gamma")).toBeTruthy();
    // The integration pin: `detachedSessions` excludes `/tmp/alpha`'s rows.
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.queryByText("/tmp/alpha")).toBeNull();
  });

  it("passes the store's LIVE slice as `detachedSessions`' 4th argument, so a live row of a closed Space stays out", () => {
    // THE 4th-ARGUMENT WIRING PIN (ADR 0043's Close-anyway path). `seed()`
    // passes an empty live list by default, so this section would stay green
    // even if the call site dropped the live ids and handed `[]` as
    // `detachedSessions`' 4th argument. The mutation is only visible when a row
    // is BOTH stored AND live — the shape Close-anyway leaves behind (an
    // archived Session that is resumed stays in `archivedSessions` while it is
    // live), and where the Space tab is closed. ONLY the live-id subtraction
    // keeps `/tmp/gamma` out of this list; the space-path filter cannot, because
    // no Space row carries that path.
    seed({
      archivedSessions: [row("live-gamma", "/tmp/gamma", true)],
      sessions: [row("live-gamma", "/tmp/gamma")],
    });
    render(<SessionsSection onBack={vi.fn()} />);
    // The live row is absent by title AND by path text.
    expect(screen.queryByText("gamma")).toBeNull();
    expect(screen.queryByText("/tmp/gamma")).toBeNull();
    // The still-detached stored rows are unaffected — one folder, one session.
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.getByText("/tmp/beta")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Clear all" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const dialog = screen.getByRole("dialog");
    // The live row is neither listed nor counted in the blast radius.
    expect(
      within(dialog).getByText("Delete 1 detached session from 1 folder?"),
    ).toBeTruthy();
    expect(within(dialog).queryByText("/tmp/gamma")).toBeNull();
  });

  it("offers Reopen Space and Delete per row", () => {
    render(<SessionsSection onBack={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Reopen space for beta" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete beta" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Reopen space for gamma" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete gamma" })).toBeTruthy();
  });

  it("badges only the archived row", () => {
    render(<SessionsSection onBack={vi.fn()} />);
    expect(
      within(rowRootFor("/tmp/gamma")).getByText("archived"),
    ).toBeTruthy();
    expect(
      within(rowRootFor("/tmp/beta")).queryByText("archived"),
    ).toBeNull();
  });

  it("renders the relative time only for a row whose transcript is loaded", () => {
    const messages: Record<string, Message[]> = {
      // An `agent-text` last message: `titleFor` reads the first USER message,
      // so the title stays the folder name and this test pins only the time.
      "h-beta": [
        { kind: "agent-text", messageId: "m1", text: "done", at: NOW - 5 * 60_000 },
      ],
    };
    vi.setSystemTime(NOW);
    seed({ messages });
    render(<SessionsSection onBack={vi.fn()} />);
    expect(within(rowRootFor("/tmp/beta")).getByText("5m")).toBeTruthy();
    // No loaded transcript → no time text (the row keeps an empty slot so the
    // buttons stay aligned — `SessionInfo` carries no `createdAt`).
    expect(
      within(rowRootFor("/tmp/gamma")).queryByText(/^(now|\d+m|\d+h)$/),
    ).toBeNull();
    // The clock is restored by the file's `afterEach`, so a throw above cannot
    // leak fake time into the tests that follow.
  });

  it("shows the empty state and disables Clear all when nothing is detached", () => {
    seed({ historySessions: [row("h-alpha", "/tmp/alpha")], archivedSessions: [] });
    render(<SessionsSection onBack={vi.fn()} />);
    expect(
      screen.getByText(
        "No detached sessions. Every stored session belongs to an open Space.",
      ),
    ).toBeTruthy();
    // No jest-dom in this project, so the disabled state is read off the DOM
    // property (the `ModelPicker.test.tsx` precedent).
    expect(
      (screen.getByRole("button", { name: "Clear all" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("enables Clear all when rows are listed", () => {
    render(<SessionsSection onBack={vi.fn()} />);
    expect(
      (screen.getByRole("button", { name: "Clear all" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("counts two folders that share a base name as TWO folders, and lists both paths", () => {
    // The confirm's whole job is to name the blast radius. `/home/alice/proj`
    // and `/mnt/backup/proj` are DIFFERENT folders that share a base name, so
    // deduping by base name would read "…from 1 folders?" and list `proj` once
    // — an understated count on the app's widest destructive action.
    seed({
      historySessions: [
        row("h-alpha", "/tmp/alpha"),
        row("h-alice-proj", "/home/alice/proj"),
        row("h-backup-proj", "/mnt/backup/proj"),
      ],
      archivedSessions: [],
    });
    render(<SessionsSection onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText("Delete 2 detached sessions from 2 folders?"),
    ).toBeTruthy();
    // Both FULL paths are listed (sorted), not one collapsed base name.
    expect(
      within(dialog)
        .getAllByText(/\//)
        .filter((node) => node.textContent?.endsWith("proj"))
        .map((node) => node.textContent),
    ).toEqual(["/home/alice/proj", "/mnt/backup/proj"]);
    expect(within(dialog).queryByText("proj")).toBeNull();
  });

  it("Clear all confirms with both counts, then deletes every listed row and closes", async () => {
    render(<SessionsSection onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const dialog = screen.getByRole("dialog");
    // ADR 0016's amendment: the confirm names the blast radius — sessions AND
    // folders, from the DISTINCT folder names of the detached rows.
    expect(
      within(dialog).getByText("Delete 2 detached sessions from 2 folders?"),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete 2 sessions" }));
    await waitFor(() => {
      expect(mockedDeleteSession).toHaveBeenCalledWith("h-beta");
      expect(mockedDeleteSession).toHaveBeenCalledWith("a-gamma");
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Clear all closes the dialog and logs each failure when a delete rejects", async () => {
    mockedDeleteSession.mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      render(<SessionsSection onBack={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
      const dialog = screen.getByRole("dialog");
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Delete 2 sessions" }),
      );
      // Best-effort: the failure is logged and the dialog still closes (a
      // dialog stuck open after a swallowed failure is worse; the surviving
      // row stays listed for a retry).
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(consoleError).toHaveBeenCalled();
      expect(
        useSessions.getState().historySessions.some((s) => s.sessionId === "h-beta"),
      ).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a row's Delete opens the confirm and only the dialog's Delete deletes", async () => {
    render(<SessionsSection onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete gamma" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Delete session?")).toBeTruthy();
    // Opening the confirm deletes nothing.
    expect(mockedDeleteSession).not.toHaveBeenCalled();
    // The dialog repeats the row's own title.
    expect(within(dialog).getByText("gamma")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mockedDeleteSession).toHaveBeenCalledWith("a-gamma"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Only the archived row is gone — the other Detached row is untouched.
    expect(screen.queryByText("gamma")).toBeNull();
    expect(screen.getByText("beta")).toBeTruthy();
  });

  it("a row's Reopen Space re-adds the folder, opens the session and leaves Settings", () => {
    const onBack = vi.fn();
    seed();
    const { addSpace, openSession } = reopenFns();
    render(<SessionsSection onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: "Reopen space for beta" }));
    expect(addSpace).toHaveBeenCalledWith("/tmp/beta");
    expect(openSession).toHaveBeenCalledWith("h-beta");
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
