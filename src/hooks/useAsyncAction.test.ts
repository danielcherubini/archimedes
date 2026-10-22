import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAsyncAction } from "./useAsyncAction";

/**
 * The shared busy/error machine (finding 11b). Every assertion in this file is
 * derived from what the six migrated sites DO today, not from what a generic
 * `useAsyncAction` might ideally do — the extraction's whole contract is that no
 * site's observable behaviour moves. Where a behaviour is uglier than a fresh
 * design would be (the unguarded overlap, the render-time guard, the first
 * settle clearing `busy`), it is pinned anyway, because a site depends on it.
 */

/** Resolve on command, so "in flight" is observable. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing observes an unhandled rejection between the test's `reject()` and
  // the hook's `.catch` — the hook always attaches one, but the deferral itself
  // must not trip vitest's unhandled-rejection check if a test rejects and then
  // asserts before the microtask runs.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

describe("useAsyncAction — the machine", () => {
  it("is_idle_with_no_error_before_anything_runs", () => {
    const { result } = renderHook(() => useAsyncAction());
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("busy_is_true_while_the_action_is_in_flight_and_false_after", async () => {
    const d = deferred<string>();
    const { result } = renderHook(() => useAsyncAction());
    let done = false;
    act(() => {
      void result.current.run(() => d.promise).then(() => {
        done = true;
      });
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.error).toBeNull();
    await act(async () => {
      d.resolve("ok");
      await d.promise;
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
    expect(done).toBe(true);
  });

  it("a_rejection_becomes_the_describeIpcError_sentence_and_clears_busy", async () => {
    // A Tauri `Err(String)` rejection — the shape every migrated site actually
    // receives — must land in `error` VERBATIM, because each site's error line
    // (and its tests) asserts the exact string.
    const d = deferred<never>();
    const { result } = renderHook(() => useAsyncAction());
    act(() => {
      void result.current.run(() => d.promise);
    });
    await act(async () => {
      d.reject("respond-permission failed");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toBe("respond-permission failed");
    expect(result.current.busy).toBe(false);
  });

  it("a_rejection_is_never_re_thrown_out_of_run", async () => {
    // Today every site wraps the call in try/catch/finally, so the async
    // function they build NEVER rejects — callers write `void respond(...)`. If
    // `run` rejected, every one of those `void` calls would become an unhandled
    // rejection.
    const { result } = renderHook(() => useAsyncAction());
    await act(async () => {
      await expect(
        result.current.run(() => Promise.reject(new Error("boom"))),
      ).resolves.toBeUndefined();
    });
    expect(result.current.error).toBe("boom");
  });

  it("reads_a_typed_ipc_envelope_the_same_way_describeIpcError_does", async () => {
    // The typed envelope from Rust (`{ kind, message }`) is the other half of
    // what `describeIpcError` handles; the hook must not re-implement a
    // narrower `String(err)` and turn it into `[object Object]`.
    const { result } = renderHook(() => useAsyncAction());
    await act(async () => {
      await result.current.run(() =>
        Promise.reject({ kind: "invalid_input", message: "no such folder" }),
      );
    });
    expect(result.current.error).toBe("no such folder");
  });

  it("clears_the_previous_error_when_a_new_run_starts", async () => {
    // The `setError(null)` at the top of every site's handler: a retry after a
    // failure must not leave the old sentence on screen while the retry is in
    // flight.
    const first = deferred<never>();
    const second = deferred<string>();
    const { result } = renderHook(() => useAsyncAction());
    act(() => {
      void result.current.run(() => first.promise);
    });
    await act(async () => {
      first.reject("folder is not a space");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toBe("folder is not a space");
    act(() => {
      void result.current.run(() => second.promise);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(true);
    await act(async () => {
      second.resolve("ok");
      await second.promise;
    });
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it("clearError_clears_the_message_without_touching_busy", async () => {
    // `SessionConfigSelect`'s 5 s auto-clear calls `setError(null)` from a
    // timer while the trigger is NOT disabled — so the hook must expose a way to
    // drop the message alone. Clearing `busy` too would re-enable a trigger
    // mid-flight.
    const d = deferred<never>();
    const { result } = renderHook(() => useAsyncAction());
    act(() => {
      void result.current.run(() => d.promise);
    });
    await act(async () => {
      d.reject("set_config_option failed");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toBe("set_config_option failed");
    act(() => {
      result.current.clearError();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it("survives_the_promise_settling_after_unmount", async () => {
    // No site has an unmount guard today (`finally { setBusy(false) }` simply
    // lands on a dead tree, which React 19 ignores), so the hook must not THROW
    // when the action outlives the component. Asserted as "the awaited `run`
    // resolves", not as a post-unmount `busy` reading — an unmounted hook never
    // re-renders, so its last rendered flag stays `true` and asserting `false`
    // here would be a claim about React, not about this hook.
    const d = deferred<string>();
    const { result, unmount } = renderHook(() => useAsyncAction());
    let settled: () => void;
    const settledPromise = new Promise<void>((res) => {
      settled = res;
    });
    act(() => {
      void result.current.run(() => d.promise).then(settled!);
    });
    unmount();
    await act(async () => {
      d.resolve("late");
      await settledPromise;
    });
    expect(result.current.error).toBeNull();
  });
});

describe("useAsyncAction — the guard is per call site, never free", () => {
  it("without the option, a second run while busy STILL runs (four sites depend on this)", async () => {
    // `PermissionPrompt`, `SudoConfirmModal`, `AskQuestionCard` and
    // `NewSpaceDialog` have NO re-entrancy guard today: a fast double click
    // fires the IPC call TWICE. That is their shipped behaviour, and this hook
    // must not silently upgrade it — hence the default is unguarded.
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);
    const { result } = renderHook(() => useAsyncAction());
    act(() => {
      void result.current.run(fn);
      void result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(2);
    await act(async () => {
      d.resolve("ok");
      await d.promise;
    });
    expect(result.current.busy).toBe(false);
  });

  it("guard:true blocks a second run while busy", async () => {
    // `SudoPasswordModal.tsx:49` (`if (busy) return`) and
    // `SessionConfigSelect.tsx:217` (`if (pending) return`) self-guard, because
    // a sudo password or a config write must be answered exactly once.
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);
    const { result } = renderHook(() => useAsyncAction({ guard: true }));
    act(() => {
      void result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);
    act(() => {
      void result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => {
      d.resolve("ok");
      await d.promise;
    });
    expect(result.current.busy).toBe(false);
    // After the first settles, a later run is allowed again. (Awaited inside the
    // `act` so the already-resolved promise's `setBusy(false)` lands in the same
    // flush — otherwise React warns about an update outside `act`.)
    await act(async () => {
      await result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.current.busy).toBe(false);
  });

  it("guard:true reads the RENDERED busy flag, so two runs in one batch both start", async () => {
    // The exactness claim, pinned. Today's guard is `if (busy) return` reading
    // the flag from the RENDER, not a ref — so two clicks delivered before React
    // re-renders both pass it. A `useRef` here would be a (better) behaviour
    // change, and this task is not allowed one, so the guard reads state.
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);
    const { result } = renderHook(() => useAsyncAction({ guard: true }));
    const run = result.current.run;
    act(() => {
      void run(fn);
      void run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(2);
    await act(async () => {
      d.resolve("ok");
      await d.promise;
    });
  });

  it("the FIRST settle clears busy even while a second overlapping run is in flight", async () => {
    // The consequence of the unguarded default, pinned so nobody "fixes" it
    // with a counter: each run owns one `setBusy(true)`/`setBusy(false)` pair, so
    // the first to settle re-enables the buttons while the other is still
    // pending. That is what all six sites do today.
    const a = deferred<string>();
    const b = deferred<string>();
    const { result } = renderHook(() => useAsyncAction());
    act(() => {
      void result.current.run(() => a.promise);
      void result.current.run(() => b.promise);
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      a.resolve("first");
      await a.promise;
    });
    expect(result.current.busy).toBe(false);
    await act(async () => {
      b.resolve("second");
      await b.promise;
    });
    expect(result.current.busy).toBe(false);
  });
});
