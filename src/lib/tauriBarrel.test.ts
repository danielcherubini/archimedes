import { describe, expect, it } from "vitest";

/**
 * THE `lib/tauri` BARREL GUARD (finding 12a, Task D1) — a source scanner, not a
 * linter, in the shape this repo already runs (`classNameConvention.test.ts`,
 * `themeTokens.test.ts`, `chromeButton.test.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS THE ACCEPTANCE CRITERION, NOT A FORMALITY
 * ---------------------------------------------------------------------------
 *
 * `src/lib/tauri.ts` was split by domain into `src/lib/tauri/*.ts`. It survives
 * as a RE-EXPORT BARREL for one reason: **35 test files `vi.mock` `@/lib/tauri`
 * BY MODULE PATH** (34 spreading `vi.importActual` — both counts pinned by the
 * assertion below rather than carried by hand; the header used to also state how
 * many named `vi.fn()` overrides sit inside those factories, and had gone stale,
 * so it no longer does). A `vi.mock` on a module path intercepts only the calls
 * that travel THROUGH that path. So the moment any consumer imports a
 * moved function from `lib/tauri/sessions.ts` directly, every test that mocked
 * it through `@/lib/tauri` **silently stops intercepting — and still passes,
 * against real IPC.** That is the worst possible failure mode of this refactor:
 * green, and lying.
 *
 * A reviewer cannot catch that by reading a diff, and the test suite cannot
 * catch it by running. Only a scanner over the import graph can, and only one
 * that ALSO covers the test files (a test that imports a domain module bypasses
 * its own mock — the exact bug, from the other side). So unlike
 * `classNameConvention.test.ts`, which deliberately excludes tests, THIS scanner
 * includes them.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------
 *
 * The only files allowed to import from inside `src/lib/tauri/` are:
 *   - the barrel itself (`src/lib/tauri.ts`), and
 *   - the domain modules inside `src/lib/tauri/`.
 *
 * Everything else in `src/` — component, hook, store, or test — imports
 * `@/lib/tauri` (or a relative path that resolves to it). The barrel is not an
 * organizational nicety; it is the mock seam the suite rests on.
 */

// Node's `fs` through a COMPUTED specifier — this app ships no `@types/node`, so
// a bare `import "node:fs"` does not typecheck. The idiom `cssSource.ts`,
// `themeTokens.test.ts` and `classNameConvention.test.ts` use.
const NODE_FS = "node:" + "fs";
const { readFileSync, readdirSync, existsSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
  readdirSync: (
    path: string,
    options: { recursive: true; encoding: string },
  ) => string[];
  existsSync: (path: string) => boolean;
};

const BARREL = "src/lib/tauri.ts";
const DIR = "src/lib/tauri";

/** EVERY `.ts`/`.tsx` under `src/` — tests INCLUDED, see the header. */
const SOURCES = readdirSync("src", { recursive: true, encoding: "utf8" })
  .filter((p) => /\.tsx?$/.test(p))
  .map((p) => `src/${p}`)
  .sort();

/** Strip comments before scanning: a doc-comment that MENTIONS
 *  `lib/tauri/sessions` is prose, not an import — the
 *  `themeTokens.test.ts:697` lesson. */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** Any module specifier: `from "…"`, `import("…")`, `import type … from "…"`. */
const SPECIFIER =
  /(?:\bfrom|\bimport)\s*\(?\s*(["'])((?:[^"'\\]|\\.)+)\1/g;

/** Resolve a specifier the way the bundler's `@` alias + Node resolution do.
 *  Returns the repo-relative path it points at, or `null` for a bare package. */
const resolve = (importer: string, spec: string): string | null => {
  let base: string;
  if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    const parts = importer.split("/").slice(0, -1);
    for (const seg of spec.split("/")) {
      if (seg === ".") continue;
      else if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    base = parts.join("/");
  } else return null;
  // Extension candidates BEFORE the bare path, and before a directory: that is
  // Vite/`bundler` resolution order, and it matters here — once the split
  // lands, BOTH `src/lib/tauri.ts` and the directory `src/lib/tauri/` exist, and
  // resolving `./tauri` to the directory would hide every real edge.
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
    if (existsSync(cand)) return cand;
  }
  return `${base} (unresolved)`;
};

/** Every edge that reaches INTO `src/lib/tauri/` from outside the allowed set. */
const directDomainImports = (): string[] => {
  const offenders: string[] = [];
  for (const file of SOURCES) {
    if (file === BARREL || file.startsWith(`${DIR}/`)) continue;
    const src = stripJsComments(readFileSync(file, "utf8"));
    for (const match of src.matchAll(SPECIFIER)) {
      const resolved = resolve(file, match[2]!);
      if (resolved && resolved.startsWith(`${DIR}/`)) {
        const line = src.slice(0, match.index ?? 0).split("\n").length;
        offenders.push(`${file}:${line} → ${resolved}`);
      }
    }
  }
  return offenders.sort();
};

/** The names a file declares as exports (the scanner's view of a module's API). */
const exportedNames = (file: string): string[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      const m = line.match(
        /^export (?:declare )?(?:async function|function|interface|type|const|let|class) ([A-Za-z0-9_]+)/,
      );
      return m ? [m[1]!] : [];
    });

/** The names a file RE-EXPORTS: `export { a, b as c } from "…"` and
 *  `export type { a } from "…"` and `export * from "…"`. */
const reexportedNames = (file: string): string[] => {
  const src = stripJsComments(readFileSync(file, "utf8"));
  const names: string[] = [];
  for (const m of src.matchAll(
    /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from/g,
  )) {
    for (const part of m[1]!.split(",")) {
      const token = part.trim();
      if (!token) continue;
      const as = token.split(/\s+as\s+/);
      names.push((as[1] ?? as[0]!).trim());
    }
  }
  return names.sort();
};

/** The domain modules that exist right now (tests excluded — they declare
 *  nothing the barrel forwards). */
const domainModules = (): string[] =>
  existsSync(DIR)
    ? readdirSync(DIR, { recursive: true, encoding: "utf8" })
        .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p))
        .map((p) => `${DIR}/${p}`)
        .sort()
    : [];

/** --------------------------------------------------------------------------
 * THE PINNED PUBLIC API.
 *
 * The list below is the export set of `src/lib/tauri.ts` measured at the commit
 * BEFORE the split (107 names: 58 types + 49 functions). It is a LITERAL on
 * purpose, for the same reason `tauri.test.ts` pins command names as literals
 * and `ipc/events.test.ts` refuses to read `IPC_EVENTS` back: recomputing the
 * expectation from the file under test makes the guard green on any change. A
 * name may only enter or leave this list on purpose, in a commit that says so.
 * -------------------------------------------------------------------------- */
const TAURI_PUBLIC_API = [
  "AccessPolicy",
  "AcpSessionUpdate",
  "AcpToolCallStatus",
  "AgentConfigDto",
  "AgentDefinitionDto",
  "AgentOverride",
  "AgentOverrideFields",
  "AgentOverrides",
  "AgentOverrideSources",
  "AppSettings",
  "AskQuestionDto",
  "AskResponsePayload",
  "attentionArm",
  "attentionDisarm",
  "authMcpServer",
  "cancelSession",
  "CloseReasonStr",
  "closeSession",
  "compactSession",
  "CompletionDirDto",
  "CompletionEntryDto",
  "ContentBlock",
  "deleteSession",
  "deleteSpace",
  "externalOpen",
  "FileListDto",
  "FilePolicy",
  "FontSettings",
  "getSettings",
  "getWindowState",
  "HistoryPage",
  "InteractiveEventPayload",
  "InteractiveRequestClosePayload",
  "InteractiveRequestPayload",
  "InteractiveResponseDto",
  "KnownProvider",
  "listAgentConfig",
  "listAgentDefinitionsForSpace",
  "listCompletionEntries",
  "listenInteractiveEvent",
  "listenInteractiveRequest",
  "listenInteractiveRequestClose",
  "listenPermissionRequest",
  "listenSessionClosed",
  "listenSessionStalled",
  "listenSessionTitled",
  "listenSessionUpdate",
  "listenSubagentClosed",
  "listenSubagentSessionStarted",
  "listenWindowState",
  "listKnownProviders",
  "listMcpServersEffective",
  "listModels",
  "listSessions",
  "listSkills",
  "listSpaceFiles",
  "listSpaces",
  "listTools",
  "loadHistory",
  "McpServerEntry",
  "McpServerInfo",
  "MessageRow",
  "ModelDto",
  "OverrideSource",
  "PermissionOption",
  "PermissionOutcome",
  "PermissionRequest",
  "PermissionRequestPayload",
  "ProviderConfig",
  "readClipboardImage",
  "readFileBytes",
  "respondInteractiveRequest",
  "respondPermission",
  "resumeSession",
  "saveSettings",
  "sendPrompt",
  "SessionClosedPayload",
  "SessionConfigOption",
  "SessionConfigSelectGroup",
  "SessionConfigSelectOption",
  "SessionInfo",
  "SessionTitledPayload",
  "SessionUpdatePayload",
  "setSessionArchived",
  "setSessionConfigOption",
  "setSpaceTrusted",
  "ShadowedAgent",
  "ShadowedSkill",
  "shellSandboxAvailable",
  "SkillInfo",
  "SpaceCheck",
  "spaceForPath",
  "SpaceRow",
  "StalledInfo",
  "StalledPayload",
  "startSession",
  "StopReason",
  "SubagentClosedPayload",
  "SubagentFailureReason",
  "SubagentMetrics",
  "SubagentSessionStartedPayload",
  "testMcpServer",
  "testSearchProvider",
  "ToolCallContent",
  "WebSettings",
  "WindowFrameState",
  "WireApi",
];

/** The 49 RUNTIME values (the rest are type-only and vanish at runtime). */
const TAURI_RUNTIME_API = [
  "attentionArm",
  "attentionDisarm",
  "authMcpServer",
  "cancelSession",
  "closeSession",
  "compactSession",
  "deleteSession",
  "deleteSpace",
  "externalOpen",
  "getSettings",
  "getWindowState",
  "listAgentConfig",
  "listAgentDefinitionsForSpace",
  "listCompletionEntries",
  "listenInteractiveEvent",
  "listenInteractiveRequest",
  "listenInteractiveRequestClose",
  "listenPermissionRequest",
  "listenSessionClosed",
  "listenSessionStalled",
  "listenSessionTitled",
  "listenSessionUpdate",
  "listenSubagentClosed",
  "listenSubagentSessionStarted",
  "listenWindowState",
  "listKnownProviders",
  "listMcpServersEffective",
  "listModels",
  "listSessions",
  "listSkills",
  "listSpaceFiles",
  "listSpaces",
  "listTools",
  "loadHistory",
  "readClipboardImage",
  "readFileBytes",
  "respondInteractiveRequest",
  "respondPermission",
  "resumeSession",
  "saveSettings",
  "sendPrompt",
  "setSessionArchived",
  "setSessionConfigOption",
  "setSpaceTrusted",
  "shellSandboxAvailable",
  "spaceForPath",
  "startSession",
  "testMcpServer",
  "testSearchProvider",
];

describe("the scanner actually reads the tree", () => {
  it("walks every source file including tests, and can resolve an import", () => {
    // Vacuity guard: a broken walk would leave every rule below green for the
    // wrong reason — the failure `themeTokens.test.ts` records being bitten by.
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(SOURCES).toContain(BARREL);
    expect(SOURCES.some((f) => f.endsWith(".test.tsx"))).toBe(true);
    // Resolution is exercised on a REAL edge, not a synthetic one.
    expect(resolve("src/components/OpenAnchor.tsx", "../lib/tauri")).toBe(
      BARREL,
    );
    expect(resolve("src/components/OpenAnchor.tsx", "@tauri-apps/api/core")).toBe(
      null,
    );
    // And the alias form used across `src/components/settings/`.
    expect(resolve("src/components/settings/WebSearchSection.tsx", "@/lib/tauri")).toBe(
      BARREL,
    );
  });

  it("the scanner sees the mock seam it exists to protect", () => {
    // If this ever reads 0, the `vi.mock("@/lib/tauri")` factories were rewritten
    // and this whole file's premise is gone — a decision to record, not a silent
    // one. Comment-stripped, because THIS file names the idiom in prose and would
    // otherwise count itself: the first version of this assertion did exactly that
    // and reported 35 where the tree then had 33.
    const mockers = SOURCES.filter(
      (f) =>
        /\.test\.tsx?$/.test(f) &&
        /^\s*vi\.mock\(\s*["'][^"']*lib\/tauri["']/m.test(
          stripJsComments(readFileSync(f, "utf8")),
        ),
    );
    // SET SIZE, pinned: 35 files mock the barrel by path. The number may only
    // move when a test file is added or removed, in a commit that says so — this
    // one moved 34 -> 35 when D2 wired `useAgentOverridesWrites` into `SpacesList`
    // and landed its test file, which mocks the barrel the documented way.
    expect(mockers).toHaveLength(35);
    // 34 of the 35 SPREAD `vi.importActual`, which is the shape that makes the
    // seam forgiving: an unlisted export still resolves. The remaining one replaces
    // the module wholesale, so a name it forgets is `undefined` — the case the
    // pinned-surface assertion below covers.
    expect(
      mockers.filter((f) =>
        /vi\.importActual/.test(readFileSync(f, "utf8")),
      ).length,
    ).toBe(34);
  });
});

describe("nothing bypasses the lib/tauri barrel (D1's mock seam)", () => {
  it("no file outside src/lib/tauri/ imports a domain module directly", () => {
    // THE guard. See the header for why a violation is green-but-broken.
    expect(directDomainImports()).toEqual([]);
  });

  it("the barrel re-exports the exact pinned public API", () => {
    const through = reexportedNames(BARREL);
    const declared = exportedNames(BARREL);
    // Before the split the names are DECLARED in the barrel; after, they are
    // re-exported. Either way the barrel's surface is the pinned set.
    const surface = [...new Set([...through, ...declared])].sort();
    expect(surface).toEqual([...TAURI_PUBLIC_API].sort());
  });

  it("the runtime export set of the barrel is exactly the pinned 49", async () => {
    // The strongest form: what the module ACTUALLY exposes at runtime, which is
    // what `vi.importActual` spreads into the 35 mock factories. A forgotten
    // `export { fn }` here is a `undefined is not a function` in the app and a
    // silently-unmocked IPC call in a test — this catches it at the seam.
    const mod = await import("./tauri");
    expect(Object.keys(mod).sort()).toEqual([...TAURI_RUNTIME_API].sort());
  });

  it("domain modules never export the same name twice (a duplicate would silently shadow)", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const mod of domainModules()) {
      for (const name of [...exportedNames(mod), ...reexportedNames(mod)]) {
        if (seen.has(name)) clashes.push(`${name}: ${seen.get(name)} / ${mod}`);
        else seen.set(name, mod);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("the barrel holds NO implementation — it is a pure re-export surface", () => {
    // This assertion was RED before the split (this file WAS the implementation)
    // and went green with the last module's move. It stays because a function the
    // split failed to place would otherwise drift back here silently, and because
    // a barrel holding logic is a barrel that can no longer be read as a list of
    // the domains it forwards.
    const src = stripJsComments(readFileSync(BARREL, "utf8"));
    expect(src).not.toMatch(/\binvoke\s*[<(]/);
    expect(src).not.toMatch(/\blisten\s*[<(]/);
    // A DECLARED function / interface / const. `export { … } from` and
    // `export type { … } from` are re-exports — the only thing that belongs here.
    expect(src).not.toMatch(/^export (async function|function|interface|const)\b/m);
    expect(src).not.toMatch(/^export type\s+[A-Za-z_]/m);
    // `export *` is banned outright: it would make the pinned-surface assertion
    // above blind, and the pinned list would stop being the contract.
    expect(src).not.toMatch(/^export \*/m);
  });

  it("no name is declared in the barrel AND re-exported from a domain module", () => {
    // The duplication guard, and it is migration-aware on purpose: while the
    // split is in progress the barrel legitimately still DECLARES the modules
    // that have not moved yet. What must never happen is a name living in BOTH
    // places — the barrel's own copy would be what `vi.importActual` spreads, so
    // the domain module (and any state or fix in it) would be dead code.
    const declared = new Set(exportedNames(BARREL));
    const dupes: string[] = [];
    for (const mod of domainModules()) {
      for (const name of [...exportedNames(mod), ...reexportedNames(mod)]) {
        if (declared.has(name)) dupes.push(`${name} (also declared in ${BARREL})`);
      }
    }
    expect(dupes).toEqual([]);
  });
});

describe("lib/ipcError.ts stays free of lib/tauri (its documented contract)", () => {
  it("ipcError imports nothing", () => {
    // `ipcError.ts:21` states the rule in prose: it is used by Settings
    // components that never touch `lib/tauri`, and a formatting helper must not
    // drag `@tauri-apps/api` in. The split must not become the reason it does.
    const src = stripJsComments(readFileSync("src/lib/ipcError.ts", "utf8"));
    expect(src).not.toMatch(/\bfrom\s+["']/);
    expect(src).not.toMatch(/\bimport\s*\(/);
  });
});
