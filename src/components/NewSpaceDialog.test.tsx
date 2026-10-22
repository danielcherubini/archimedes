import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import NewSpaceDialog from "./NewSpaceDialog";
import * as tauri from "../lib/tauri";
import { resetModuleFlags, resetStores } from "../test/resetStores";

// Mock the Tauri IPC layer: `start_session` is native-only (there is one
// harness — no agent to choose), so the invoke is `{ cwd }`.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    spaceForPath: vi.fn().mockResolvedValue({ canonicalPath: "/tmp/ws", isSpace: false }),
    startSession: vi.fn().mockResolvedValue({
      sessionId: "native-1",
      cwd: "/tmp/ws",
      capabilities: { loadSession: true },
      archived: false,
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "test/m1",
          options: [{ value: "test/m1", name: "m1" }],
        },
      ],
    }),
  };
});

// The directory picker plugin is unavailable outside Tauri (jsdom).
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

// Radix's `Dialog` needs the pointer-capture stubs jsdom lacks + `matchMedia`;
// `src/test/setup.tsx` installs all of them for every file, so this file's own
// `beforeAll` block is gone (the rolling fixture migration from B4a).

beforeEach(() => {
  // Nothing here reset ANY store before: the first test's successful Start
  // calls `addSession` + `addSpace`, so those rows leaked into every later
  // render in this file.
  resetStores();
  resetModuleFlags();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Type a cwd + validate it (the dialog's `changeCwd` flow — the Radix
 * Dialog portals to `document.body`, so query there). */
async function setFolder(path: string) {
  const input = document.querySelector("input[placeholder='/path/to/project']") as HTMLInputElement;
  fireEvent.change(input, { target: { value: path } });
  // `spaceForPath` resolves → the folder check clears the error.
  await waitFor(() => expect(tauri.spaceForPath).toHaveBeenCalled());
}

describe("NewSpaceDialog (create the Space + start a native session)", () => {
  it("starts a native session in the picked folder (no agent selection anywhere — one harness)", async () => {
    render(<NewSpaceDialog onClose={vi.fn()} />);
    // The dialog has NO agent control (the picker is gone) — just the
    // folder field.
    expect(document.querySelector("select")).toBeNull();
    await setFolder("/tmp/ws");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    // The invoke is `{ cwd }` — a single argument, no agent id.
    await waitFor(() =>
      expect(tauri.startSession).toHaveBeenCalledWith("/tmp/ws")
    );
  });

  it("the_start_button_is_disabled_until_a_folder_is_validated", () => {
    render(<NewSpaceDialog onClose={vi.fn()} />);
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  it("keeps the dialog open on a start error", async () => {
    vi.mocked(tauri.startSession).mockRejectedValueOnce("no such folder");
    render(<NewSpaceDialog onClose={vi.fn()} />);
    await setFolder("/tmp/ws");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    // The error surfaces + the dialog stays open (the Cancel button is
    // still there).
    expect(await screen.findByText("no such folder")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("announces BOTH error lines through role=\"alert\" with the pre-migration classes", async () => {
    // Task C3 (finding 7): this dialog has TWO error lines — the folder check's
    // `folderError` and the start attempt's `error` — and neither was
    // announced. One test covers both because they are the two cited sites
    // (`NewSpaceDialog.tsx:134` and `:138`) and they render in the same tree.
    vi.mocked(tauri.spaceForPath).mockRejectedValueOnce("not a directory");
    vi.mocked(tauri.startSession).mockRejectedValueOnce("no such folder");
    render(<NewSpaceDialog onClose={vi.fn()} />);
    const input = document.querySelector(
      "input[placeholder='/path/to/project']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/tmp/ws" } });
    // 1. The folder line (`folderError`).
    const folderAlert = await screen.findByRole("alert");
    expect(folderAlert.textContent).toBe("not a directory");
    // Byte-identical to the hand-written line this replaced (no per-site
    // padding here, so the default class string).
    expect(folderAlert.getAttribute("class")).toBe(
      "text-ui-sm text-destructive",
    );
    // 2. The start line (`error`): the folder error leaves once the field is
    // re-validated clean, then the failed Start lands in its own alert.
    fireEvent.change(input, { target: { value: "/other" } });
    await waitFor(() => expect(screen.queryByText("not a directory")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const startAlert = await screen.findByRole("alert");
    expect(startAlert.textContent).toBe("no such folder");
    expect(startAlert.getAttribute("class")).toBe("text-ui-sm text-destructive");
    // The dialog stays open on failure (the Cancel button is still there).
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("renders no alert region while nothing has failed", async () => {
    render(<NewSpaceDialog onClose={vi.fn()} />);
    await setFolder("/tmp/ws");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("has NO `get_models` command (the native model picker is the synthesized configOptions)", () => {
    // The native session's model picker is the EXISTING `SessionConfigSelect`
    // pipeline (SessionInfo.configOptions → setSessionConfigOption) — a
    // separate `get_models` command would branch the picker on session kind
    // (a UI change). The tauri surface must not gain one.
    expect("getModels" in tauri).toBe(false);
    expect("get_models" in tauri).toBe(false);
  });
});
