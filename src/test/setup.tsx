import { beforeAll, vi } from "vitest";

vi.mock("react-virtuoso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-virtuoso")>();
  function VirtuosoMockWrapper(props: any) {
    // Strip initialTopMostItemIndex before passing props to real Virtuoso
    // (in jsdom with VirtuosoMockContext, initialTopMostItemIndex causes 0 rows to render synchronously)
    const { initialTopMostItemIndex: _ignored, ...rest } = props;
    return (
      <actual.VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 40 }}>
        <actual.Virtuoso {...rest} />
      </actual.VirtuosoMockContext.Provider>
    );
  }
  return {
    ...actual,
    Virtuoso: VirtuosoMockWrapper,
  };
});

if (!Element.prototype.scrollBy) {
  Element.prototype.scrollBy = () => {};
}
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

/**
 * THE SHARED ENVIRONMENT STUBS.
 *
 * jsdom implements none of these, and every component test was re-declaring
 * them: 22 files stubbed `matchMedia`, 14 stubbed `scrollIntoView`, 8 installed
 * the pointer-capture trio. The copy-paste was never cosmetic — a file that
 * forgot one got a `hasPointerCapture is not a function` throw from inside
 * Radix and "fixed" it by copying the block from a sibling, which is why the
 * blocks drifted (three different `matchMedia` stub shapes across the suite).
 * They live here once, so a NEW component test needs no environment block at
 * all — the whole point of the seam in `src/test/fixtures/`.
 *
 * THE PER-FILE STUBS STAY. This change is additive on purpose: the files that
 * already install their own stub keep doing so, and theirs wins (a `beforeAll`
 * runs after the setup file, and `vi.spyOn` / `Object.defineProperty` overwrite
 * what is there). Deleting them is a separate, per-file change with its own test
 * run, because four files call `vi.unstubAllGlobals()`
 * (`components/chat/EmptyStateFilm.test.tsx`, `lib/theme.test.ts`,
 * `lib/archimedes-film/compositor.test.ts`, `lib/settings.test.ts`) and that
 * call strips ANYTHING stubbed through `vi.stubGlobal` — including these — from
 * the rest of the file. Measured, not assumed: a setup-file `vi.stubGlobal` is
 * gone after the first `unstubAllGlobals()` and does not come back. Those four
 * files are exactly the ones whose assertions depend on `matchMedia` being
 * EITHER present-or-absent on their own terms, so they must keep controlling it
 * locally. See the guard list below.
 *
 * WHAT THE STUB ANSWERS, and why it is the neutral value:
 *  - `matches: false` for every query. `prefers-reduced-motion: false` is what
 *    the absent-`matchMedia` fallback already produced (`usePrefersReducedMotion`
 *    answers `false` when the API is missing), so no test's animation branch
 *    changes. `prefers-color-scheme: dark: false` is the one value that DOES
 *    differ from absence (`theme.ts`'s `osPrefersDark` defaults to dark when
 *    `matchMedia` is missing) — and it is unreachable from a component test,
 *    because only `lib/theme.ts` / `lib/settings.ts` resolve `"system"`, both
 *    of which `vi.unstubAllGlobals()` in their own `beforeEach` and so never see
 *    this stub. No component test uses `theme: "system"`.
 *  - `hasPointerCapture → false`: Radix's dismissal logic then treats every
 *    pointer as new, which is the same answer jsdom gave by throwing… except it
 *    no longer throws. This is the value every one of the 8 existing stubs used.
 */
beforeAll(() => {
  // `matchMedia` via `vi.stubGlobal` (the mechanism the per-file stubs use, so a
  // local `vi.spyOn(window, "matchMedia")` finds a function to wrap).
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );

  // The scroll + pointer-capture APIs are plain prototype assignments, NOT
  // `vi.stubGlobal` — they are not globals, and per-file code asserts on these
  // exact functions (`AskQuestionCard.test.tsx` reads
  // `Element.prototype.scrollIntoView`'s mock contexts), so they must stay
  // ordinary writable properties a file can overwrite and restore.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

/**
 * The files that must be checked by hand before their local stub is deleted
 * (the deletion is NOT part of this change — this list is why):
 *
 *  - `hooks/usePrefersReducedMotion.test.ts:135-138` — DELETES
 *    `window.matchMedia` and asserts `typeof !== "function"`. It still passes
 *    (a `delete` after a `stubGlobal` really removes the property), but it is
 *    the file that most directly pins "jsdom has no `matchMedia`", a statement
 *    about the environment this file has now changed.
 *  - `components/ui/braille-loader.test.tsx:33`,
 *    `components/chat/QueueRow.test.tsx:25`,
 *    `components/chat/QueueRows.test.tsx:24`,
 *    `components/chat/EmptyStateFilm.test.tsx:297` — all guard
 *    `if (typeof window.matchMedia !== "function")` before installing their
 *    own, so the global stub skips that branch and their `vi.spyOn` wraps the
 *    SHARED stub instead of the jsdom absence.
 *  - `components/AskQuestionCard.test.tsx:48-50` — captures
 *    `Element.prototype.scrollIntoView` at module scope and restores it in
 *    `afterEach` (deleting it when it was `undefined`). With the global stub in
 *    place the capture finds a function, so the delete branch is dead code
 *    there; harmless, but it is a branch that no longer proves what it says.
 *  - `lib/theme.test.ts`, `lib/settings.test.ts`,
 *    `lib/archimedes-film/compositor.test.ts` — `vi.unstubAllGlobals()`, which
 *    strips the global `matchMedia` stub for the remainder of the file. They
 *    are green because each installs what it needs itself, which is exactly the
 *    reason their local stubs stay.
 */
