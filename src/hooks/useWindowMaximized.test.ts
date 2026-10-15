import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { isSnappedToWorkArea, useWindowMaximized } from "./useWindowMaximized";

const mockIsMaximized = vi.fn();
const mockIsFullscreen = vi.fn();
const mockOnResized = vi.fn();
const mockOnMoved = vi.fn();
const mockOuterPosition = vi.fn();
const mockOuterSize = vi.fn();
const mockCurrentMonitor = vi.fn();
const mockUnlistenResized = vi.fn();
const mockUnlistenMoved = vi.fn();
const mockUnlistenWindowState = vi.fn();
const mockGetWindowState = vi.fn();
const mockListenWindowState = vi.fn();

vi.mock("../lib/tauri", () => ({
  getWindowState: () => mockGetWindowState(),
  listenWindowState: (cb: any) => mockListenWindowState(cb),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: mockIsMaximized,
    isFullscreen: mockIsFullscreen,
    onResized: mockOnResized,
    onMoved: mockOnMoved,
    outerPosition: mockOuterPosition,
    outerSize: mockOuterSize,
  }),
  currentMonitor: () => mockCurrentMonitor(),
}));

describe("isSnappedToWorkArea", () => {
  const workArea = {
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1040 },
  };

  it("returns true for left-half vertical snap", () => {
    expect(
      isSnappedToWorkArea(
        { x: 0, y: 0 },
        { width: 960, height: 1040 },
        workArea,
        1,
      ),
    ).toBe(true);
  });

  it("returns true for top-half horizontal snap", () => {
    expect(
      isSnappedToWorkArea(
        { x: 0, y: 0 },
        { width: 1920, height: 520 },
        workArea,
        1,
      ),
    ).toBe(true);
  });

  it("returns true for corner snap (quadrant)", () => {
    expect(
      isSnappedToWorkArea(
        { x: 960, y: 520 },
        { width: 960, height: 520 },
        workArea,
        1,
      ),
    ).toBe(true);
  });

  it("returns false for floating window", () => {
    expect(
      isSnappedToWorkArea(
        { x: 200, y: 200 },
        { width: 800, height: 600 },
        workArea,
        1,
      ),
    ).toBe(false);
  });

  it("respects scaleFactor tolerance", () => {
    expect(
      isSnappedToWorkArea(
        { x: 0, y: 0 },
        { width: 960, height: 1015 },
        workArea,
        2,
      ),
    ).toBe(true);
  });
});

describe("useWindowMaximized", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockIsMaximized.mockResolvedValue(false);
    mockIsFullscreen.mockResolvedValue(false);
    mockOnResized.mockResolvedValue(mockUnlistenResized);
    mockOnMoved.mockResolvedValue(mockUnlistenMoved);
    mockOuterPosition.mockResolvedValue({ x: 100, y: 100 });
    mockOuterSize.mockResolvedValue({ width: 800, height: 600 });
    mockCurrentMonitor.mockResolvedValue({
      scaleFactor: 1,
      workArea: {
        position: { x: 0, y: 0 },
        size: { width: 1920, height: 1040 },
      },
    });
    mockGetWindowState.mockResolvedValue({
      isTiled: false,
      isMaximized: false,
      isFullscreen: false,
      native: false,
    });
    mockListenWindowState.mockResolvedValue(mockUnlistenWindowState);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false initially when window is neither maximized, fullscreen, nor snapped", async () => {
    mockIsMaximized.mockResolvedValue(false);
    mockIsFullscreen.mockResolvedValue(false);

    const { result } = renderHook(() => useWindowMaximized());

    expect(result.current).toBe(false);

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(false);
  });

  it("returns true when window starts maximized", async () => {
    mockIsMaximized.mockResolvedValue(true);
    mockIsFullscreen.mockResolvedValue(false);

    const { result } = renderHook(() => useWindowMaximized());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(true);
  });

  it("returns true when window starts fullscreen", async () => {
    mockIsMaximized.mockResolvedValue(false);
    mockIsFullscreen.mockResolvedValue(true);

    const { result } = renderHook(() => useWindowMaximized());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(true);
  });

  it("returns true when window is snapped to the side (Windows Snap full work-area height)", async () => {
    mockIsMaximized.mockResolvedValue(false);
    mockIsFullscreen.mockResolvedValue(false);
    // Left-half snap: x=0, y=0, width=960, height=1040 (matches workArea height)
    mockOuterPosition.mockResolvedValue({ x: 0, y: 0 });
    mockOuterSize.mockResolvedValue({ width: 960, height: 1040 });

    const { result } = renderHook(() => useWindowMaximized());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(true);
  });

  it("returns true when window is snapped horizontally (full work-area width)", async () => {
    mockIsMaximized.mockResolvedValue(false);
    mockIsFullscreen.mockResolvedValue(false);
    // Top-half snap: x=0, y=0, width=1920, height=520 (matches workArea width)
    mockOuterPosition.mockResolvedValue({ x: 0, y: 0 });
    mockOuterSize.mockResolvedValue({ width: 1920, height: 520 });

    const { result } = renderHook(() => useWindowMaximized());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(true);
  });

  it("returns true when window is snapped to a corner quadrant (Windows 11 2x2 snap)", async () => {
    mockIsMaximized.mockResolvedValue(false);
    mockIsFullscreen.mockResolvedValue(false);
    // Bottom-right snap: x=960, y=520, width=960, height=520
    mockOuterPosition.mockResolvedValue({ x: 960, y: 520 });
    mockOuterSize.mockResolvedValue({ width: 960, height: 520 });

    const { result } = renderHook(() => useWindowMaximized());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(true);
  });

  it("updates to true when moved into a snapped position via onMoved", async () => {
    let moveCallback: (() => void) | undefined;
    mockOnMoved.mockImplementation((cb: () => void) => {
      moveCallback = cb;
      return Promise.resolve(mockUnlistenMoved);
    });

    mockIsMaximized.mockResolvedValue(false);
    mockOuterPosition.mockResolvedValue({ x: 100, y: 100 });
    mockOuterSize.mockResolvedValue({ width: 800, height: 600 });

    const { result } = renderHook(() => useWindowMaximized());

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(false);

    // Snapped to left
    mockOuterPosition.mockResolvedValue({ x: 0, y: 0 });
    mockOuterSize.mockResolvedValue({ width: 960, height: 1040 });

    await act(async () => {
      moveCallback?.();
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(result.current).toBe(true);
  });

  it("updates to false when dragged away from snapped position", async () => {
    let moveCallback: (() => void) | undefined;
    mockOnMoved.mockImplementation((cb: () => void) => {
      moveCallback = cb;
      return Promise.resolve(mockUnlistenMoved);
    });

    mockIsMaximized.mockResolvedValue(false);
    mockOuterPosition.mockResolvedValue({ x: 0, y: 0 });
    mockOuterSize.mockResolvedValue({ width: 960, height: 1040 });

    const { result } = renderHook(() => useWindowMaximized());

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(true);

    // Dragged to float
    mockOuterPosition.mockResolvedValue({ x: 200, y: 200 });
    mockOuterSize.mockResolvedValue({ width: 800, height: 600 });

    await act(async () => {
      moveCallback?.();
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(result.current).toBe(false);
  });

  it("cleans up both resize and move listeners and pending debounce timer on unmount", async () => {
    let moveCallback: (() => void) | undefined;
    mockOnMoved.mockImplementation((cb: () => void) => {
      moveCallback = cb;
      return Promise.resolve(mockUnlistenMoved);
    });

    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => useWindowMaximized());

    await act(async () => {
      await Promise.resolve();
    });

    mockOuterPosition.mockClear();

    // Schedule debounce timer via move
    act(() => {
      moveCallback?.();
    });

    unmount();

    // Advance time after unmount — geometry check should NOT run
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(mockOuterPosition).not.toHaveBeenCalled();
    expect(removeEventListenerSpy).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(mockUnlistenResized).toHaveBeenCalledTimes(1);
    expect(mockUnlistenMoved).toHaveBeenCalledTimes(1);
    expect(mockUnlistenWindowState).toHaveBeenCalledTimes(1);

    removeEventListenerSpy.mockRestore();
  });

  describe("native Linux window state (GTK event bridge)", () => {
    it("hydrates square state on mount when getWindowState returns isTiled: true and native: true", async () => {
      mockGetWindowState.mockResolvedValue({
        isTiled: true,
        isMaximized: false,
        isFullscreen: false,
        native: true,
      });

      const { result } = renderHook(() => useWindowMaximized());

      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current).toBe(true);
    });

    it("sets isSquare(true) when native event window-state-changed emits isTiled: true", async () => {
      let stateCallback: ((event: any) => void) | undefined;
      mockListenWindowState.mockImplementation((cb: any) => {
        stateCallback = cb;
        return Promise.resolve(mockUnlistenWindowState);
      });

      mockGetWindowState.mockResolvedValue({
        isTiled: false,
        isMaximized: false,
        isFullscreen: false,
        native: true,
      });

      const { result } = renderHook(() => useWindowMaximized());

      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current).toBe(false);

      await act(async () => {
        stateCallback?.({
          isTiled: true,
          isMaximized: false,
          isFullscreen: false,
          native: true,
        });
      });

      expect(result.current).toBe(true);
    });

    it("does not allow resize event with non-matching geometry to clobber active native isTiled: true", async () => {
      let resizeCallback: (() => void) | undefined;
      mockOnResized.mockImplementation((cb: () => void) => {
        resizeCallback = cb;
        return Promise.resolve(mockUnlistenResized);
      });

      mockGetWindowState.mockResolvedValue({
        isTiled: true,
        isMaximized: false,
        isFullscreen: false,
        native: true,
      });

      // Window geometry reports non-matching floating coordinates
      mockOuterPosition.mockResolvedValue({ x: 200, y: 200 });
      mockOuterSize.mockResolvedValue({ width: 800, height: 600 });
      mockIsMaximized.mockResolvedValue(false);

      const { result } = renderHook(() => useWindowMaximized());

      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current).toBe(true);

      // Trigger resize event
      await act(async () => {
        resizeCallback?.();
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });

      // Still square because Linux native state governs
      expect(result.current).toBe(true);
    });

    it("transitions to unrounded when native event says tiled/maximized are false", async () => {
      let stateCallback: ((event: any) => void) | undefined;
      mockListenWindowState.mockImplementation((cb: any) => {
        stateCallback = cb;
        return Promise.resolve(mockUnlistenWindowState);
      });

      mockGetWindowState.mockResolvedValue({
        isTiled: true,
        isMaximized: false,
        isFullscreen: false,
        native: true,
      });

      const { result } = renderHook(() => useWindowMaximized());

      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current).toBe(true);

      // Untile / restore event
      await act(async () => {
        stateCallback?.({
          isTiled: false,
          isMaximized: false,
          isFullscreen: false,
          native: true,
        });
      });

      expect(result.current).toBe(false);
    });

    it("does not allow late getWindowState() to overwrite state if native event arrived first", async () => {
      let stateCallback: ((event: any) => void) | undefined;
      mockListenWindowState.mockImplementation((cb: any) => {
        stateCallback = cb;
        return Promise.resolve(mockUnlistenWindowState);
      });

      let resolveGetWindowState!: (val: any) => void;
      mockGetWindowState.mockReturnValue(
        new Promise((resolve) => {
          resolveGetWindowState = resolve;
        }),
      );

      const { result } = renderHook(() => useWindowMaximized());

      // Native event arrives first with isTiled: true
      await act(async () => {
        stateCallback?.({
          isTiled: true,
          isMaximized: false,
          isFullscreen: false,
          native: true,
        });
      });

      expect(result.current).toBe(true);

      // Late getWindowState resolves with isTiled: false
      await act(async () => {
        resolveGetWindowState({
          isTiled: false,
          isMaximized: false,
          isFullscreen: false,
          native: true,
        });
        await Promise.resolve();
      });

      // State is preserved from the native event
      expect(result.current).toBe(true);
    });

    it("sets isSquare(true) when native event window-state-changed emits isMaximized: true", async () => {
      let stateCallback: ((event: any) => void) | undefined;
      mockListenWindowState.mockImplementation((cb: any) => {
        stateCallback = cb;
        return Promise.resolve(mockUnlistenWindowState);
      });

      mockGetWindowState.mockResolvedValue({
        isTiled: false,
        isMaximized: false,
        isFullscreen: false,
        native: true,
      });

      const { result } = renderHook(() => useWindowMaximized());
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current).toBe(false);

      await act(async () => {
        stateCallback?.({
          isTiled: false,
          isMaximized: true,
          isFullscreen: false,
          native: true,
        });
      });

      expect(result.current).toBe(true);
    });

    it("sets isSquare(true) when native event window-state-changed emits isFullscreen: true", async () => {
      let stateCallback: ((event: any) => void) | undefined;
      mockListenWindowState.mockImplementation((cb: any) => {
        stateCallback = cb;
        return Promise.resolve(mockUnlistenWindowState);
      });

      mockGetWindowState.mockResolvedValue({
        isTiled: false,
        isMaximized: false,
        isFullscreen: false,
        native: true,
      });

      const { result } = renderHook(() => useWindowMaximized());
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current).toBe(false);

      await act(async () => {
        stateCallback?.({
          isTiled: false,
          isMaximized: false,
          isFullscreen: true,
          native: true,
        });
      });

      expect(result.current).toBe(true);
    });

    it("drops stale geometry check if native event arrives while geometry check is in-flight", async () => {
      let stateCallback: ((event: any) => void) | undefined;
      mockListenWindowState.mockImplementation((cb: any) => {
        stateCallback = cb;
        return Promise.resolve(mockUnlistenWindowState);
      });

      mockGetWindowState.mockResolvedValue({
        isTiled: false,
        isMaximized: false,
        isFullscreen: false,
        native: false,
      });

      let resolveIsMaximized!: (val: boolean) => void;
      mockIsMaximized.mockReturnValue(
        new Promise((resolve) => {
          resolveIsMaximized = resolve;
        }),
      );

      const { result } = renderHook(() => useWindowMaximized());

      // Native event arrives and sets native: true and isTiled: false
      await act(async () => {
        stateCallback?.({
          isTiled: false,
          isMaximized: false,
          isFullscreen: false,
          native: true,
        });
      });
      expect(result.current).toBe(false);

      // Now late geometry check resolves with isMaximized: true
      await act(async () => {
        resolveIsMaximized(true);
        await Promise.resolve();
      });

      // Because native state took authority, stale geometry check was dropped
      expect(result.current).toBe(false);
    });

    it("does not perform geometry calculation on move or resize when native is true", async () => {
      let moveCallback: (() => void) | undefined;
      mockOnMoved.mockImplementation((cb: () => void) => {
        moveCallback = cb;
        return Promise.resolve(mockUnlistenMoved);
      });

      mockGetWindowState.mockResolvedValue({
        isTiled: false,
        isMaximized: false,
        isFullscreen: false,
        native: true,
      });

      renderHook(() => useWindowMaximized());
      await act(async () => {
        await Promise.resolve();
      });

      mockOuterPosition.mockClear();
      mockOuterSize.mockClear();
      mockCurrentMonitor.mockClear();

      await act(async () => {
        moveCallback?.();
        vi.advanceTimersByTime(200);
        await Promise.resolve();
      });

      expect(mockOuterPosition).not.toHaveBeenCalled();
      expect(mockOuterSize).not.toHaveBeenCalled();
      expect(mockCurrentMonitor).not.toHaveBeenCalled();
    });
  });

  describe("non-native (Windows/macOS) geometry checks", () => {
    it("hydrating isMaximized: true with native: false un-maximizes via resize to unrounded", async () => {
      let resizeCallback: (() => void) | undefined;
      mockOnResized.mockImplementation((cb: () => void) => {
        resizeCallback = cb;
        return Promise.resolve(mockUnlistenResized);
      });

      mockGetWindowState.mockResolvedValue({
        isTiled: false,
        isMaximized: true,
        isFullscreen: false,
        native: false,
      });
      mockIsMaximized.mockResolvedValue(true);

      const { result } = renderHook(() => useWindowMaximized());

      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current).toBe(true);

      // Unmaximize
      mockIsMaximized.mockResolvedValue(false);
      mockOuterPosition.mockResolvedValue({ x: 200, y: 200 });
      mockOuterSize.mockResolvedValue({ width: 800, height: 600 });

      await act(async () => {
        resizeCallback?.();
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });

      expect(result.current).toBe(false);
    });

    it("detects snap fallback via geometry when native: false", async () => {
      mockGetWindowState.mockResolvedValue({
        isTiled: false,
        isMaximized: false,
        isFullscreen: false,
        native: false,
      });
      mockIsMaximized.mockResolvedValue(false);
      // Snapped to left half
      mockOuterPosition.mockResolvedValue({ x: 0, y: 0 });
      mockOuterSize.mockResolvedValue({ width: 960, height: 1040 });

      const { result } = renderHook(() => useWindowMaximized());

      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current).toBe(true);
    });

    it("does not fall back to window.screen when currentMonitor returns valid monitor info", async () => {
      mockGetWindowState.mockResolvedValue({
        isTiled: false,
        isMaximized: false,
        isFullscreen: false,
        native: false,
      });
      mockIsMaximized.mockResolvedValue(false);
      mockIsFullscreen.mockResolvedValue(false);
      // Floating window that is tall: height 1000, workArea height is 1040 (not snapped)
      mockOuterPosition.mockResolvedValue({ x: 200, y: 200 });
      mockOuterSize.mockResolvedValue({ width: 800, height: 1000 });
      mockCurrentMonitor.mockResolvedValue({
        scaleFactor: 1,
        workArea: {
          position: { x: 0, y: 0 },
          size: { width: 1920, height: 1040 },
        },
      });

      const origScreen = window.screen;
      const origInnerHeight = window.innerHeight;
      Object.defineProperty(window, "screen", {
        value: { availHeight: 1000, availWidth: 1920 },
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 1000,
        configurable: true,
      });

      try {
        const { result } = renderHook(() => useWindowMaximized());
        await act(async () => {
          await Promise.resolve();
        });

        // Should be false because currentMonitor is valid and window is NOT snapped to workArea
        expect(result.current).toBe(false);
      } finally {
        Object.defineProperty(window, "screen", {
          value: origScreen,
          configurable: true,
        });
        Object.defineProperty(window, "innerHeight", {
          value: origInnerHeight,
          configurable: true,
        });
      }
    });

    it("falls back to window.screen when currentMonitor returns null", async () => {
      mockGetWindowState.mockResolvedValue({
        isTiled: false,
        isMaximized: false,
        isFullscreen: false,
        native: false,
      });
      mockIsMaximized.mockResolvedValue(false);
      mockIsFullscreen.mockResolvedValue(false);
      mockCurrentMonitor.mockResolvedValue(null);

      const origScreen = window.screen;
      const origInnerHeight = window.innerHeight;
      Object.defineProperty(window, "screen", {
        value: { availHeight: 1000, availWidth: 1920 },
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 1000,
        configurable: true,
      });

      try {
        const { result } = renderHook(() => useWindowMaximized());
        await act(async () => {
          await Promise.resolve();
        });

        expect(result.current).toBe(true);
      } finally {
        Object.defineProperty(window, "screen", {
          value: origScreen,
          configurable: true,
        });
        Object.defineProperty(window, "innerHeight", {
          value: origInnerHeight,
          configurable: true,
        });
      }
    });

    it("drops stale geometry check if a newer check was initiated", async () => {
      let resizeCallback: (() => void) | undefined;
      mockOnResized.mockImplementation((cb: () => void) => {
        resizeCallback = cb;
        return Promise.resolve(mockUnlistenResized);
      });

      mockGetWindowState.mockResolvedValue({
        isTiled: false,
        isMaximized: false,
        isFullscreen: false,
        native: false,
      });

      let resolveFirstCheck!: () => void;
      mockIsMaximized.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstCheck = () => resolve(true);
          }),
      );

      const { result } = renderHook(() => useWindowMaximized());

      // Trigger second check while first is still pending
      mockIsMaximized.mockResolvedValue(false);
      mockOuterPosition.mockResolvedValue({ x: 200, y: 200 });
      mockOuterSize.mockResolvedValue({ width: 800, height: 600 });

      await act(async () => {
        resizeCallback?.();
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });

      // Second check completes, says false
      expect(result.current).toBe(false);

      // Now first check resolves with true
      await act(async () => {
        resolveFirstCheck();
        await Promise.resolve();
      });

      // Should remain false because first check was stale!
      expect(result.current).toBe(false);
    });
  });
});
