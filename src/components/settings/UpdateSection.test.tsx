import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import UpdateSection, { resetUpdaterSectionState } from "./UpdateSection";
import { getAppInfo } from "@/lib/version";
import {
  checkUpdate,
  installUpdate,
  listenUpdateProgress,
  relaunchApp,
  type UpdateProgress,
} from "@/lib/update";

// The seam is mocked WHOLESALE (the `@/lib/version` mock in
// `SettingsPage.test.tsx:67` is the pattern): what these cases pin is the
// STATE MACHINE and its copy, not the wire names — those are pinned where they
// live, in `src/lib/update.test.ts`.
vi.mock("@/lib/update", () => ({
  checkUpdate: vi.fn(),
  installUpdate: vi.fn(),
  relaunchApp: vi.fn(),
  listenUpdateProgress: vi.fn(),
}));

vi.mock("@/lib/version", () => ({
  // The version row's ONLY source (no second version read in the UI).
  getAppInfo: vi.fn().mockResolvedValue({ version: "0.1.0", platform: "linux" }),
}));

const mockedCheck = vi.mocked(checkUpdate);
const mockedInstall = vi.mocked(installUpdate);
const mockedRelaunch = vi.mocked(relaunchApp);
const mockedListen = vi.mocked(listenUpdateProgress);

const AVAILABLE = {
  state: "available",
  version: "0.2.0",
  notes: "One fixed thing.",
  date: "2026-10-14T09:00:00Z",
} as const;

/** Drive the section to the `available` state (the install flow's entry). */
async function openAvailable(): Promise<void> {
  mockedCheck.mockResolvedValue(AVAILABLE);
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await screen.findByText(/0\.2\.0 is available/i);
}

beforeEach(() => {
  // The section's phase now lives in a MODULE-LEVEL store (it has to — the
  // install outlives the component), so it survives `cleanup()`. This is the
  // one line that makes each case start from `idle` again, the way a fresh
  // process starts from `idle`; without it the case that leaves a
  // never-settling install in flight would leak `installing` into every case
  // below it. It replaces nothing about the assertions themselves.
  resetUpdaterSectionState();
  mockedCheck.mockReset();
  mockedInstall.mockReset();
  mockedRelaunch.mockReset();
  mockedListen.mockReset();
  // The progress subscription resolves to a no-op unlisten by default (the
  // install flow awaits it before awaiting the install).
  mockedListen.mockResolvedValue(vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("UpdateSection (the manual updater, ADR 0053)", () => {
  it("shows the running version without asking the update server anything (case 8: nothing checks on mount)", async () => {
    render(<UpdateSection />);
    // The version row renders from `getAppInfo` — the page's one version source.
    expect(await screen.findByText("0.1.0")).toBeTruthy();
    // THE PIN: no check, no install, no relaunch, and not even a progress
    // subscription. Nothing in this app checks for updates by itself (ADR 0053
    // — an aggressive shipped cadence cannot be retracted after release), so a
    // future `useEffect(… checkUpdate …)` has to fail here first.
    expect(mockedCheck).not.toHaveBeenCalled();
    expect(mockedInstall).not.toHaveBeenCalled();
    expect(mockedRelaunch).not.toHaveBeenCalled();
    expect(mockedListen).not.toHaveBeenCalled();
  });

  it("a check that finds nothing says so (case 1: up to date)", async () => {
    mockedCheck.mockResolvedValue({ state: "upToDate" });
    render(<UpdateSection />);
    await screen.findByText("0.1.0");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText(/up to date/i)).toBeTruthy();
  });

  it("a FAILED check says the server was unreachable and never reads as up to date (case 2: the conflation pin)", async () => {
    // The whole reason `CheckOutcome` is three-way. GitHub 404s
    // `…/releases/latest/download/latest.json` for a repo with no published
    // release, the plugin swallows the non-2xx into `ReleaseNotFound`, and the
    // Rust command maps that to `"release-not-found"` — an `Err`, not an answer.
    // Render it as "up to date" and every installed client with a broken
    // endpoint believes it is current forever.
    mockedCheck.mockRejectedValue("release-not-found");
    render(<UpdateSection />);
    await screen.findByText("0.1.0");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    const failed = await screen.findByText(/could not reach the update server/i);
    // The raw typed code is next to the sentence (the `kebab-case:detail`
    // string is the diagnostic; the prose is the human half).
    expect(failed.textContent ?? "").toContain("release-not-found");
    // AND NOT the sentence a working endpoint produced — asserted on the whole
    // section, so a re-worded failure line cannot smuggle it back in.
    expect(screen.queryByText(/up to date/i)).toBeNull();
  });

  it("an available update shows its version (case 3)", async () => {
    await (async () => {
      render(<UpdateSection />);
      await screen.findByText("0.1.0");
    })();
    mockedCheck.mockResolvedValue(AVAILABLE);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText(/0\.2\.0 is available/i)).toBeTruthy();
    // The install path is offered against THAT version (the running one is
    // still the row's 0.1.0 — the two numbers must not be confused).
    expect(screen.getByRole("button", { name: "Install update" })).toBeTruthy();
    expect(screen.getByText("0.1.0")).toBeTruthy();
  });

  it("installing announces the closing window BEFORE the await, and a rejected install lands back on available (case 4: the Windows shape)", async () => {
    render(<UpdateSection />);
    await screen.findByText("0.1.0");
    await openAvailable();
    // ⚠ The Windows install NEVER resolves: `install_inner` calls
    // `std::process::exit(0)` after `ShellExecuteW` succeeds. So the promise
    // below never settles — anything this component rendered AFTER the await
    // would never paint, and a user would see a spinner until the window
    // vanished. The never-resolving mock IS the Windows success path.
    mockedInstall.mockReturnValue(new Promise<void>(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    expect(await screen.findByText(/window will close/i)).toBeTruthy();
    expect(mockedInstall).toHaveBeenCalledTimes(1);
    // The announced state survives: the section never reverts to "available"
    // while the (never-settling) install is in flight.
    expect(screen.queryByRole("button", { name: "Install update" })).toBeNull();

    // The other half of the same edge: macOS/Linux DO settle, and a deb/pkexec
    // install can fail after a full download. That lands back on `available`
    // with the error — not on the failed-check sentence (the server was
    // reachable; the install is what broke) and not on a dead end.
    cleanup();
    // A fresh "process" for the second half (the phase lives in a module store
    // now, and the half above left an install in flight forever on purpose).
    resetUpdaterSectionState();
    render(<UpdateSection />);
    await screen.findByText("0.1.0");
    await openAvailable();
    mockedInstall.mockRejectedValue("install-failed");
    fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    expect(await screen.findByText(/0\.2\.0 is available/i)).toBeTruthy();
    expect(screen.getByText(/install-failed/)).toBeTruthy();
    // Retry is possible (the install button is back).
    expect(screen.getByRole("button", { name: "Install update" })).toBeTruthy();
  });

  it("a resolved install ends on an explicit Restart to finish, deferred one beat (case 5: mac/linux)", async () => {
    // A resolve means the platform did NOT exit (macOS/Linux): the app is still
    // running on the OLD binary, so completion is an explicit button — never a
    // silent relaunch, and never automatic anywhere.
    vi.mocked(getAppInfo).mockResolvedValue({
      version: "0.1.0",
      platform: "linux",
    });
    render(<UpdateSection />);
    await screen.findByText("0.1.0");
    await openAvailable();
    mockedInstall.mockResolvedValue(undefined);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    // Flush the resolved install (microtasks only — no timer to advance).
    await act(async () => {});
    const restart = screen.getByRole("button", { name: "Restart to finish" });
    // No auto-relaunch: the install resolving does not restart the app by
    // itself.
    expect(mockedRelaunch).not.toHaveBeenCalled();
    fireEvent.click(restart);
    // The paint beat: `relaunch_app` never returns (`AppHandle::restart()` is
    // `-> !`), so the click defers it — the "restarting" paint has to land
    // before the process goes.
    expect(mockedRelaunch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(mockedRelaunch).toHaveBeenCalledTimes(1);
  });

  it("progress with no Content-Length renders an indeterminate bar and no percentage (case 6: never NaN%)", async () => {
    render(<UpdateSection />);
    await screen.findByText("0.1.0");
    await openAvailable();
    let emit: ((payload: UpdateProgress) => void) | undefined;
    mockedListen.mockImplementation((_cb) => {
      emit = _cb;
      return Promise.resolve(vi.fn());
    });
    mockedInstall.mockReturnValue(new Promise<void>(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    await waitForListen();
    // A chunked/gzipped response reports no `Content-Length`, and the Rust
    // payload carries that as `total: null` — there is no denominator, so a
    // percentage would be `NaN%`.
    act(() => {
      emit?.({ downloaded: 4096, total: null });
    });
    const text = sectionText();
    // 4096 B renders as `4 KB` (the point is not the unit): a byte readout with
    // no percentage sign anywhere and no `NaN`.
    expect(text).toMatch(/4\s?KB downloaded/);
    expect(text).not.toContain("%");
    expect(text).not.toContain("NaN");

    // CONTRAST (so the case above cannot pass by rendering nothing at all): a
    // known `total` does render the percentage.
    act(() => {
      emit?.({ downloaded: 4096, total: 8192 });
    });
    expect(sectionText()).toContain("50%");
    expect(sectionText()).not.toContain("NaN");
  });

  it("a second click while a check is in flight starts no second check (case 7: one invoke)", async () => {
    // The guard is a ref, not the state: a click handler reads the state of the
    // render it was created in, so two synchronous clicks would both see
    // `idle` without it.
    mockedCheck.mockReturnValue(new Promise(() => {}));
    render(<UpdateSection />);
    await screen.findByText("0.1.0");
    const button = screen.getByRole("button", { name: "Check for updates" });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {});
    expect(mockedCheck).toHaveBeenCalledTimes(1);
  });

  it("an install that RESOLVES survives an unmount: a remount still says restart to finish (case 9)", async () => {
    // The unmount the old `useState` could not survive. The Settings page renders
    // ONE section at a time, so navigating away really does unmount this
    // component while the Rust install keeps running; the phase therefore lives
    // in a module-level store. The old shape painted "Restart to finish" from
    // component state that evaporated on unmount — the returning user saw an
    // IDLE section and no hint that the update had in fact landed.
    render(<UpdateSection />);
    await screen.findByText("0.1.0");
    await openAvailable();
    mockedInstall.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    await screen.findByRole("button", { name: "Restart to finish" });

    // Navigation: the component is gone (nothing of it is on screen)…
    cleanup();
    expect(screen.queryByText(/restart to finish/i)).toBeNull();
    // …but the install it started is NOT, and the phase is process state now.
    expect(mockedInstall).toHaveBeenCalledTimes(1);

    // Coming back re-renders from the store: the mac/linux "installed, relaunch
    // me" truth is still on screen, and the version is the AVAILABLE one. (One
    // query for the sentence — `getByText(/restart to finish/i)` alone would
    // match both this line and the button, which is its own kind of pin that the
    // copy is present in both places.)
    render(<UpdateSection />);
    const installed = await screen.findByText(/0\.2\.0 is installed/i);
    expect(installed.textContent ?? "").toMatch(/restart to finish/i);
    expect(screen.getByRole("button", { name: "Restart to finish" })).toBeTruthy();
    // Still no auto-relaunch across the remount, and no second install: the
    // restart button is the only way forward.
    expect(mockedRelaunch).not.toHaveBeenCalled();
    expect(mockedInstall).toHaveBeenCalledTimes(1);
  });

  it("an install still in flight survives an unmount: a remount shows the installing copy and no install button (case 10)", async () => {
    // THE DOOR, SHUT TWICE. Same navigation as above, but the install never
    // settles — which on Windows is the SUCCESS path (`install_inner` exits the
    // process). With the phase in component state the remount read `idle`: the
    // "this window will close" announcement was gone AND a fresh click-guard
    // offered "Install update" again, i.e. the UI itself invited a second
    // concurrent `download_and_install`. The Rust `InstallClaim` refuses that
    // with `"install-in-progress"` whatever the UI does; this case pins that the
    // UI does not ask for it either.
    render(<UpdateSection />);
    await screen.findByText("0.1.0");
    await openAvailable();
    mockedInstall.mockReturnValue(new Promise<void>(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    await screen.findByText(/window will close/i);

    cleanup();
    render(<UpdateSection />);
    await screen.findByText("0.1.0");
    // The installing copy is still what the user sees, unasked…
    expect(screen.getByText(/window will close/i).textContent ?? "").toBeTruthy();
    // …and there is NO install button to click: the section cannot be talked
    // into a second download by the remount.
    expect(screen.queryByRole("button", { name: "Install update" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    expect(mockedInstall).toHaveBeenCalledTimes(1);
  });
});

/** Wait for the install flow's progress subscription to be registered. */
async function waitForListen(): Promise<void> {
  for (let i = 0; i < 50 && mockedListen.mock.calls.length === 0; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  expect(mockedListen).toHaveBeenCalledTimes(1);
}

/** Everything on screen (no jest-dom in this repo's vitest setup — assertions
 * go through `textContent`). */
function sectionText(): string {
  return document.body.textContent ?? "";
}
