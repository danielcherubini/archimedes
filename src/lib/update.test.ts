import { describe, expect, it, vi, beforeEach } from "vitest";

// The `version.test.ts` / `tauri.test.ts` pattern, and for the same reason:
// every wrapper here is a ONE-LINE `invoke`/`listen` call, so the only thing
// worth pinning is the WIRE CONTRACT — the three command names and the one
// event name. The component tests mock THIS module wholesale, so they cannot
// see a renamed command, and no Rust test registers the updater commands
// (`tests/ipc.rs` builds its own `generate_handler!` with no updater plugin).
// A drift in either string passes every test on both sides and fails only at
// runtime, in the desktop app.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import {
  checkUpdate,
  installUpdate,
  listenUpdateProgress,
  relaunchApp,
  type UpdateProgress,
} from "./update";

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedListen.mockReset();
});

describe("checkUpdate (the `check_update` seam, ADR 0053)", () => {
  it("invokes the check_update command with no arguments", async () => {
    mockedInvoke.mockResolvedValue({ state: "upToDate" });
    await checkUpdate();
    expect(mockedInvoke).toHaveBeenCalledWith("check_update");
  });

  it("passes the tagged upToDate outcome through UNCHANGED", async () => {
    // The `state` tag is what keeps "confirmed current" discriminating on the
    // wire rather than being inferred from which optional fields are filled —
    // reshaping it here would put the three-way split at risk.
    mockedInvoke.mockResolvedValue({ state: "upToDate" });
    expect(await checkUpdate()).toEqual({ state: "upToDate" });
  });

  it("passes an available outcome through unchanged (version/notes/date)", async () => {
    const outcome = {
      state: "available",
      version: "0.2.0",
      notes: "release body",
      date: "2026-10-14T09:00:00Z",
    };
    mockedInvoke.mockResolvedValue(outcome);
    expect(await checkUpdate()).toEqual(outcome);
  });

  it("rejects with the Rust typed refusal envelope (a failed check is NOT upToDate)", async () => {
    // The conflation lives or dies at this layer too: the Rust command answers
    // the `UpdateError` envelope for a 404 on `latest.json` — `{kind, message}`
    // whose `message` is the typed code verbatim — and the wrapper must let
    // that REJECT — catching it into `{ state: "upToDate" }` here would make a
    // broken update endpoint read as "you are current".
    mockedInvoke.mockRejectedValue({
      kind: "release_not_found",
      message: "release-not-found",
    });
    await expect(checkUpdate()).rejects.toMatchObject({
      kind: "release_not_found",
      message: "release-not-found",
    });
  });
});

describe("installUpdate / relaunchApp (the install + restart seam)", () => {
  it("invokes the install_update command with no arguments", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await installUpdate();
    expect(mockedInvoke).toHaveBeenCalledWith("install_update");
  });

  it("lets an install rejection through (a Linux deb failure is not a success)", async () => {
    // The honest wire shape (task14's UpdateError envelope): the hand-built
    // {kind, message} body whose message is the updater code verbatim. The
    // wrapper is a pass-through, so the pin models the wire, not a convenience
    // string; toMatchObject because the hand-built envelope may carry the
    // variant's own extra field.
    mockedInvoke.mockRejectedValue({
      kind: "install_failed",
      message: "install-failed",
    });
    await expect(installUpdate()).rejects.toMatchObject({
      kind: "install_failed",
      message: "install-failed",
    });
  });

  it("invokes the relaunch_app command with no arguments", async () => {
    // The command never returns (`AppHandle::restart()` is `-> !`), so the
    // wrapper has nothing to await on the far side — no `.then` to pin.
    mockedInvoke.mockReturnValue(new Promise(() => {}));
    void relaunchApp();
    expect(mockedInvoke).toHaveBeenCalledWith("relaunch_app");
  });
});

describe("listenUpdateProgress (the `update://progress` event)", () => {
  it("registers on update://progress and forwards the payload + the unlisten fn", async () => {
    const unlisten = vi.fn();
    let eventCallback: EventCallback<UpdateProgress> | undefined;
    mockedListen.mockImplementation((_event, cb) => {
      eventCallback = cb as EventCallback<UpdateProgress>;
      return Promise.resolve(unlisten);
    });

    const handler = vi.fn();
    const resultUnlisten = await listenUpdateProgress(handler);

    expect(mockedListen).toHaveBeenCalledWith(
      "update://progress",
      expect.any(Function),
    );
    // The unlisten fn is handed back verbatim — the component owns the
    // subscription's lifetime and must be able to drop it.
    expect(resultUnlisten).toBe(unlisten);

    // `total: null` is the "no Content-Length" shape (a chunked/gzipped
    // response) — forwarded as null, never as 0 the UI would read as empty.
    const payload: UpdateProgress = { downloaded: 4096, total: null };
    eventCallback?.({ event: "update://progress", id: 1, payload });
    expect(handler).toHaveBeenCalledWith(payload);

    const known: UpdateProgress = { downloaded: 8192, total: 12344 };
    eventCallback?.({ event: "update://progress", id: 1, payload: known });
    expect(handler).toHaveBeenLastCalledWith(known);
  });
});
