import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * Auto-grows the composer textarea to its content.
 *
 * Moved verbatim out of `ChatStream` by Phase D's Task D4. The two arguments are
 * exactly what the effect used to close over — the textarea's ref and the draft
 * it sizes for — so the hook OWNS neither: `ChatStream` keeps owning `draft`
 * (it is written from eleven sites) and keeps owning `composerRef` (the
 * composer's imperative caret work needs it). `draft` is a DEP here, nothing
 * more: the effect re-applies on every keystroke.
 *
 * The arithmetic is the reason this hook exists as a unit rather than staying a
 * comment block: resetting to `auto` and then writing `scrollHeight` alone is
 * WRONG, because `scrollHeight` is the CONTENT height while `style.height` is
 * the BORDER box. `offsetHeight - clientHeight` is the border thickness; without
 * it a ~2px deficit leaves a scrollbar flicker near the composer's `max-h-32`
 * clamp. Re-applied on window resize, because a stale height would otherwise
 * linger until the next keystroke.
 */
export function useAutoGrowComposer(
  composerRef: RefObject<HTMLTextAreaElement | null>,
  draft: string,
): void {
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const apply = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
    // `composerRef` is deliberately NOT a dep: a `useRef` object's IDENTITY is
    // stable for the component's lifetime, and the effect must re-read
    // `.current` only when the DRAFT moves (or on a resize).
  }, [draft]);
}
