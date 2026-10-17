import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNewSpaceDialogOpen,
  openNewSpaceDialog,
  setNewSpaceDialogOpen,
  subscribeNewSpaceDialog,
} from "./newSpaceDialogState";

// The flag is MODULE-SCOPED (no store, no React): a `true` left by one case
// is `true` for the next one — and for every later test FILE that mounts the
// dialog. Start each case from the closed side.
beforeEach(() => {
  setNewSpaceDialogOpen(false);
});

describe("newSpaceDialogState", () => {
  it("starts closed on a FRESH module (no seeding: an auto-opened dialog on launch is not worth restoring)", async () => {
    // `vi.resetModules()` + a dynamic import is the only honest way to read
    // the DEFAULT: the flag is module state, so the instance this file's
    // static `import` bound to has already been written by the `beforeEach`
    // above — a `false` there is indistinguishable from a default that was
    // `true` and got closed. The re-import is a SEPARATE instance (its own
    // flag, its own listeners); the static one is untouched.
    vi.resetModules();
    const fresh = await import("./newSpaceDialogState");
    expect(fresh.getNewSpaceDialogOpen()).toBe(false);
    // And the fresh instance is still closed after its own module body ran —
    // i.e. nothing at import time reached for storage to seed it.
    expect(localStorage.length).toBe(0);
  });

  it("persists nothing: no storage key exists, so a reload cannot restore the dialog", () => {
    // `leftPaneState` is the single owner of its localStorage key; this
    // module has NO key at all. Assert the absence rather than trusting the
    // source: after opening, the whole storage area is still empty, and
    // clearing it leaves the live flag alone.
    openNewSpaceDialog();
    expect(localStorage.length).toBe(0);
    localStorage.clear();
    expect(getNewSpaceDialogOpen()).toBe(true);
  });

  it("openNewSpaceDialog() flips the flag and notifies", () => {
    const notify = vi.fn();
    const unsubscribe = subscribeNewSpaceDialog(notify);
    openNewSpaceDialog();
    expect(getNewSpaceDialogOpen()).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("round-trips the flag through get/set", () => {
    expect(getNewSpaceDialogOpen()).toBe(false);
    setNewSpaceDialogOpen(true);
    expect(getNewSpaceDialogOpen()).toBe(true);
    setNewSpaceDialogOpen(false);
    expect(getNewSpaceDialogOpen()).toBe(false);
  });

  it("does NOT notify when the value does not change (the same-value echo)", () => {
    const notify = vi.fn();
    const unsubscribe = subscribeNewSpaceDialog(notify);
    setNewSpaceDialogOpen(true);
    setNewSpaceDialogOpen(true);
    // `openNewSpaceDialog()` on an already-open dialog is the same echo: the
    // `Open Space` button clicked twice while the dialog is up re-renders
    // nothing.
    openNewSpaceDialog();
    expect(notify).toHaveBeenCalledTimes(1);
    setNewSpaceDialogOpen(false);
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("stops notifying after the returned unsubscribe runs", () => {
    const notify = vi.fn();
    const unsubscribe = subscribeNewSpaceDialog(notify);
    setNewSpaceDialogOpen(true);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
    setNewSpaceDialogOpen(false);
    setNewSpaceDialogOpen(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(getNewSpaceDialogOpen()).toBe(true);
  });
});
