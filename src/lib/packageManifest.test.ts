import { describe, expect, it } from "vitest";

/**
 * `package.json` is read here as RAW TEXT, not with `JSON.parse`.
 *
 * The reason is the exact defect this file exists to catch: a duplicated key
 * is NOT a JSON parse error. `JSON.parse` resolves it with last-one-wins, so
 * the parsed object looks perfectly clean and the duplicate is invisible
 * exactly to the tool a reader would reach for. This app has no formatter and
 * no linter configured (AGENTS.md), so nothing else in the toolchain ever
 * parses the manifest for shape — `scripts/check-versions.sh` pulls one field
 * out with jq and stops there.
 *
 * The hazard is not cosmetic for THIS manifest. `three` and `@types/three` are
 * deliberately pinned EXACT with no caret, and the top-level `//three` note
 * states they "must move together" — because `three` ships no `.d.ts`, so a
 * floated or mismatched types package describes an API the bundled runtime does
 * not have. A second, shadowed `three` entry makes that note a trap: the
 * alphabetically-placed edit a future bump makes to the entry it FINDS is
 * discarded by the entry that WINS, silently re-creating the very skew the note
 * forbids. Last-one-wins is also unstable across tools — `pnpm` keeps the last,
 * `jq` keeps the first — so the two halves of the manifest could disagree about
 * which version is real.
 */

const MANIFEST = "package.json";

// No `@types/node` in this app (globals stay DOM-only), so `fs` arrives through
// the computed-specifier trick the CSS tests use — see `src/lib/cssSource.ts`.
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

/**
 * Every `"key":` position in the file, tagged with the object it belongs to.
 *
 * Tagged by BRACE DEPTH rather than by a name regex, because the real failure
 * mode was the nesting getting guessed wrong: the manifest now carries a
 * top-level `"//three"` note whose value is a prose string containing BOTH the
 * words `dependencies` and `devDependencies` and a quoted `"//"`. A slice
 * between two `"dependencies":` anchors therefore runs off the end of the file
 * and a `^\s*"key":` scan over it picks up that prose — which reads as a
 * top-level `"//three"` duplicate. That is a false positive, and a test that
 * cries wolf on the manifest it is auditing is worse than no test.
 *
 * So: track `string` / `inString` / `escape` / `depth` character by character,
 * and only treat a `"` as a key when it opens at `depth >= 1` and the next
 * non-whitespace character is `:`. Every character inside a string literal is
 * skipped, so the prose in `//three` can never be mistaken for a key; `depth`
 * 1 is the manifest root, `depth` 2 is inside `dependencies`, and so on.
 */
const keyOccurrences = (
  text: string,
): Array<{ path: string; key: string; index: number }> => {
  const found: Array<{ path: string; key: string; index: number }> = [];
  // The object each key sits in, named by the key that introduced it, so a
  // failure message says `dependencies.three` and not `depth 2`.
  const names: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      // Read the string's contents.
      let j = i + 1;
      let value = "";
      let esc = false;
      while (j < text.length) {
        const c = text[j];
        if (esc) {
          value += c;
          esc = false;
        } else if (c === "\\") {
          esc = true;
        } else if (c === '"') {
          break;
        } else {
          value += c;
        }
        j++;
      }
      // Is the closing quote followed (past whitespace) by a colon? Then this
      // string is a KEY of the object we are currently inside.
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (depth >= 1 && text[k] === ":") {
        found.push({ path: names[names.length - 1] ?? "(root)", key: value, index: i });
        // Remember this key as the name of the object the next `{` opens.
        let m = k + 1;
        while (m < text.length && /\s/.test(text[m])) m++;
        if (text[m] === "{") names[depth + 1] = value;
      }
      i = j + 1;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      names.length = depth + 1;
    }
    i++;
  }
  return found;
};

const duplicatesIn = (text: string) => {
  const seen = new Map<string, number>();
  const dupes: Array<{ path: string; key: string; count: number }> = [];
  const seenOnce = new Set<string>();
  for (const { path, key } of keyOccurrences(text)) {
    const id = `${path}.${key}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n === 2 && !seenOnce.has(id)) {
      seenOnce.add(id);
      dupes.push({ path, key, count: 2 });
    } else if (n > 2) {
      const d = dupes.find((x) => x.path === path && x.key === key);
      if (d) d.count = n;
    }
  }
  return dupes;
};

describe("package.json manifest shape", () => {
  const text = readFileSync(MANIFEST, "utf8");

  it("declares no key twice in any object", () => {
    // The regression: `three` was added next to its `@types/three` sibling AND
    // again further down the alphabetical run, so the manifest held one
    // dependency twice and `JSON.parse` reported whichever of the two happened
    // to win.
    expect(duplicatesIn(text)).toEqual([]);
  });

  it("reads `three` exactly once in each dependency map", () => {
    for (const section of ["dependencies", "devDependencies"] as const) {
      // Anchored on the section's own `"dependencies":` KEY token, not on the
      // bare word, so the `//three` note that quotes both words cannot match.
      const open = text.indexOf(`\n  "${section}": {`);
      expect(open, `no "${section}" block found`).toBeGreaterThan(-1);
      const close = text.indexOf("\n  }", open);
      expect(close).toBeGreaterThan(open);
      const block = text.slice(open, close);
      const declarations = block.match(/^\s{4}"three":/gm) ?? [];
      expect(declarations.length, `"three" in ${section}`).toBeLessThanOrEqual(1);
    }
  });

  it("pins the three pair EXACT and keeps them in one block", () => {
    // Exact, not floated: no leading range operator on either line.
    expect(text).toMatch(/"three":\s*"\d+\.\d+\.\d+"/);
    expect(text).toMatch(/"@types\/three":\s*"\d+\.\d+\.\d+"/);
    expect(text).not.toMatch(/"three":\s*"[\^~><*]/);
    expect(text).not.toMatch(/"@types\/three":\s*"[\^~><*]/);

    // And adjacent-in-one-block, which is what makes "move them together"
    // something a reader can actually see and do.
    const threeIndex = text.indexOf('\n    "three":');
    const typesIndex = text.indexOf('\n    "@types/three":');
    expect(threeIndex).toBeGreaterThan(-1);
    expect(typesIndex).toBeGreaterThan(-1);
    expect(Math.abs(threeIndex - typesIndex)).toBeLessThan(200);
  });
});
