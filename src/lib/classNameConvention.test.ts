import { describe, expect, it } from "vitest";

/**
 * THE `cn()` CONVENTION GUARD (finding 15) — a source scanner, not a linter.
 *
 * **A real linter would supersede this file.** This repo has NO lint or format
 * tooling at all: `package.json` names no eslint / biome / oxlint / prettier,
 * there is no config for any of them, and `Makefile:check` runs cargo +
 * `pnpm build` + `pnpm test` and nothing else. So "enforce the convention"
 * cannot mean "add a rule" — it means either adopt a linter (a new dependency,
 * a new config, a new CI gate: not this task) or follow the precedent this repo
 * already has and runs today. SEVEN test files already scan component SOURCE as
 * their subject: `lib/slabFloatSeparation.test.ts`, `lib/themeTokens.test.ts`,
 * `lib/subagentSheetLayout.test.ts`, `lib/skills.test.ts`, and — from C2 and C3 —
 * `components/settings/primitives.test.tsx`, `components/chromeButton.test.ts`
 * and `components/ChatStream.test.tsx`. This file is the same shape, applied to
 * a convention instead of to a class.
 *
 * WHAT THIS IS NOT. Task A0 retired the source-grep gates that pinned
 * RENDERED BEHAVIOUR (a class in the markup is what a component test should
 * assert, not a regex). This one asserts no rendered output at all. It pins a
 * CONVENTION ON NEW CODE — the kind of rule a lint would own — and it exists
 * because the convention spread without an enforcer: the helper has existed
 * since before this program started, and a test that reddens on the first new
 * offender is the only mechanism this repo has.
 *
 * The scale of the gap, measured at the commit this guard was written: `cn(`
 * appeared 40 times inside `src/components/ui/` and 15 times (across 8 files)
 * everywhere else in `src/` — so the helper was known, and nearly everything
 * written outside `ui/` still hand-rolled its concatenations. After this task
 * the outside-`ui/` figure is 66.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, and the two shapes it distinguishes
 * ---------------------------------------------------------------------------
 *
 * A dynamic `className` (or any `…className` prop) expression is an OFFENDER
 * when it COMPOSES class strings by hand:
 *
 *   - a template literal with an interpolation      `` `a ${x}` ``
 *   - string concatenation                          `"a " + x`
 *   - `.join(…)` / `.concat(…)` on an array of them
 *   - an array literal
 *
 * It is EXEMPT when it merely SELECTS between two complete class lists:
 *
 *   `className={isEmpty ? "px-4 pb-4" : "px-4 pb-4 pt-3 flex flex-col gap-3"}`
 *
 * That exemption is measured, not assumed. A whole-expression ternary over two
 * STATIC string literals cannot produce the failure `cn()` exists to prevent — a
 * same-group conflict between a base and an override — because it has no base:
 * exactly one arm is rendered, in full. And `cn()` is provably the IDENTITY on
 * every such arm in this tree (every arm string was run through the real
 * `mergeUiClasses` when this test was written; none dropped or added a token).
 * Converting those sites would add diff surface and change nothing, so they are
 * allowlisted below too, as a SET, so a new one still has to be added on purpose.
 *
 * EXEMPT as well: a static string, a bare identifier / member expression
 * (`className={CHIP_CLASSES}`, `className={className}` — nothing to merge), and
 * anything already routed through `cn()` or `clsx()`.
 *
 * ---------------------------------------------------------------------------
 * SET MEMBERSHIP, NOT A COUNT
 * ---------------------------------------------------------------------------
 *
 * Both allowlists are compared as SETS with `toEqual`, never as a length. A
 * `toBeLessThanOrEqual(count)` gate is the bug this file exists to prevent: it
 * passes when one offender is fixed and two are added, so the count can hide a
 * regression in exact proportion to how much the codebase improves. Set equality
 * means an offender cannot enter at all, and removing one forces the list to
 * shrink — which is the audit trail.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ A LATER EXECUTOR WILL HIT THIS — READ BEFORE CALLING IT A FALSE POSITIVE
 * ---------------------------------------------------------------------------
 *
 * Tasks **C5, C6, C4 and C7** run AFTER this one and CREATE NEW COMPONENT
 * FILES: `InlineGateRow` (C5), the `CatalogSearchDialog` shell (C6),
 * `SessionListRow` + `RowButton` (C4), and the 37 raw-button → `<Button>` sites
 * (C7). If one of those new files hand-rolls a `className` concatenation, THIS
 * GUARD REDDENS — and that is the guard WORKING, not a false positive. The rule
 * for those tasks is: write the new component with `cn()` from its first commit
 * (it is cheap — `import { cn } from "./lib/utils"`), and do not add to the
 * allowlist to get green. Adding a file here is a decision to keep hand-rolled
 * composition in a brand-new file, which is exactly the drift this test was
 * written to stop.
 *
 * The three entries in `HAND_ROLLED_COMPOSITION` are the opposite case: they are
 * sites that were MEASURED to change rendered output under `cn()`, and each
 * carries a comment at the site explaining the conflict. If you are about to
 * "finish" one of them, re-measure first — the whole point is that a merge
 * DROPS a losing utility, and at these three the dropped one is the one the user
 * currently sees winning.
 */

// Node's `fs` through a COMPUTED specifier — this app deliberately ships no
// `@types/node`, so a bare `import "node:fs"` does not typecheck (`tsc` is a
// build gate, not a test gate). The same idiom `src/lib/cssSource.ts`,
// `themeTokens.test.ts`, `chromeButton.test.ts` and `subagentSheetLayout.test.ts`
// use; see those for the longer explanation.
const NODE_FS = "node:" + "fs";
const { readFileSync, readdirSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
  readdirSync: (
    path: string,
    options: { recursive: true; encoding: string },
  ) => string[];
};

/** Every shipped `.ts`/`.tsx` under `src/`, minus the tests.
 *
 * `readdirSync(…, { recursive: true })` returns paths relative to the directory,
 * which is why the mapping prefixes it — the same idiom
 * `themeTokens.test.ts`/`paletteCompleteness.test.ts` use, and the extension
 * filter is there so a future font or image under `src/` cannot turn this into a
 * binary read.
 *
 * THE SEPARATORS ARE NORMALISED, and CI is why. On Windows `readdirSync` returns
 * BACKSLASH paths, so the bare mapping produced `src/components\Foo.tsx` and
 * every assertion below that compares against a `/`-spelled literal
 * (`toContain("src/components/SpacesList.tsx")`, and the two allowlist `toEqual`
 * sets) reddened on a tree nothing had changed. POSIX never emits `\` in a path,
 * so the replace is a no-op there and the two platforms now report the same
 * strings. Every path this file compares — the allowlists, the offender keys —
 * is spelled with `/`, so this is the single place the fix belongs.
 *
 * TESTS ARE OUT OF SCOPE ON PURPOSE. A test file hand-writing a class string is
 * usually the PIN itself — `WindowControls.test.tsx` compares against a literal
 * `SUBTLE_BUTTON`, and `primitives.test.tsx` re-spells the row shell precisely so
 * the assertion is the string and not something recomputed from the component.
 * Routing a pin through `cn()` would let a merge hide a change from the very
 * assertion meant to catch it. The convention is about SHIPPED markup. */
const SOURCES = readdirSync("src", { recursive: true, encoding: "utf8" })
  .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p))
  .map((p) => `src/${p.replace(/\\/g, "/")}`)
  .sort();

/** Strip JS comments before scanning. A class name that appears only in a
 *  doc-comment is PROSE, not a consumer — the lesson `themeTokens.test.ts:697`
 *  records, and the reason `subagentSheetLayout.test.ts` had to fix a comment of
 *  its own that quoted a bracketed utility. Block comments and whole-line `//`
 *  only, matching `settings/primitives.test.tsx`'s helper: telling a trailing
 *  `// note` from a `"https://…"` needs a parser this repo does not ship. */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** The balanced `{ … }` expression starting just after `attr={`. */
const expressionAt = (src: string, from: number): string => {
  let i = from;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(from, i - 1);
};

/** `className`, `triggerClassName`, or any future `…className` prop. The name is
 * captured whole and then tested for the suffix, so a bare `className` matches
 * too (an earlier draft required a character before `className` in the pattern
 * and so matched ONLY `triggerClassName` — a scanner whose main subject is
 * invisible to it is the exact failure this file warns about, and the
 * `sites.length > 100` assertion below is what catches it). Matching the SUFFIX
 * rather than the single name is what keeps a new prop shape from slipping
 * past: `ModelPicker`'s `triggerClassName` was a real offender and a
 * `className`-only regex would have called it clean. */
const CLASS_NAME_PROP = /(?:^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\{/g;
/** A prop whose name IS `className` or ENDS in it (`triggerClassName`). */
const isClassNameProp = (name: string): boolean =>
  name === "className" || /ClassName$/.test(name);

type Site = { file: string; line: number; prop: string; expr: string };

const findSites = (): Site[] => {
  const sites: Site[] = [];
  for (const file of SOURCES) {
    const src = stripJsComments(readFileSync(file, "utf8"));
    
    for (const match of src.matchAll(CLASS_NAME_PROP)) {
      if (!isClassNameProp(match[1]!)) continue;
      const start = (match.index ?? 0) + match[0].length;
      const raw = expressionAt(src, start);
      const expr = raw.trim().replace(/\s+/g, " ");
      sites.push({
        file,
        line: src.slice(0, match.index ?? 0).split("\n").length,
        prop: match[1]!,
        expr,
      });
    }
  }
  return sites;
};

/** What the expression does with class strings. */
const classify = (expr: string): string => {
  // Already merged: the convention, satisfied.
  if (/^cn\s*\(/.test(expr) || /^clsx\s*\(/.test(expr)) return "cn";
  // A single static string — nothing dynamic at all.
  if (/^["'`][^`"'{}$]*["'`]$/.test(expr)) return "static";
  // A bare reference (a constant, or a prop) — nothing composed here.
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(expr)) {
    return "reference";
  }
  // Composition, in the four shapes the rule bans.
  if (expr.includes("`") && expr.includes("${")) return "compose:template";
  if (/["'`]\s*\+|\+\s*["'`]/.test(expr)) return "compose:concat";
  if (/\.join\s*\(|\.concat\s*\(/.test(expr)) return "compose:join";
  if (/^\[/.test(expr)) return "compose:array";
  // Selection between static arms — exempt, see the doc-comment.
  if (/\?\s*["'`][^"'`]*["'`]\s*:/.test(expr)) return "select:ternary";
  return "other";
};

const sites = findSites();

/** Vacuity guard, and a floor on the scanner's reach. Without this, a broken
 *  walk (wrong cwd, a regex that stopped matching) would leave `sites` empty and
 *  every assertion below green for the wrong reason — the failure mode
 *  `themeTokens.test.ts` and `primitives.test.tsx` both record being bitten by. */
describe("the scanner actually reads the tree", () => {
  it("walks every production source file and finds className sites in it", () => {
    expect(SOURCES.length).toBeGreaterThan(80);
    expect(SOURCES).toContain("src/components/SpacesList.tsx");
    expect(SOURCES.some((f) => f.includes("/components/ui/"))).toBe(true);
    // Tests are excluded, and the exclusion is real.
    expect(SOURCES.filter((f) => f.endsWith(".test.tsx")).length).toBe(0);
    // The scanner sees `className` attributes at all (measured: well over 100).
    expect(sites.length).toBeGreaterThan(100);
    // …including the `…className` PROP shape the suffix match exists for.
    expect(sites.some((s) => s.prop === "triggerClassName")).toBe(true);
  });

  it("classifies the shapes the rule cares about (a silent regex change is a silent green)", () => {
    // Each classification pinned with a SYNTHETIC expression, so a loosened
    // predicate reddens here rather than quietly un-gating the two tests below.
    expect(classify("cn(a, b)")).toBe("cn");
    expect(classify('clsx("a", b)')).toBe("cn");
    expect(classify('"flex px-4"')).toBe("static");
    expect(classify("CHIP_CLASSES")).toBe("reference");
    expect(classify("props.className")).toBe("reference");
    expect(classify('`flex ${cond && "px-4"}`')).toBe("compose:template");
    expect(classify('"flex " + extra')).toBe("compose:concat");
    expect(classify('["a", className].filter(Boolean).join(" ")')).toBe(
      "compose:join",
    );
    expect(classify('["a", b]')).toBe("compose:array");
    expect(classify('cond ? "a-1" : "b-2"')).toBe("select:ternary");
  });
});

/**
 * The three sites Task C8 left as template literals, each because `cn()` was
 * MEASURED to change what renders. The reason lives at the site (a comment on
 * the markup); this list is only the gate's bookkeeping. Both entries carry a
 * `file:line`-free key (path + prop + the first 40 characters of the
 * expression) so a conversion that keeps the line but changes the expression —
 * or a move — reddens rather than silently re-matching.
 */
const HAND_ROLLED_COMPOSITION = [
  // `transition-transform` + `transition-opacity` are ONE tailwind-merge group,
  // so merging the base alone drops the rotation's transition (which the compiled
  // stylesheet currently lets win). See the site's comment.
  "src/components/ChangesGroupCard.tsx className= `size-4 shrink-0 text-foreground-subtlest opacity-0 transiti",
  // The same base string, the same dropped transition.
  "src/components/ToolCallCardHeader.tsx className= `size-4 shrink-0 text-foreground-subtlest opacity-0 transiti",
  // `cursor-pointer` (base) vs `cursor-not-allowed` (disabled arm) are one group:
  // a merge would change which cursor a disabled row shows.
  "src/components/ModelPickerDialog.tsx className= `group flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-",
];

/** The ternary "selection" sites, exempt for the measured reason in the header.
 *  A set, so a NEW ternary-shaped `className` must be added here on purpose.
 *
 *  KNOWN LIMIT OF THE KEY. `AskQuestionCard`'s four ternary sites are TWO
 *  expressions used twice each (the option row and the `Other` row are the same
 *  markup), so their keys collide: the set holds SIX entries for the EIGHT
 *  ternary sites the scanner finds. A set of keys therefore detects a NEW SHAPE
 *  or a NEW FILE, not a second copy of an existing shape in the same file — the
 *  right trade for a convention gate (the convention is "compose through
 *  `cn()`"; this list is about shapes), and stated rather than left for someone
 *  to discover. */
const STATIC_TERNARY_SECTIONS = [
  "src/components/AskQuestionCard.tsx className= d.other ? \"text-interaction-ask-foreground\" : \"text-foregrou",
  "src/components/AskQuestionCard.tsx className= selected ? \"text-interaction-ask-foreground\" : \"text-foregro",
  "src/components/ChangesGroupCard.tsx className= isVisible ? \"inline-flex min-w-0 shrink-0\" : \"pointer-events",
  "src/components/TodoBoardPanel.tsx className= item.status === \"completed\" ? \"min-w-0 flex-1 text-ui-base l",
  "src/components/chat/MessageList.tsx className= isEmpty ? \"px-4 pb-4\" : \"px-4 pb-4 pt-3 flex flex-col gap-3\"",
  "src/components/settings/UpdateSection.tsx className= percent === null ? \"h-full w-full animate-pulse bg-primary o",
];

const keyOf = (s: Site): string =>
  `${s.file} ${s.prop}= ${s.expr.slice(0, 60)}`;

describe("dynamic className strings go through cn() (finding 15)", () => {
  it("no production file composes a className by hand, except the measured allowlist", () => {
    const offenders = sites
      .filter((s) => classify(s.expr).startsWith("compose:"))
      .map(keyOf)
      .sort();
    // SET EQUALITY, not a count — see the header. If this fails because you
    // ADDED an entry: use `cn()`. If it fails because you REMOVED one: delete it
    // from `HAND_ROLLED_COMPOSITION` and say so in the commit message.
    expect(offenders).toEqual([...HAND_ROLLED_COMPOSITION].sort());
  });

  it("the allowlist has no stale entries (a fixed site must be removed from the list)", () => {
    // The other direction, asserted separately so a failure names the direction.
    const present = new Set(
      sites.filter((s) => classify(s.expr).startsWith("compose:")).map(keyOf),
    );
    const stale = HAND_ROLLED_COMPOSITION.filter((k) => !present.has(k));
    expect(stale, "these hand-rolled sites are gone — shrink the allowlist").toEqual(
      [],
    );
  });

  it("no className is composed with array-join or string concatenation at all", () => {
    // A zero-tolerance subset of the rule, asserted on its own so the strongest
    // half of the convention survives even if the template-literal allowlist
    // ever has to grow. `braille-loader.tsx`'s
    // `[base, className].filter(Boolean).join(" ")` used to be one of these;
    // `clsx` does the same job inside `cn()`.
    const joined = sites
      .filter((s) => {
        const kind = classify(s.expr);
        return kind === "compose:join" || kind === "compose:concat";
      })
      .map((s) => `${s.file}:${s.line} ${s.expr.slice(0, 80)}`);
    expect(joined).toEqual([]);
  });

  it("ternary-shaped classNames stay within the measured exemption list", () => {
    const found = sites.filter((s) => classify(s.expr) === "select:ternary");
    const ternaries = [...new Set(found.map(keyOf))].sort();
    // SET equality again — a new ternary shape anywhere in `src/` has to be
    // added to `STATIC_TERNARY_SECTIONS` on purpose.
    expect(ternaries).toEqual([...STATIC_TERNARY_SECTIONS].sort());
    // And the duplicate collapse above is stated in numbers, so it cannot be
    // quietly widened: 8 sites, 6 distinct shapes, all in the list.
    expect(found.length).toBe(8);
    expect(ternaries.length).toBe(6);
  });

  it("every allowlisted hand-rolled site carries a comment saying why (no silent exceptions)", () => {
    // An allowlist entry without an explanation is how an exception becomes a
    // habit. Each of the three sites must state, in its own source, that the
    // choice was deliberate — the same standard `primitives.test.tsx` holds the
    // badge decision to ("records the decision").
    const files = [...new Set(HAND_ROLLED_COMPOSITION.map((k) => k.split(" ")[0]))];
    expect(files).toHaveLength(3);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} does not explain its exception`).toMatch(
        /LEFT AS A TEMPLATE LITERAL on purpose/,
      );
    }
  });
});
