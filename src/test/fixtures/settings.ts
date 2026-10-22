import type { AppSettings } from "../../lib/tauri";

/**
 * The ONE place `AppSettings` is spelled for tests.
 *
 * WHY THIS EXISTS. `AppSettings` has 22 REQUIRED top-level fields, so a test
 * that wants "some settings" has to write all 22. 25 files answered that by
 * hand-copying a literal, and two of those literals were byte-identical
 * (`ChatStream.test.tsx` and `MessageBubble.codeblock.test.tsx`), while
 * `App.test.tsx`'s copy had silently lost the `palette` key — a drift that is
 * only possible because a bare object inside a `vi.mock` factory is untyped.
 * A new field on the real type therefore misses every copy at once, and
 * nothing notices. Here it is a COMPILE ERROR, in the one file that has to
 * change.
 *
 * THE HOISTING RULE — read this before writing a `vi.mock` factory.
 * `vi.hoisted()` is PER TEST FILE: it lifts a value within the file that calls
 * it, so it does NOT make this module importable from inside a `vi.mock`
 * factory, which is hoisted above every import in the file. That is exactly
 * what `SpacesList.test.tsx:100-104` records as unfixable today, and why its
 * literal is inlined. The mechanism that DOES work: every `vi.mock` factory in
 * this repo is already `async`, so
 *
 *   vi.mock("../lib/tauri", async () => {
 *     const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
 *     const { makeSettings } = await import("../test/fixtures/settings");
 *     return { ...actual, getSettings: vi.fn().mockResolvedValue(makeSettings()) };
 *   });
 *
 * — a dynamic `import()` INSIDE the factory runs at mock-factory time, after
 * the module graph exists. `src/test/fixtures.test.ts` asserts this route
 * works, so the claim is tested rather than remembered.
 */

/**
 * A complete `AppSettings`, with per-test overrides on top.
 *
 * Defaults are the values a FRESH INSTALL gets from the backend (the fields
 * whose serde defaults differ from the zero value are the ones that matter:
 * `sessionNamingEnabled` is `true`, `mcpMentionsEnabled` is `false`,
 * `filePolicy` is all-`allow`, `palette` is `null` meaning `"zai"`), so a test
 * seeded with the default is describing a document a user can actually have.
 *
 * Every nested object is REBUILT per call — a `{ ...DEFAULT_SETTINGS }` spread
 * would share `font`/`web`/`filePolicy` by reference, and one test mutating
 * `settings.font.sizePx` would then change every later test's fixture.
 */
export function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    font: { ...DEFAULT_SETTINGS.font },
    filePolicy: { ...DEFAULT_SETTINGS.filePolicy },
    web: { ...DEFAULT_SETTINGS.web },
    providers: [...DEFAULT_SETTINGS.providers],
    enabledTools: [...DEFAULT_SETTINGS.enabledTools],
    mcpServers: { ...DEFAULT_SETTINGS.mcpServers },
    defaultThinkingLevels: { ...DEFAULT_SETTINGS.defaultThinkingLevels },
    agentOverrides: { ...DEFAULT_SETTINGS.agentOverrides },
    paneLayout: { ...DEFAULT_SETTINGS.paneLayout },
    ...overrides,
  };
}

/**
 * The default document, exported for the cases that want the whole thing and
 * no overrides (`toEqual` against a saved payload, say). Pinned to
 * `AppSettings`, so a field added to the real type is a compile error HERE —
 * which is the entire point.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  // `null` = "zai" — a pre-ADR-0027 document reads exactly like this.
  palette: null,
  paneLayout: {},
  defaultTrustNewSpaces: false,
  defaultModel: null,
  defaultThinkingLevel: null,
  // `[]` = every tool enabled (the harness-level filter's off state).
  enabledTools: [],
  providers: [],
  mcpServers: {},
  font: { sizePx: 14, uiFamily: null, codeFamily: null },
  defaultThinkingLevels: {},
  agentOverrides: {},
  spinnerStyle: null,
  emptyStateAnimation: null,
  // ADR 0030: all-`allow` is the derived default in EVERY direction.
  filePolicy: { reads: "allow", writes: "allow", shell: "allow" },
  web: {
    braveApiKey: "",
    tavilyApiKey: "",
    perplexityApiKey: "",
    searxngUrl: "",
    defaultProvider: "auto",
    proxy: "",
  },
  mcpMentionsEnabled: false,
  sessionNamingEnabled: true,
  sessionNamingModel: null,
  sessionNamingReasoning: null,
  attentionAlertsEnabled: true,
  attentionAlertDelaySecs: 15,
};
