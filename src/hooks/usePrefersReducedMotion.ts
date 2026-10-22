import { useEffect, useState } from "react";

/**
 * Does the user want less motion? `true` only when the OS says so.
 *
 * Moved verbatim out of `QueuedSummaryContent.tsx`, which was its only other
 * copy. Two details there are load bearing and were not invented there:
 *
 *  - The `typeof window` / `typeof window.matchMedia` guard. jsdom implements
 *    neither half of `matchMedia`, and without this the guard every component
 *    that reads the preference would throw under test — and every consumer here
 *    is a component with a test file.
 *  - The `addListener`/`removeListener` fallback. A `MediaQueryList` without
 *    `addEventListener` is not hypothetical on WebKitGTK, and the modern-only
 *    version would throw exactly where the app is most fragile.
 *
 * The answer is seeded `false` and learned in an effect, so the FIRST render of
 * a consumer always animates-ready. That is correct for the film (its effect
 * re-runs and the mode is re-resolved) and for the summary roll. It is NOT
 * correct for `src/components/ui/braille-loader.tsx`, which must know the answer
 * on its very first render and therefore keeps its own copy as a synchronous
 * `useState(getPrefersReducedMotion)` initialiser. That duplication is
 * deliberate — do not "unify" it.
 *
 * Note this hook only REDUCES: callers get one bit and must treat `true` as
 * "do less", never as a licence to do more (ADR 0070).
 */
export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(query.matches);
    };
    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => {
        query.removeEventListener("change", update);
      };
    }

    query.addListener(update);
    return () => {
      query.removeListener(update);
    };
  }, []);

  return prefersReducedMotion;
}
