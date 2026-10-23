import { useEffect } from "react";

/**
 * The window-level file-drop backstop: a file dropped ANYWHERE in the webview
 * must be swallowed, because the webview's DEFAULT for a file drop is to
 * NAVIGATE to the file — replacing the app.
 *
 * Moved verbatim out of `ChatStream` by Phase D's Task D4. Zero coupling was
 * measured before the move and it is the reason this hook is a leaf: the effect
 * reads no state, no props and no ref, and its dep array is empty. Nothing in
 * the component observes it, so nothing in the component can drift from it.
 *
 * Why it lives at window scope at all (unchanged by the move): with
 * `dragDropEnabled: false` (tauri.conf.json) the webview receives native file
 * drops. `preventDefault` on every `dragover` makes the whole page a valid drop
 * target, and this backstop stops the navigation — the composer's own `onDrop`
 * fires FIRST during bubbling, so the files it lands on still get staged. It
 * also means NO composer-level `onDragOver` is needed: the window listener
 * covers the composer's dragovers too.
 */
export function useWindowDropBackstop(): void {
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);
}
