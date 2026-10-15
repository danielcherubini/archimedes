import { useEffect, useRef, useState } from "react";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import {
  getWindowState,
  listenWindowState,
  type WindowFrameState,
} from "../lib/tauri";

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface WorkArea {
  position: WindowPosition;
  size: WindowSize;
}

/**
 * Checks whether a window is snapped to monitor work area edges
 * (e.g. Windows Snap / Aero Snap / quadrant tiling).
 */
export function isSnappedToWorkArea(
  pos: WindowPosition,
  size: WindowSize,
  workArea: WorkArea,
  scaleFactor = 1,
): boolean {
  const scale = scaleFactor || 1;
  const tolerance = Math.max(16, Math.round(scale * 16));

  // 1. Vertically snapped (left-half, right-half, 1/3, 2/3):
  // Height matches monitor work area and top matches work area top.
  const isFullHeight =
    Math.abs(size.height - workArea.size.height) <= tolerance &&
    Math.abs(pos.y - workArea.position.y) <= tolerance;

  // 2. Horizontally snapped (top-half, bottom-half):
  // Width matches monitor work area and left matches work area left.
  const isFullWidth =
    Math.abs(size.width - workArea.size.width) <= tolerance &&
    Math.abs(pos.x - workArea.position.x) <= tolerance;

  // 3. Corner / quadrant snap (Windows 11 2x2 snap layout):
  const isHalfHeight =
    Math.abs(size.height - Math.round(workArea.size.height / 2)) <=
    tolerance * 2;
  const isHalfWidth =
    Math.abs(size.width - Math.round(workArea.size.width / 2)) <=
    tolerance * 2;
  const touchesTopOrBottom =
    Math.abs(pos.y - workArea.position.y) <= tolerance ||
    Math.abs(
      pos.y + size.height - (workArea.position.y + workArea.size.height),
    ) <= tolerance;
  const touchesLeftOrRight =
    Math.abs(pos.x - workArea.position.x) <= tolerance ||
    Math.abs(
      pos.x + size.width - (workArea.position.x + workArea.size.width),
    ) <= tolerance;
  const isCornerSnap =
    isHalfHeight &&
    isHalfWidth &&
    touchesTopOrBottom &&
    touchesLeftOrRight;

  return isFullHeight || isFullWidth || isCornerSnap;
}

/**
 * Tracks whether the current Tauri window is maximized, fullscreen, or snapped
 * to a screen edge (e.g. via Linux tiling / Windows Snap / macOS Split View).
 *
 * Architecture:
 * - On Linux (X11 / Wayland), the native GTK window-state event bridge
 *   (`listenWindowState` / `getWindowState`) is authoritative. GTK directly
 *   reports `isTiled`, `isMaximized`, and `isFullscreen` flags on state changes.
 *   When `native: true` is established, the hook bypasses geometry heuristics
 *   completely, preventing false positives from floating windows.
 * - On non-native platforms (macOS / Windows) or in environments where the
 *   native event bridge is unavailable, a geometry-based fallback calculates
 *   whether the window is maximized, fullscreen, or snapped to monitor work-area
 *   edges (`isSnappedToWorkArea`).
 * - Window resize and move events are debounced with a single trailing timer.
 * - Concurrent async geometry queries are serialized with a monotonic check id
 *   (`checkIdRef`), dropping any stale in-flight results if a newer check starts,
 *   if native state takes precedence, or if the hook unmounts.
 * - When the window is restored (floating), the desktop app renders with
 *   rounded corners (`rounded-xl`). When maximized, fullscreen, or snapped, the
 *   outer container has square corners (`rounded-none`) to fill display edges cleanly.
 */
export function useWindowMaximized(): boolean {
  const [isSquare, setIsSquare] = useState(false);
  const isNativeRef = useRef(false);
  const hasReceivedEvent = useRef(false);
  const checkIdRef = useRef(0);

  useEffect(() => {
    let unlistenWindowState: (() => void) | undefined;
    let unlistenResized: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const checkGeometry = async () => {
      if (isNativeRef.current || disposed) {
        return;
      }

      const currentId = ++checkIdRef.current;
      const isStale = () =>
        disposed || isNativeRef.current || currentId !== checkIdRef.current;

      try {
        const win = getCurrentWindow();
        const [max, full] = await Promise.all([
          typeof win?.isMaximized === "function" ? win.isMaximized() : false,
          typeof win?.isFullscreen === "function" ? win.isFullscreen() : false,
        ]);

        if (isStale()) return;

        if (max || full) {
          if (!isStale()) setIsSquare(true);
          return;
        }

        // Check if the window is snapped to monitor work-area edges (Windows Snap, etc.)
        let monitor = null;
        try {
          monitor =
            typeof currentMonitor === "function"
              ? await currentMonitor()
              : null;
        } catch {
          monitor = null;
        }

        if (isStale()) return;

        if (monitor?.workArea) {
          try {
            const [pos, size] = await Promise.all([
              typeof win?.outerPosition === "function"
                ? win.outerPosition()
                : null,
              typeof win?.outerSize === "function" ? win.outerSize() : null,
            ]);

            if (isStale()) return;

            if (pos && size) {
              const scale = monitor.scaleFactor || 1;
              if (isSnappedToWorkArea(pos, size, monitor.workArea, scale)) {
                if (!isStale()) setIsSquare(true);
                return;
              }
            }
          } catch {
            // Ignored if position querying fails
          }
        }

        if (isStale()) return;

        // Fallback for DOM environments only if currentMonitor returned null or threw an error
        if (!monitor && typeof window !== "undefined" && window.screen) {
          const availH = window.screen.availHeight;
          const availW = window.screen.availWidth;
          const innerH = window.innerHeight;
          const innerW = window.innerWidth;
          if (
            (availH > 0 && Math.abs(innerH - availH) <= 16) ||
            (availW > 0 && Math.abs(innerW - availW) <= 16)
          ) {
            if (!isStale()) setIsSquare(true);
            return;
          }
        }

        if (!isStale()) {
          setIsSquare(false);
        }
      } catch {
        // Ignored outside Tauri / test environments
      }
    };

    // Setup native window state listener
    listenWindowState((event: WindowFrameState) => {
      if (disposed) return;
      hasReceivedEvent.current = true;
      if (event.native) {
        isNativeRef.current = true;
      }
      if (event.isTiled || event.isMaximized || event.isFullscreen) {
        setIsSquare(true);
      } else if (event.native) {
        setIsSquare(false);
      } else {
        void checkGeometry();
      }
    })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlistenWindowState = fn;
        }
      })
      .catch(() => {});

    // Initial check on mount via getWindowState()
    void getWindowState()
      .then((state: WindowFrameState) => {
        if (disposed) return;
        if (!hasReceivedEvent.current) {
          if (state.native) {
            isNativeRef.current = true;
          }
          if (state.isTiled || state.isMaximized || state.isFullscreen) {
            setIsSquare(true);
          } else if (state.native) {
            setIsSquare(false);
          }
          if (!state.native) {
            void checkGeometry();
          }
        }
      })
      .catch(() => {
        if (!disposed && !isNativeRef.current && !hasReceivedEvent.current) {
          void checkGeometry();
        }
      });

    const handleResizeOrMove = () => {
      if (isNativeRef.current) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (!isNativeRef.current && !disposed) {
          void checkGeometry();
        }
      }, 100);
    };

    window.addEventListener("resize", handleResizeOrMove);

    try {
      const win = getCurrentWindow();
      if (typeof win?.onResized === "function") {
        win
          .onResized(handleResizeOrMove)
          .then((fn) => {
            if (disposed) {
              fn();
            } else {
              unlistenResized = fn;
            }
          })
          .catch(() => {});
      }
      if (typeof win?.onMoved === "function") {
        win
          .onMoved(handleResizeOrMove)
          .then((fn) => {
            if (disposed) {
              fn();
            } else {
              unlistenMoved = fn;
            }
          })
          .catch(() => {});
      }
    } catch {
      // Ignored outside Tauri
    }

    return () => {
      disposed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      window.removeEventListener("resize", handleResizeOrMove);
      if (unlistenWindowState) {
        unlistenWindowState();
      }
      if (unlistenResized) {
        unlistenResized();
      }
      if (unlistenMoved) {
        unlistenMoved();
      }
    };
  }, []);

  return isSquare;
}
