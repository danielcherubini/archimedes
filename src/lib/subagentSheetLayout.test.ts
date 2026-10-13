import { describe, expect, it } from "vitest";
import {
  GATE_PANEL_DODGE_BREAKPOINT,
  GATE_PANEL_DODGE_MAX_WIDTH_CLASS,
  GATE_PANEL_DODGE_OFFSET_CLASS,
  SHEET_WIDTH_CLASS,
  SUBAGENT_SHEET_WIDTH,
} from "./subagentSheetLayout";

/**
 * The geometry the child-gate overlay shares with the Subagent transcript SHEET
 * has ONE home. `SubagentModals.test.tsx` already compares the RENDERED class
 * lists of the two components against these constants — the version a reader can
 * check against a browser — and this file pins the other half: that there is now
 * exactly ONE place the sheet's 480 is written as a class at all.
 *
 * Two failure modes this guards, in the order they were found:
 *
 *  1. THE PAIR DRIFTING. The sheet's width and the panel's dodge offset are one
 *     measurement — the panel sits flush against the sheet's left edge, or it is
 *     either under the sheet (an invisible gate) or floating over the transcript.
 *     When the two literals lived in two component files, only a test tied them.
 *     Now both components interpolate a constant out of this module, whose
 *     literal is ITSELF type-checked against the numeric constant it names, so
 *     widening the sheet without moving the class is a `tsc` error rather than a
 *     red test on someone else's branch.
 *  2. PROSE COMPILING TO CSS. Tailwind v4's source detection scans comments in
 *     `.ts`/`.tsx` as happily as it scans code, so a bracketed class quoted in a
 *     sentence becomes a real rule in the bundle. Two such quotations here — a
 *     bare 480px right-offset, and a width utility whose "value" was the letter N
 *     in a doc line — shipped as rules nothing ever matched. Prose in these files
 *     now describes the utilities in words and leaves the bracketed form to the
 *     expressions that apply them, which is what the last test below can see —
 *     in line comments, in block comments, and in the brace-wrapped JSX comment
 *     shape as well. That third shape is why the test mines the whole file for
 *     brace-wrapped JSX-comment spans instead of walking lines: such a comment
 *     opens and closes INSIDE a line of markup, where a prefix test never
 *     reaches, and a MULTI-LINE one leaves every line it covers looking like
 *     plain prose — so a token on such a continuation line was invisible to the
 *     line walk that preceded it, and to a per-line span regex too.
 */

// Node's fs through a COMPUTED specifier — this app ships no `@types/node`, so a
// bare `node:fs` would not typecheck (the same idiom `src/lib/cssSource.ts` uses).
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

/**
 * The files that own this geometry: the module, its two consumers, the test that
 * pins their class lists, and THIS file — because the prose rule below is worth
 * nothing if the file that states it is allowed to break it.
 */
const SOURCES = [
  "src/lib/subagentSheetLayout.ts",
  "src/components/SubagentDetailHost.tsx",
  "src/components/SubagentModals.tsx",
  "src/components/SubagentModals.test.tsx",
  "src/lib/subagentSheetLayout.test.ts",
];

/**
 * The prose files that discuss this geometry. Tailwind's automatic source
 * detection scans `.md` too — `src/index.css` excludes one doc from it for
 * exactly that reason — so a sentence here can ship a rule the app never uses.
 * The bare offset / cap quoted in prose did; they are now written as arithmetic
 * in words, and the test below keeps them that way.
 *
 * A roadmap doc is DELETED ON SHIP, so removing its entry here belongs in that
 * same shipping commit — and the read below deliberately has no tolerance for a
 * missing file, because silently skipping one would let a doc escape the scan.
 */
const PROSE = [
  "docs/features/subagent-sessions.md",
];

describe("the Subagent sheet geometry has one home", () => {
  it("the literals this module exports ARE the numbers it computes", () => {
    // The runtime mirror of the type-level tie: if the two ever disagree, this
    // says which pair moved apart, in the numbers involved.
    expect(SHEET_WIDTH_CLASS).toBe(`w-[${SUBAGENT_SHEET_WIDTH}px]`);
    expect(GATE_PANEL_DODGE_OFFSET_CLASS).toBe(
      `min-[${GATE_PANEL_DODGE_BREAKPOINT}px]:right-[${SUBAGENT_SHEET_WIDTH}px]`,
    );
    expect(GATE_PANEL_DODGE_MAX_WIDTH_CLASS).toBe(
      `min-[${GATE_PANEL_DODGE_BREAKPOINT}px]:max-w-[calc(100vw-${SUBAGENT_SHEET_WIDTH}px)]`,
    );
  });

  it("only the layout module carries a bracketed geometry class; both consumers interpolate", () => {
    // The whole point of moving the literals: a component that re-types its own
    // width is a second source of truth again, and it fails quietly — the sheet
    // and the panel simply stop matching. So the components may not contain a
    // bracketed width/offset class at all, in code or in a comment, and each must
    // name the constant it interpolates instead.
    const layout = readFileSync(SOURCES[0], "utf8");
    expect(layout).toContain(SHEET_WIDTH_CLASS);
    expect(layout).toContain(GATE_PANEL_DODGE_OFFSET_CLASS);
    expect(layout).toContain(GATE_PANEL_DODGE_MAX_WIDTH_CLASS);

    const sheet = readFileSync(SOURCES[1], "utf8");
    expect(sheet).toContain("SHEET_WIDTH_CLASS");
    expect(sheet).not.toMatch(/w-\[\d+px\]/);
    expect(sheet).not.toMatch(/right-\[\d+px\]/);

    const panel = readFileSync(SOURCES[2], "utf8");
    expect(panel).toContain("SHEET_WIDTH_CLASS");
    // The pair travels together: an offset with no width cap hangs the panel off
    // the viewport's left edge on the default 800px window.
    expect(panel).toContain("GATE_PANEL_DODGE_OFFSET_CLASS");
    expect(panel).toContain("GATE_PANEL_DODGE_MAX_WIDTH_CLASS");
    expect(panel).not.toMatch(/w-\[\d+px\]/);
    expect(panel).not.toMatch(/right-\[\d+px\]/);
  });

  it("no comment in these files quotes a bracketed arbitrary-value utility (Tailwind scans comments)", () => {
    // What counts as a comment here, in the shapes the source files actually
    // use: a `//` line, a `/* … */` block (whose continuation lines start with
    // `*`), and a JSX comment — `{/* … */}`. The first two are LINE shapes, so a
    // line walk sees them. The JSX shape needs a whole-file pass, because it is
    // NOT a line shape: it can open after markup on a line of JSX (where no
    // prefix matches) and run across lines whose only distinguishing feature is
    // that they are prose. A line walk therefore misses both its opening line and
    // every continuation line, which is how a bracketed class survived in one of
    // these comments while this test still passed. So every `{/* … */}` span in
    // the file is mined out of the raw text and scanned on its own; the line pass
    // stays for the `{/* … */}`s that sit inside a `*`-continuation or a `//`.
    const JSX_COMMENT = /\{\s*\/\*[\s\S]*?\*\/\s*\}/g;
    // `<utility>-[<value><unit>]` — a real candidate Tailwind would compile.
    // An interpolated one (`…-[${X}px]`) is NOT matched: the scanner cannot
    // resolve it either, which is exactly why the literals live in the module.
    const UTILITY = /[a-z-]+-\[[0-9A-Za-z]+(px|vw|rem)\]/;
    const offenders: string[] = [];
    const seen = new Set<string>();
    const report = (file: string, line: number, snippet: string) => {
      const key = `${file}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      offenders.push(`${key}: ${snippet.trim().slice(0, 100)}`);
    };
    for (const file of SOURCES) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        const trimmed = line.trim();
        const isComment =
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*") ||
          trimmed.startsWith("{/*");
        if (isComment && UTILITY.test(line)) report(file, i + 1, line);
      });
      for (const span of text.matchAll(JSX_COMMENT)) {
        const hit = span[0].match(UTILITY);
        if (!hit) continue;
        // Report the line the offending token sits on, not where the span opens.
        const openLine = text.slice(0, span.index).split("\n").length;
        const within = span[0].slice(0, hit.index).split("\n").length - 1;
        const hitLine =
          span[0].split("\n").find((l) => UTILITY.test(l)) ?? span[0];
        report(file, openLine + within, hitLine);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("nothing outside the layout module names the dodge's offset or cap WITHOUT its breakpoint variant", () => {
    // The variant prefix is the whole safety of the dodge: applied unconditionally
    // it is a zero-width box off-viewport below the breakpoint (see
    // `GATE_PANEL_DODGE_BREAKPOINT`). It also decides whether a written-out class
    // compiles to a rule that is USED: the variant-prefixed pair is in the
    // compiled set, the bare pair is dead weight that rides along in the bundle.
    // So every mention of the offset or the cap — code or prose, `.tsx` or `.md`
    // — must carry the variant prefix, and the module's own literal is the only
    // place the bare number is spelled as a class at all.
    const offenders: string[] = [];
    for (const file of [...SOURCES, ...PROSE]) {
      const text = readFileSync(file, "utf8");
      if (file === SOURCES[0]) continue;
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        // Every dodge-offset (`right-` with a literal pixel value) or dodge-cap
        // (`max-w-` over a `calc(100vw-<literal>…)`) in the line must be preceded
        // by a `…]:` variant prefix. An INTERPOLATED value (`…-[${X}px]`) is not
        // matched and not wanted here: the scanner cannot resolve it either, which
        // is why the literals live in the layout module at all. Other arbitrary
        // values — the corner geometry's own 90%-of-viewport cap — are not the
        // dodge and are not in question.
        const bare = line.replace(/[A-Za-z0-9.-]+\]:(right|max-w)-\[[^\]]*\]/g, "");
        if (/\bright-\[\d/.test(bare) || /\bmax-w-\[calc\(100vw-\d/.test(bare)) {
          offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
