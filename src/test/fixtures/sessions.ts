import type {
  SessionConfigOption,
  SessionInfo,
  SpaceRow,
} from "../../lib/tauri";
import type { Message } from "../../store/sessions";
import type { SessionConfigSource } from "../../lib/sessionConfig";

/**
 * Session / Space / transcript row fixtures.
 *
 * Same reasoning as `./settings`: the sidebar, the side pane, the composer and
 * the three-list walk (`lib/sessionConfig.ts`, and B1's `sessionLookup.ts`) all
 * take the same `SessionInfo` rows, and every test so far hand-rolls them —
 * `SpaceTabs.test.tsx` alone defines a local `space()` and `info()` and calls
 * them ~70 times.
 *
 * Import the module from a `vi.mock` factory with `await import()`, not with an
 * outer `const` — see the hoisting note in `./settings.ts`.
 */

/** The Space every row lands in by default (the value the sidebar groups on). */
const DEFAULT_CWD = "/w/space";

/**
 * A `SessionInfo` as the IPC layer delivers it.
 *
 * The three OPTIONAL fields (`title`, `contextUsage`, `configOptions`) stay
 * ABSENT unless asked for — they are absent on the wire, and the store branches
 * on `info.configOptions ? … : …`, so setting them to `undefined` would seed a
 * shape the backend never sends (and would make `in`-checks answer differently
 * than production).
 */
export function makeSessionRow(
  overrides: Partial<SessionInfo> = {},
): SessionInfo {
  const row: SessionInfo = {
    sessionId: "s1",
    cwd: DEFAULT_CWD,
    capabilities: {},
    archived: false,
    ...overrides,
  };
  // Drop an optional key a caller passed as explicitly-`undefined`, so the
  // fixture matches the wire shape (`Object.keys` excludes it) rather than
  // carrying a key with an `undefined` value.
  for (const optional of ["title", "contextUsage", "configOptions"] as const) {
    if (optional in row && row[optional] === undefined) {
      delete row[optional];
    }
  }
  return row;
}

/**
 * A `SpaceRow` from `list_spaces` / `addSpace`.
 *
 * `createdAt <= lastOpenedAt` by construction: the sidebar's ordering rule is
 * `lastOpenedAt` DESC and a fixture where a Space was opened before it was
 * created makes any ordering assertion meaningless.
 */
export function makeSpaceRow(overrides: Partial<SpaceRow> = {}): SpaceRow {
  const createdAt = overrides.createdAt ?? 1_000;
  return {
    path: DEFAULT_CWD,
    createdAt,
    lastOpenedAt: createdAt,
    trusted: false,
    ...overrides,
  };
}

/** The defaults shared by every `Message` arm (the arrival stamp). */
const DEFAULT_AT = 1_000;

/**
 * One transcript `Message`, by kind.
 *
 * `Message` is a discriminated UNION (`store/sessions.ts:53`), so a single
 * flat factory cannot type it — the `kind` argument selects the arm and the
 * override type is that arm's own shape, which is what stops a `text` override
 * reaching a `tool-call`.
 *
 * `at` defaults to a fixed stamp rather than `Date.now()` so a snapshot-style
 * `toEqual` is stable; the store stamps `Date.now()` at arrival, and a test that
 * cares about the clock passes `at` explicitly.
 */
export function makeMessage<K extends Message["kind"]>(
  kind?: K,
  overrides?: Partial<Extract<Message, { kind: K }>>,
): Extract<Message, { kind: K }> {
  const resolved: Message["kind"] = kind ?? "agent-text";
  const base: Record<string, unknown> = { at: DEFAULT_AT };
  switch (resolved) {
    case "user":
      base.kind = "user";
      base.text = "Test prompt";
      break;
    case "agent-text":
      base.kind = "agent-text";
      base.messageId = "m1";
      base.text = "Test reply";
      break;
    case "agent-thought":
      base.kind = "agent-thought";
      base.messageId = "m1";
      base.text = "Test thought";
      break;
    case "tool-call":
      base.kind = "tool-call";
      base.id = "t1";
      base.title = "Test tool call";
      base.status = "completed";
      break;
    case "diff":
      base.kind = "diff";
      base.path = "src/test.ts";
      base.patch = "@@ -1 +1 @@";
      break;
  }
  return { ...base, ...(overrides ?? {}) } as Extract<Message, { kind: K }>;
}

/** The input shape `sessionConfig.ts`'s derivations (and B1's `sessionLookup`)
 *  walk: the three session lists plus the two per-id maps. Exported again from
 *  `./index` so a lookup test imports one thing. */
export function makeConfigSource(
  overrides: Partial<SessionConfigSource> = {},
): SessionConfigSource {
  return {
    configOptions: {},
    contextUsage: {},
    sessions: [],
    historySessions: [],
    archivedSessions: [],
    ...overrides,
  };
}

/**
 * One `SessionConfigOption` (the model / thinking-level select's data). The
 * `options` array is required by the UI for a `select` to render rows, so the
 * default carries one — an empty array renders a select with nothing in it,
 * which is a different test's subject.
 */
export function makeConfigOption(
  overrides: Partial<SessionConfigOption> = {},
): SessionConfigOption {
  const option: SessionConfigOption = {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "gpt-5",
    options: [{ value: "gpt-5", name: "GPT-5" }],
    ...overrides,
  };
  // A `boolean` arm has no `options` on the wire, so a caller who switches the
  // `type` must not inherit the `select` default's rows.
  if (option.type === "boolean") delete option.options;
  return option;
}
