/**
 * Window state (Linux tiling / snap detection): the PULL form. The push is
 * `listenWindowState` in `../events.ts`, the shape is `WindowFrameState` in
 * `../types.ts`.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  WindowFrameState,
} from "../types";


export async function getWindowState(): Promise<WindowFrameState> {
  return invoke<WindowFrameState>("get_window_state");
}
