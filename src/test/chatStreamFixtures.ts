/**
 * Shared module-level scaffolding for `ChatStream` tests (issue #135 §5
 * "Split Test Suite").
 *
 * Everything here was MOVED VERBATIM out of `src/components/ChatStream.test.tsx`
 * (task chatstream-decomposition-task02). Behaviour is MOVED, not improved:
 * the seed helpers mutate the real zustand stores exactly as before, the
 * interaction helpers drive the RTL queries exactly as before, and the three
 * constants keep their exact values and doc comments.
 *
 * DO NOT call `vi.mock` from this file, and DO NOT move the `vi.mock` factories
 * here: `vi.mock` hoists per module — a factory body may reference only
 * bindings whose module is BOTH free of any transitive import of the mocked
 * specifier AND imported before anything that imports it. This module imports
 * `useSettings` and `useSessions`, whose stores both import `../lib/tauri`, so
 * it HAS a transitive path INTO the mocked barrel: a factory delegated here
 * fails as 0 tests run (`Cannot access '__vi_import_N__' before
 * initialization`). The two `vi.mock` CALLS AND their factory bodies therefore
 * stay in `src/components/ChatStream.test.tsx` — which is also what keeps
 * `src/lib/tauriBarrel.test.ts`'s mock-seam pin green (it scans every
 * `.test.tsx?` file under `src/` for `vi.mock` of a `lib/tauri` module path;
 * the call text, which contains `vi.importActual`, stays in the test file).
 *
 * The only barrel binding this module needs — `listSkills` for
 * `waitForCatalog` — is INJECTED as a parameter rather than imported, so this
 * module's dependency graph stays free of `../lib/tauri`. `./fixtures` here
 * resolves to the barrel at `src/test/fixtures/index.ts`.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import type { AppSettings } from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { useSettings } from "../store/settings";
import { makeSessionRow, makeSettings, makeSpaceRow } from "./fixtures";

/**
 * The monospace advance as a fraction of font size, used to turn a braille
 * grid's cell count into the px the `BrailleLoader` actually occupies at
 * `fontSize={14}`. 0.6em is the conventional mono advance and the one the
 * indicator's floor is derived from — the constant lives in the test so the
 * floor is checked against an INDEPENDENT statement of the arithmetic rather
 * than against the component's own number.
 */
export const MONO_ADVANCE_EM = 0.6;

/** A full settings fixture (the spinner-style tests seed the store with it).
 *  The shared fixture — this file's 22-field literal was byte-identical to
 *  `DEFAULT_SETTINGS`, which is the drift `src/test/fixtures/settings.ts`
 *  exists to make a compile error instead of a silent copy. */
export const SETTINGS_FIXTURE: AppSettings = makeSettings();

/**
 * Seed the settings store with the `#` MCP-mention trigger ENABLED.
 * The trigger is OFF by default (it collides with pasted developer text), so
 * every test that exercises the shipped `#` behavior opts in explicitly here —
 * the same seeding path the spinner-style tests use, so the gate is read from
 * the same store the composer reads.
 */
export function seedMcpMentionsOn(): void {
  useSettings
    .getState()
    .setSettings({ ...SETTINGS_FIXTURE, mcpMentionsEnabled: true });
}

/**
 * Seed the settings store with the `#` MCP-mention trigger EXPLICITLY off
 * (the default when nothing is seeded is also off — `settings === null` —
 * so this pins the flag itself rather than the not-yet-loaded fallback).
 */
export function seedMcpMentionsOff(): void {
  useSettings
    .getState()
    .setSettings({ ...SETTINGS_FIXTURE, mcpMentionsEnabled: false });
}

/** The `<mcp>` block `expandMentions` produces for the `postgres` fixture
 * server (a message PERSISTED while the `#` trigger was on). */
export const PERSISTED_MCP_MESSAGE =
  "query #postgres\n\n" +
  '<mcp name="postgres">' +
  '\nThe user has explicitly named the MCP server "postgres" for this' +
  '\nrequest. Connect to it via the mcp tool (mcp({ connect: "postgres" }))' +
  "\nand use its tools. (Server summary: npx -y x-mcp.)" +
  "\n</mcp>";

/**
 * Seed a live session (fresh transcript) in the sessions store.
 *
 * The rows and the Space come from `src/test/fixtures` (the rolling migration)
 * — the literals they replace were byte-identical to the fixture defaults plus
 * an override, so nothing about the seeded state changed.
 */
export function seedLiveSession(): void {
  useSessions.setState({
    activeSessionId: "s1",
    sessions: [makeSessionRow({ sessionId: "s1", cwd: "/home/u/proj" })],
    spaces: [makeSpaceRow({ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1 })],
    historySessions: [],
    messages: { s1: [] },
    inTurn: {},
    stopReasons: {},
    closeReasons: {},
    configOptions: {},
    compacting: {},
  });
}

/**
 * Seed a STORED (non-live) session: `sessions` is empty, the session lives
 * in `historySessions` (so `isLive` is false). `capabilities` defaults to `{}`
 * (history-only); pass `{ loadSession: true }` for the resumable case.
 */
export function seedStoredSession(
  capabilities: Record<string, unknown> = {},
): void {
  useSessions.setState({
    activeSessionId: "s1",
    sessions: [],
    spaces: [makeSpaceRow({ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1 })],
    historySessions: [
      makeSessionRow({ sessionId: "s1", cwd: "/home/u/proj", capabilities }),
    ],
    messages: { s1: [] },
    inTurn: {},
    stopReasons: {},
    closeReasons: {},
    configOptions: {},
  });
}

/**
 * Seed a session that lives ONLY in `archivedSessions` (opened from the
 * Archived section): `sessions` and `historySessions` are empty, so the
 * session is neither live nor in the stored list.
 */
export function seedArchivedSession(
  capabilities: Record<string, unknown> = {},
): void {
  useSessions.setState({
    activeSessionId: "s9",
    sessions: [],
    spaces: [makeSpaceRow({ path: "/home/u/arch", createdAt: 1, lastOpenedAt: 1 })],
    historySessions: [],
    archivedSessions: [
      makeSessionRow({
        sessionId: "s9",
        cwd: "/home/u/arch",
        capabilities,
        archived: true,
      }),
    ],
    messages: { s9: [] },
    inTurn: {},
    stopReasons: {},
    closeReasons: {},
    configOptions: {},
  });
}

/**
 * Seed a live session whose agent advertises `promptCapabilities.image`
 * (the image-attachment capability gate — fail-closed otherwise).
 */
export function seedLiveSessionWithImages(): void {
  useSessions.setState({
    activeSessionId: "s1",
    sessions: [
      makeSessionRow({
        sessionId: "s1",
        cwd: "/home/u/proj",
        capabilities: { promptCapabilities: { image: true } },
      }),
    ],
    spaces: [makeSpaceRow({ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1 })],
    historySessions: [],
    messages: { s1: [] },
    inTurn: {},
    stopReasons: {},
    closeReasons: {},
    configOptions: {},
  });
}

// `fireEvent.paste` wraps the dispatch in `act` (a raw `dispatchEvent` does NOT —
// state changes then need `await act(...)` to become visible) and jsdom has no
// `DataTransfer`, so the plain `clipboardData` object is attached as-is and
// reaches React's `onPaste` with `e.clipboardData.items` intact. A pasted image
// lives in `items` as a `ClipboardItem` you pull via `getAsFile()`; `files` is
// EMPTY in real webviews (WebKit/WebView2), so the stub mirrors that — it builds
// `items` (NOT `files`) and each item models the real `ClipboardItem` shape.
export function pasteToComposer(
  files: File[],
  extra: { text?: string; html?: string } = {},
): boolean {
  const target = screen.getByRole("textbox") as HTMLTextAreaElement;
  return fireEvent.paste(target, {
    clipboardData: {
      items: files.map((f) => ({
        kind: "file",
        type: f.type,
        getAsFile: () => f,
      })),
      getData: (type: string) =>
        type === "text/plain" ? (extra.text ?? "") : (extra.html ?? ""),
    },
  });
}

export function dropOnComposer(files: File[]): void {
  // `getByRole("textbox")` (the placeholder is the single static
  // "Ask for follow-up changes" — state-independent).
  const target = screen.getByRole("textbox");
  fireEvent.drop(target, { dataTransfer: { files } });
}

/**
 * Flush the microtask queue (the mocked IPC promises resolve after
 * `render` — their state updates must land BEFORE the assertions,
 * wrapped in `act` so React applies them to the DOM).
 */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * A promise that has NOT settled yet, plus its resolvers — the shape an
 * in-flight IPC has. `deferred` (rather than a plain pending promise) so a
 * test can settle it on purpose and assert what the NEXT keystroke does, and
 * so a test that means to leave one hanging can still unwind it.
 */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Wait for the skill catalog to load AND render. The mocked `listSkills`
 * resolves in a microtask; the hook's `p.then` then runs `setRows` one or
 * more microtasks later. A `setTimeout(0)` macrotask wait guarantees every
 * pending microtask (the whole promise chain) has run, so the re-render with
 * the loaded rows has landed. (Needed for the send-expansion test, where the
 * picker is NOT open — `findByText` can't be used as the wait signal.)
 */
export async function waitForCatalog(
  listSkills: typeof import("../lib/tauri")["listSkills"],
): Promise<void> {
  await waitFor(() => expect(vi.mocked(listSkills)).toHaveBeenCalled());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
