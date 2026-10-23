/**
 * The two commands that read BYTES THE WEBVIEW CANNOT REACH itself: the system
 * clipboard (a pasted image) and a dialog-selected file (a PATH, not a `File`).
 * They share no domain with the session or settings commands, only a capability.
 */

import { invoke } from "@tauri-apps/api/core";


/**
 * The current system-clipboard image (if any) as PNG bytes.
 *
 * WebKitGTK's `paste` event does not expose clipboard images as
 * `DataTransfer` file items (`items`/`files` are empty for a pasted image —
 * verified on webkit2gtk-4.1 2.52.5 on Wayland), so the composer reads the
 * image from the system clipboard directly (Rust/arboard) as a fallback.
 * `null` when the clipboard has no image (text-only or empty).
 */
export async function readClipboardImage(): Promise<number[] | null> {
  return invoke<number[] | null>("read_clipboard_image");
}


/**
 * A picked file's bytes (the `+` file picker's read — the webview cannot
 * read an arbitrary local path itself; a dialog selection is a PATH, not
 * a `File`). `null` when the file is not a supported image (the picker's
 * allowlist — the frontend skips it silently); a rejected Promise when
 * the file cannot be read (e.g. over the 10 MiB cap — the composer shows
 * it on its error line).
 */
export async function readFileBytes(path: string): Promise<number[] | null> {
  return invoke<number[] | null>("read_file_bytes", { path });
}
