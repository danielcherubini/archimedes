/**
 * Node's `fs`, reached through a COMPUTED specifier: this app deliberately ships
 * no `@types/node` (its globals stay DOM-only), so a bare `node:fs` import does
 * not typecheck. The idiom `src/lib/cssSource.ts` and
 * `src/lib/themeTokens.test.ts:665-675` document and use.
 */
const NODE_FS = "node:" + "fs";
const { readFileSync, readdirSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
  readdirSync: (
    path: string,
    options: { withFileTypes: true },
  ) => { name: string; isDirectory(): boolean }[];
};

import { describe, expect, it } from "vitest";

import { CHROME_BUTTON, CHROME_BUTTON_CLOSE } from "./chromeButton";

/**
 * THE CHROME-BAR BUTTON GRAMMAR, AS A CONSTANT (Finding 6a).
 *
 * This is a CLASS CONSTANT, not a component, and that is the whole design
 * decision (see `./chromeButton.ts`): per CONTEXT.md **Chrome controls** and
 * ADR 0038 the two chrome clusters differ ON PURPOSE, so a shared
 * `<ChromeButton>` would average away a distinction the glossary blesses. The
 * duplication Finding 6a is about is the STRING, and the string is what is
 * shared here.
 *
 * Three kinds of assertion, and each carries a different risk:
 *
 *  1. the exact rendered class string of each constant (a characterisation pin
 *     — the extraction must not repaint a single pixel of the six buttons);
 *  2. the SHAPE of the pair (same geometry, only the hover pair differs), which
 *     is the invariant that makes two constants right and a boolean prop wrong;
 *  3. a SOURCE gate that the chrome-bar geometry is spelled in exactly one
 *     production file, which is Finding 6a's acceptance criterion, plus its
 *     negative half: `SpaceTabs.tsx` must NOT import this module.
 *
 * The source gate follows the precedent this repo already has for a CONVENTION
 * scanner (`src/lib/themeTokens.test.ts`'s comment-stripped reads, and the
 * `src/lib/skills.test.ts:16-24` warning about prose-as-consumer): it pins a
 * convention on NEW code and asserts no rendered output, so it is not the
 * behaviour-pinning shape A0 retired.
 */

/** The exact class string `ChromeControls.tsx`'s local `BTN` carried before
 *  this extraction (its `relative` is the caller's, see the `CHROME_BUTTON`
 *  doc-comment) and `WindowControls.tsx`'s Minimize/Maximize buttons carried
 *  verbatim — minus `relative`, which neither had. */
const MINIMIZE_MAXIMIZE_BEFORE =
  "flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground";
/** `WindowControls.tsx`'s Close button, verbatim. */
const CLOSE_BEFORE =
  "flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-destructive/20 hover:text-destructive";

/** The comment-stripping reader `themeTokens.test.ts:697` documents: block
 *  comments and whole-line `//` comments only. A class name that appears only
 *  in a doc-comment is prose, not a consumer, and this gate counts consumers. */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

const read = (relPath: string): string => readFileSync(relPath, "utf8");

/** Enumerated through `readdirSync` so a new component file is picked up
 *  automatically — a hand-written list would silently exempt the next file. */
const PRODUCTION_FILES: string[] = (() => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(rel);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)
        ? [rel]
        : [];
    });
  return walk("src/components");
})();

/** The geometry half the two constants share, spelled out so the "only the
 *  hover pair differs" claim below is a comparison and not a restatement. */
const GEOMETRY =
  "flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle transition-colors";

describe("CHROME_BUTTON — the chrome bar's shared button grammar", () => {
  it("is byte-identical to the string WindowControls' Minimize/Maximize carried", () => {
    // Byte-identical, not "same utility set": the extraction is a refactor, so
    // the attribute string a devtools inspection showed before must be what it
    // shows after. `cn()`/tailwind-merge reorders on CONFLICT, and nothing here
    // conflicts, so any reordering would be a bug in how the constant is built.
    expect(CHROME_BUTTON).toBe(MINIMIZE_MAXIMIZE_BEFORE);
  });

  it("is byte-identical to the Close button's string except for the hover pair", () => {
    expect(CHROME_BUTTON_CLOSE).toBe(CLOSE_BEFORE);
  });

  it("the pair differs ONLY in the hover pair — identical geometry", () => {
    // The reason this is two constants and not a `destructive` boolean on one:
    // the geometry is the shared fact and the hover pair is the per-control
    // fact. If either constant drifts a utility in the geometry, this fails.
    expect(CHROME_BUTTON.slice(0, GEOMETRY.length)).toBe(GEOMETRY);
    expect(CHROME_BUTTON_CLOSE.slice(0, GEOMETRY.length)).toBe(GEOMETRY);
    expect(CHROME_BUTTON.slice(GEOMETRY.length).trim()).toBe(
      "hover:bg-hover hover:text-foreground",
    );
    expect(CHROME_BUTTON_CLOSE.slice(GEOMETRY.length).trim()).toBe(
      "hover:bg-destructive/20 hover:text-destructive",
    );
    // And the destructive arm really SWAPS the hover pair (it does not add to
    // it): a Close that also filled `bg-hover` would flash grey before red.
    expect(CHROME_BUTTON_CLOSE).not.toContain("hover:bg-hover");
    expect(CHROME_BUTTON_CLOSE).not.toContain("hover:text-foreground");
    expect(CHROME_BUTTON).not.toContain("hover:bg-destructive");
    expect(CHROME_BUTTON).not.toContain("hover:text-destructive");
  });

  it("carries NO `relative` — the positioning anchor stays with the caller that owns an absolutely-positioned child", () => {
    // `ChromeControls`' pending dot is `absolute`, so that component adds
    // `relative` itself; `WindowControls`' three buttons never had it and must
    // not gain `position: relative` from a shared constant. This is the one
    // difference between the pre-extraction `BTN` and this constant.
    expect(CHROME_BUTTON.split(/\s+/)).not.toContain("relative");
    expect(CHROME_BUTTON_CLOSE.split(/\s+/)).not.toContain("relative");
  });

  it("is a bare class string, so C7 can pass it as `className` on <Button variant=\"ghost\">", () => {
    // Task C7 replaces these same six buttons with
    // `<Button variant="ghost" className={CHROME_BUTTON}>`. That only works if
    // the constant is a `className` VALUE and not markup or a component — and
    // `cn()` keeps it mergeable, so the Button base's own utilities are the
    // ones a conflict resolves against.
    expect(typeof CHROME_BUTTON).toBe("string");
    expect(typeof CHROME_BUTTON_CLOSE).toBe("string");
    // No JSX, no HTML, no newline — a `className` attribute value.
    expect(CHROME_BUTTON).not.toMatch(/[<>\n]/);
    expect(CHROME_BUTTON_CLOSE).not.toMatch(/[<>\n]/);
  });
});

describe("the chrome-bar class string is spelled exactly once (Finding 6a's acceptance)", () => {
  /** The geometry fingerprint — `h-7 w-7` plus the centring pair. Unique to
   *  this grammar in the component tree (measured: the only other `h-7 w-7`
   *  pair in `src/` is `buttonVariants`' `size: "icon"`/`icon-md`, which is
   *  `size-7`, not `h-7 w-7`). */
  const FINGERPRINT = "h-7 w-7 items-center justify-center";

  /** Every production `.tsx`/`.ts` under `src/components/`, tests excluded. */
  const productionSources = (): string[] => PRODUCTION_FILES;

  it("only chromeButton.ts carries the chrome-bar geometry", () => {
    // Vacuity guard first (the lesson `themeTokens.test.ts:872` records): an
    // empty file list would make the `filter` below trivially pass.
    expect(productionSources().length).toBeGreaterThan(50);
    const offenders = productionSources().filter((rel) =>
      stripJsComments(read(rel)).includes(FINGERPRINT),
    );
    expect(offenders).toEqual(["src/components/chromeButton.ts"]);
  });

  it("SpaceTabs.tsx does NOT import the chrome-button constant (the second cluster stays separate on purpose)", () => {
    // CONTEXT.md **Chrome controls** + ADR 0038: the tab strip's ✕ and `+` are a
    // DIFFERENT cluster — `size-5`/`size-8`, `bg-surface-hover` not `bg-hover`,
    // `rounded` not `rounded-md`, and NO `transition-colors` (SpaceTabs' own
    // comment records the hover fill is always-on). A later "dedupe the chrome
    // buttons" sweep that pulls them onto this constant is exactly what this
    // guard reddens. It is a guard against a future wrong move, so it is green
    // today by design — the mutation that proves it has force is adding the
    // import.
    const source = stripJsComments(read("src/components/SpaceTabs.tsx"));
    expect(source).not.toMatch(/from\s+["']\.\/chromeButton["']/);
    expect(source).not.toContain("CHROME_BUTTON");
  });
});
