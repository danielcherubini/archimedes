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

/**
 * THE MUTED-CAPTION CLASS PAIR, HELD TO ONE FILE (Finding 19).
 *
 * `./MutedCaption.tsx` owns the pair `text-ui-xs text-foreground-subtlest`;
 * every other caption is supposed to render through it. This is a CLASS-STRING
 * census — it counts who SPELLS a class string, exactly the instrument
 * `./chromeButton.test.ts` runs against the chrome-bar geometry, and it says
 * nothing about user-visible wording (the glossary-copy scanner the review
 * refused is a different instrument and does not live here).
 *
 * The mechanism is ported from that precedent verbatim: the computed-specifier
 * `fs`, the comment-stripping reader (a class pair that appears only inside a
 * doc-comment is prose, not a consumer), the recursive `readdirSync` walk of
 * `src/components` with test files excluded, and the vacuity guard inside the
 * census assertion.
 *
 * ONE DELIBERATE ADAPTATION: the walk is `.sort()`ed. The precedent has a
 * single-carrier baseline, so its `readdirSync` order never mattered; this
 * baseline is multi-file, and `readdirSync` order is OS-dependent, so the
 * `toEqual` below would be flaky across platforms without the sort. The
 * `BASELINE` literal is written in that same sorted order.
 *
 * The test-exclusion is what lets the needle string live in this file (and in
 * the component's own test) without the guard flagging its own scanner.
 */

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
 *  automatically — a hand-written list would silently exempt the next file.
 *  Sorted (see the header): the baseline `toEqual` below is order-sensitive. */
const PRODUCTION_FILES: string[] = (() => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(rel);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)
        ? [rel]
        : [];
    });
  return walk("src/components").sort();
})();

/**
 * The fingerprint is the FULL ADJACENT PAIR, never either token alone.
 * `text-foreground-subtlest` by itself lives on placeholder and disabled styles
 * across `src/components/ui/` and the chat surface, and `text-ui-xs` by itself
 * lives in the badge/kbd variants and the mention-pick grammar — either single
 * token would drown the census in files that are not muted captions.
 */
const FINGERPRINT = "text-ui-xs text-foreground-subtlest";

/**
 * The allowlist. A file named here is a KNOWN, ENUMERATED carrier of the pair;
 * anything else that spells it reddens the census. The list shrinks as each
 * site folds onto `MutedCaption`; the end state is the component alone, which
 * legitimately owns the pair (its doc-comment occurrence is stripped, so it is
 * counted for its code occurrence).
 */
const BASELINE = [
  "src/components/MutedCaption.tsx",
  "src/components/SubagentDelegatingCard.tsx",
  "src/components/chat/ComposerMentions.tsx",
];

const productionSources = (): string[] => PRODUCTION_FILES;

describe("the muted-caption class pair is spelled in exactly one file (Finding 19)", () => {
  it("only MutedCaption.tsx may carry the muted-caption pair", () => {
    // Vacuity guard first (the lesson `themeTokens.test.ts:872` records): an
    // empty file list would make the `filter` below trivially pass.
    expect(productionSources().length).toBeGreaterThan(50);
    const offenders = productionSources().filter((rel) =>
      stripJsComments(read(rel)).includes(FINGERPRINT),
    );
    expect(offenders).toEqual(BASELINE);
  });

  it("treats a doc-comment occurrence as prose, not a consumer", () => {
    // The strip reader's force, exercised against the ONE carrier that actually
    // has a doc-comment copy of the pair. Both counts are pinned: the raw read
    // finds the pair TWICE (doc-comment + code), the stripped read finds it
    // ONCE. A `toContain` on the stripped source would pass even with
    // `stripJsComments` gutted, because the code occurrence survives anything —
    // the two-match/one-match pair is what proves the stripper consumed the
    // prose copy (`skills.test.ts:16-24`'s prose-as-consumer warning).
    const PATH = "src/components/MutedCaption.tsx";
    expect(read(PATH).match(/text-ui-xs text-foreground-subtlest/g)).toHaveLength(2);
    expect(
      stripJsComments(read(PATH)).match(/text-ui-xs text-foreground-subtlest/g),
    ).toHaveLength(1);
  });
});
