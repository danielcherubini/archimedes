/**
 * `ChatStream` — the ADR 0035 out-of-Space Directory completion group
 * (issue #135 §5, task06).
 *
 * These 34 tests were MOVED VERBATIM out of `src/components/ChatStream.test.tsx`
 * — the `describe("ChatStream — out-of-Space Directory completion (ADR 0035)")`
 * block with its nested `describe("the picker's two filters …")`, its `// ====`
 * section banner and its four block-local helpers (`rowByPrimary`,
 * `completionQueries`, `directoryFetches`, `routeCompletion`). `it` titles and
 * assertion bodies are byte-identical to the residual's; nothing was added,
 * removed or improved. The `dirPrefix` mutation-checked pin ("typing inside ONE
 * directory derives ONE dirPrefix …") travelled with them, so this file is where
 * that hard constraint is now pinned.
 *
 * WHAT STAYED in `ChatStream.test.tsx`: the `ChatStream` integration describe
 * (send/cancel/Esc, paste/drop/capabilities, mention expansion, picker wiring,
 * working-indicator and session-kind rendering) and the four attachment/queue
 * integration groups — the half that only the real `<ChatStream />` mount and
 * the real `send()` can prove.
 *
 * WHY the `vi.mock` factories are INLINE here and not delegated to
 * `src/test/chatStreamFixtures.ts`: that module imports `useSessions` /
 * `useSettings`, whose stores import `../lib/tauri`, so it HAS a transitive path
 * into the mocked barrel, and a factory body may reference only bindings from a
 * module free of that path — a delegation fails as 0 tests run with
 * `Cannot access '__vi_import_N__' before initialization` (measured; the probe
 * matrix in `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md`).
 * Both factories below therefore touch nothing but `vi` and their own
 * `vi.importActual` result, and the fixtures import stays AFTER the `ChatStream`
 * import. This file is therefore one of the two new mockers the mock-seam pin in
 * `src/lib/tauriBarrel.test.ts` counts (with `ChatStreamChildGates.test.tsx`).
 */

import { beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatStream from "./ChatStream";
import {
  sendPrompt,
  listSkills,
  listMcpServersEffective,
  listAgentDefinitionsForSpace,
  listSpaceListing,
  listCompletionEntries,
} from "../lib/tauri";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import { setSidePaneCollapsed } from "../lib/sidePaneState";
import { useQueuedPrompts } from "../store/queuedPrompts";
import {
  seedLiveSession,
  seedMcpMentionsOn,
  flush,
  deferred,
} from "../test/chatStreamFixtures";
import { activeMentionToken, isOutsideSpaceQuery } from "../lib/skills";
import { resetStores } from "../test/resetStores";
import type { CompletionDirDto, CompletionEntryDto } from "../lib/tauri";

// The environment stubs `src/test/setup.tsx` does NOT provide.
//
// DELETED here by the rolling B4a migration (this file was touched by B2 for the
// `IPC_EVENTS.insertSkill` fold): the `matchMedia` `stubGlobal`, the four
// `Element.prototype` pointer-capture/`scrollIntoView` stubs. All five are
// byte-equivalent to what `setup.tsx`'s own `beforeAll` installs, and this file
// calls no `vi.unstubAllGlobals()`, so the shared stubs survive for the whole
// file (that call is the ONLY thing that strips a setup-file `stubGlobal` — see
// the guard list in `setup.tsx`).
//
// KEPT, and neither is redundancy:
//  - the object-URL pair: `setup.tsx` stubs no `URL` API, and staged
//    attachments need a deterministic `blob:` URL (Node's global `URL` reaches
//    jsdom but rejects web `Blob`s).
//  - the THREE `HTMLElement.prototype` stubs: `setup.tsx` puts `scrollIntoView`
//    on `Element.prototype` only, and two tests below read
//    `HTMLElement.prototype.scrollIntoView` directly and inspect
//    `mock.contexts` to learn WHICH picker row scrolled. Without this own-property
//    override that read is `undefined` and the calls land on the inherited
//    `Element` stub — so this is a dependency, not a duplicate.
beforeAll(() => {
  URL.createObjectURL = vi.fn((file: File) => `blob:mock-${file.name}`);
  URL.revokeObjectURL = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    startSession: vi.fn().mockResolvedValue({
      sessionId: "s2",
      cwd: "/home/u/proj",
      capabilities: {},
      archived: false,
    }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("end_turn"),
    resumeSession: vi.fn().mockResolvedValue({
      sessionId: "s1",
      cwd: "/home/u/proj",
      capabilities: { loadSession: true, promptCapabilities: { image: true } },
      archived: false,
    }),
    respondPermission: vi.fn().mockResolvedValue(undefined),
    respondInteractiveRequest: vi.fn().mockResolvedValue(undefined),
    setSessionConfigOption: vi.fn().mockResolvedValue([]),
    readClipboardImage: vi.fn().mockResolvedValue(null),
    readFileBytes: vi.fn().mockResolvedValue(null),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    // The `/compact` Composer command (ADR 0044). MOCKED ON PURPOSE, and not
    // optional: this factory spreads `importActual`, so an un-mocked
    // `compactSession` would reach the REAL `invoke` and reject on jsdom's
    // missing `window.__TAURI_INTERNALS__` — a dispatch test would then "pass"
    // on the rejection landing in `send()`'s `catch` rather than on the
    // interception. `true` = "the frame was written" (the live answer).
    compactSession: vi.fn().mockResolvedValue(true),
    loadHistory: vi.fn().mockResolvedValue({ rows: [], hasMore: false, todos: null }),
    listSkills: vi.fn().mockResolvedValue([
      {
        name: "debug",
        description: "Debug a failure",
        path: "/s/.agents/skills/debug/SKILL.md",
        dir: "/s/.agents/skills/debug",
        scope: "space",
        body: "Step 1. Step 2.",
        shadowed: [],
      },
      {
        name: "beta",
        description: "Beta skill",
        path: "/s/.agents/skills/beta/SKILL.md",
        dir: "/s/.agents/skills/beta",
        scope: "space",
        body: "B body",
        shadowed: [],
      },
    ]),
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([
      {
        name: "scout",
        description: "Fast recon.",
        model: null,
        scope: "user",
      },
    ]),
    listMcpServersEffective: vi.fn().mockResolvedValue([
      {
        name: "postgres",
        kind: "stdio",
        summary: "npx -y x-mcp",
      },
    ]),
    // The `?` File-completion listing (ADR 0033). Mocked because EVERY
    // session-mounting test in this file calls it (the catalog hook fetches
    // unconditionally), and the `?` tests need to control the payload per
    // test — including a DEFERRED promise for the in-flight case. Empty by
    // default so the pre-existing `$`/`@`/`#` tests see no file rows.
    listSpaceListing: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
    // The out-of-Space Directory completion rows (ADR 0035). Mocked for the
    // same reason as `listSpaceListing`, and it is NOT optional: the composer
    // calls `useCompletionDir(null)` on EVERY mount (an empty draft has no
    // token, so `dirPrefix` is `null` and the cache misses), so an un-mocked
    // export — this factory spreads `importActual` — would fire a REAL
    // `invoke` in jsdom, reject on the missing `window.__TAURI_INTERNALS__`
    // and log a `listCompletionEntries failed:` line in every
    // session-mounting test in this file.
    listCompletionEntries: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
  };
});

// The native file picker (the `+` button's `open` — the real module would
// `invoke` Tauri's dialog plugin, which doesn't exist in jsdom).
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  // Restore real timers in case a previous test installed fake ones (the
  // mid-read tests below use `vi.useFakeTimers()` to settle the macrotask-
  // based `FileReader` deterministically) — a no-op for tests that don't.
  vi.useRealTimers();
  setSidePaneCollapsed(false);
  localStorage.clear();
  // The prompt queue is a module singleton too — drop every entry so a queue
  // left by the previous test cannot satisfy a "nothing was queued" assertion.
  // BEFORE `clearAllMocks` so the URL releases this cleanup performs are not
  // counted against the revocation assertions in the queue tests.
  for (const id of Object.keys(useQueuedPrompts.getState().bySession)) {
    useQueuedPrompts.getState().clearSession(id);
  }
  // `clearAllMocks` clears the call history (the `URL` stub implementations
  // from `beforeAll` survive — `mockClear` semantics, not `mockReset`).
  vi.clearAllMocks();
  // The skill catalog's module-level cache is shared across tests in this
  // file — clear it so each test starts with a COLD cache (a warm cache from
  // a previous test's `seedLiveSession` `cwd` key would make the fresh
  // `listSkills` mock moot: the hook would serve the cached value and never
  // re-fetch).
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  // Every store back to zustand's own captured initial state (the rolling
  // migration). This replaces a hand-written 11-key `useSessions` reset — the
  // store carries data fields that list never named, so `history`,
  // `contextUsage`, `stalled`, `newSessionError` and friends used to leak from
  // one test to the next — plus the per-id `dismiss*` calls (a whole-store
  // replace already covers them) and the settings reset (whose values ARE the
  // initial state). No count of the store's data fields is quoted here on
  // purpose: it goes stale the moment a field is added, and this comment would
  // then be a confident lie about the store it is explaining.
  //
  // The queued-prompt loop ABOVE still runs first and is NOT redundant: its
  // `clearSession` releases staged object URLs, a side effect a state replace
  // cannot perform.
  resetStores();
});

// ===========================================================================
// Out-of-Space Directory completion in the picker (ADR 0035, Task 5).
//
// A `?` token whose remainder begins `/`, `~/` or a Windows drive root leaves
// the Space **Listing** and enters **Directory completion**: the rows come from
// `listCompletionEntries` (ONE directory, unfiltered — Task 1/2), they DISPLAY
// the abbreviated `~/…` while carrying the ABSOLUTE path as `name` (nothing in
// this app expands a tilde, so the draft must hold the real path), they are
// filtered on the entry's OWN name, and selecting a DIRECTORY keeps the `?` and
// appends `/` so the descent continues instead of stranding the user after one
// level.
//
// This is a SEPARATE describe from `ChatStream` above precisely so the
// pre-existing `?`/Listing tests stay byte-identical: ADR 0035 promises the
// Space Listing is untouched, and a test that had to be edited to accommodate
// the new branch would hide that fact.
// ===========================================================================
describe("ChatStream — out-of-Space Directory completion (ADR 0035)", () => {
  /** The picker row `<button>` whose PRIMARY line is exactly `text`. */
  async function rowByPrimary(text: string): Promise<HTMLButtonElement> {
    const matches = await screen.findAllByText(text);
    const primary = matches.find((el) => el.classList.contains("text-ui-base"));
    return primary!.closest("button") as HTMLButtonElement;
  }

  /** Every `listCompletionEntries` query this test has issued, `null` included
   *  (the mount call — an empty draft derives a `null` `dirPrefix`, and the
   *  hook DOES call the fetcher on that cache miss, so a total-call count is
   *  never the right number to assert). */
  function completionQueries(): (string | null)[] {
    return vi.mocked(listCompletionEntries).mock.calls.map((c) => c[0] ?? null);
  }

  /** …restricted to the calls that named a directory (the ones that cost a
   *  directory read, which is the thing the one-directory rule budgets). */
  function directoryFetches(): string[] {
    return completionQueries().filter((q): q is string => q !== null);
  }

  /** Serve `rows` for the directory named by `query` and empty for anything
   *  else, so a test can watch a descent move from one directory to the next. */
  function routeCompletion(
    table: Record<string, CompletionEntryDto[]>,
    truncated = false,
  ): void {
    vi.mocked(listCompletionEntries).mockImplementation((query) => {
      const payload: CompletionDirDto = {
        entries: query === null ? [] : (table[query] ?? []),
        truncated: truncated && query !== null && table[query] !== undefined,
      };
      return Promise.resolve(payload);
    });
  }

  it("an outside ? token lists the directory, labelled ~/… with / on directories, on ONE line",
    async () => {
      seedLiveSession();
      // The Space Listing is seeded with a name the SAME query fuzzy-matches
      // (`ht` is a subsequence of `wait.html`), so this test also proves the
      // outside branch REPLACES the Listing rows rather than mixing with them.
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["wait.html"],
        truncated: false,
      });
      routeCompletion({
        "~/.config/": [
          {
            name: "htop",
            insert: "/home/u/.config/htop",
            display: "~/.config/htop",
            isDir: true,
          },
          {
            name: "htoprc",
            insert: "/home/u/.config/htoprc",
            display: "~/.config/htoprc",
            isDir: false,
          },
        ],
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?~/.config/ht" } });

      // The DIRECTORY row: the DISPLAYED label is the home-abbreviated form with
      // the trailing `/` the renderer adds, while the value it will INSERT is
      // the absolute path (asserted by the selection tests below).
      const dirRow = await rowByPrimary("~/.config/htop/");
      expect(dirRow.querySelector(".text-ui-xs")!.textContent).toBe("?");
      // … and the FILE row carries no trailing `/` (a file finishes, it does not
      // descend).
      expect(await rowByPrimary("~/.config/htoprc")).toBeTruthy();
      // ONE line, exactly as the Space rows: `description` stays `""` for every
      // `?` row, so the secondary line is absent. The ONE `title` that IS present
      // is the primary line's full label (the truncation contract) — asserted
      // positively, because "`[title]` is absent" was the old proxy for "no
      // secondary line" and the primary line's tooltip has since replaced it.
      expect(dirRow.querySelector(".text-ui-sm")).toBeNull();
      expect(dirRow.querySelectorAll("[title]")).toHaveLength(1);
      expect(dirRow.querySelector(".text-ui-base")!.getAttribute("title")).toBe(
        "~/.config/htop/",
      );
      // The Space Listing did NOT leak into an outside completion.
      expect(screen.queryAllByText("wait.html")).toEqual([]);
    });

  it("selecting a DIRECTORY row keeps the ?, appends / and stays live on the new directory",
    async () => {
      seedLiveSession();
      routeCompletion({
        "~/.config/": [
          {
            name: "htop",
            insert: "/home/u/.config/htop",
            display: "~/.config/htop",
            isDir: true,
          },
        ],
        // The NEXT level, which only gets fetched if the kept-`?` token really
        // became `?/home/u/.config/htop/` (its directory part, plus a `/`).
        "/home/u/.config/htop/": [
          {
            name: "htoprc",
            insert: "/home/u/.config/htop/htoprc",
            display: "~/.config/htop/htoprc",
            isDir: false,
          },
        ],
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // The caret is the LENGTH of the token (what typing leaves it at) — a
      // caret one short would splice at the wrong place and leave the `t`.
      fireEvent.change(textarea, { target: { value: "?~/.config/ht" } });
      expect(await rowByPrimary("~/.config/htop/")).toBeTruthy();
      textarea.setSelectionRange(13, 13);
      fireEvent.keyDown(textarea, { key: "Enter" });

      // The draft: the ABSOLUTE path (not `~/…` — nothing expands a tilde), the
      // `?` KEPT and a trailing `/`, and NO trailing space (a space would end
      // the token and strand the descent after one level).
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "?/home/u/.config/htop/",
      );
      // NO STALE ROWS across the descent: the instant the token names a new
      // directory the previous one's rows are gone (the catalog serves its empty
      // payload for a key it has left), so a user can never select
      // `~/.config/htoprc` believing it is INSIDE `htop/`.
      expect(screen.queryAllByText("~/.config/htop/")).toEqual([]);
      // And the picker is LIVE on the directory just entered — the second
      // level's row arrives with no further keystroke.
      expect(await rowByPrimary("~/.config/htop/htoprc")).toBeTruthy();
      expect(directoryFetches()).toEqual(["~/.config/", "/home/u/.config/htop/"]);
    });

  it("selecting a FILE row inserts the absolute path with no ? and closes the picker",
    async () => {
      seedLiveSession();
      routeCompletion({
        "~/.config/": [
          {
            name: "htoprc",
            insert: "/home/u/.config/htoprc",
            display: "~/.config/htoprc",
            isDir: false,
          },
        ],
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?~/.config/ht" } });
      const row = await rowByPrimary("~/.config/htoprc");
      textarea.focus();
      textarea.setSelectionRange(13, 13);
      fireEvent.mouseDown(row);
      // The trigger CONSUMED and the path VERBATIM — a file is the answer, so
      // the token ends (the same policy `?README` has always had).
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "/home/u/.config/htoprc ",
      );
      expect(screen.queryByTestId("mention-picker")).toBeNull();
    });

  it("the outside rows are filtered on the entry's OWN name, never on its path",
    async () => {
      seedLiveSession();
      // THE discriminating fixture. The query tail is `eu`:
      //   • `htop`'s ABSOLUTE path `/home/u/.config/htop` DOES contain the
      //     subsequence `e`…`u` (`hom`e`/`u`), so an implementation that
      //     filtered `insert` would offer this row;
      //   • its NAME does not, so the correct implementation does not.
      // `menu.conf` matches on its name (`e`…`u`), so the picker is not simply
      // empty for an unrelated reason.
      routeCompletion({
        "/home/u/.config/": [
          {
            name: "htop",
            insert: "/home/u/.config/htop",
            display: "~/.config/htop",
            isDir: true,
          },
          {
            name: "menu.conf",
            insert: "/home/u/.config/menu.conf",
            display: "~/.config/menu.conf",
            isDir: false,
          },
        ],
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?/home/u/.config/eu" } });
      const row = await rowByPrimary("~/.config/menu.conf");
      expect(row).toBeTruthy();
      expect(screen.queryAllByText("~/.config/htop/")).toEqual([]);
      // One row only — the discriminating assertion: filtering the absolute
      // `insert` would render TWO (the path is a strict superset of the name).
      const picker = screen.getByTestId("mention-picker");
      expect(picker.querySelectorAll("button")).toHaveLength(1);
    });

  it("typing inside ONE directory derives ONE dirPrefix, so the directory is fetched once",
    async () => {
      seedLiveSession();
      // A CATCH-ALL payload — the SAME rows for every query — on purpose: the
      // point of this test is the CALL COUNT, so the rows must render under a
      // WRONG derivation too. Keyed on the directory like the other tests, a
      // mutant that fetched `~/.config/ht` would have no rows for that key and
      // this would redden on a `rowByPrimary` before it ever reached the
      // assertion that carries the claim.
      vi.mocked(listCompletionEntries).mockImplementation(() =>
        Promise.resolve({
          entries: [
            {
              name: "htop",
              insert: "/home/u/.config/htop",
              display: "~/.config/htop",
              isDir: true,
            },
          ],
          truncated: false,
        }),
      );
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // ONE change event for the whole token — NOT character by character:
      // per-keystroke typing legitimately fetches `~/` then `~/.config/`, and
      // the count would then redden for a reason unrelated to the bug.
      fireEvent.change(textarea, { target: { value: "?~/.config/ht" } });
      await rowByPrimary("~/.config/htop/");
      // The DERIVATION is the thing under test: the remainder up to and
      // INCLUDING the last `/`, so the cache key is the DIRECTORY. Keying the
      // cache on the whole remainder shows up here as `~/.config/ht` (MUTATION-
      // CHECKED: passing `activeRemainder` as the key reddens THIS assertion).
      expect(directoryFetches()).toEqual(["~/.config/"]);

      // A second keystroke INSIDE the same directory changes only the segment,
      // so the key is unchanged and NO new read happens.
      fireEvent.change(textarea, { target: { value: "?~/.config/htm" } });
      await flush();
      expect(directoryFetches()).toEqual(["~/.config/"]);
      // And the mount call is still the ONLY `null` one (the hook does call the
      // fetcher with `null` — pinning the total count would be wrong).
      expect(completionQueries().filter((q) => q === null)).toHaveLength(1);
    });

  it("a DIRECTORY row whose path is a Windows drive root leaves a token the grammar still recognises",
    async () => {
      seedLiveSession();
      routeCompletion({
        "C:/Users/you/": [
          {
            name: "proj",
            insert: "C:/Users/you/proj",
            display: "C:/Users/you/proj",
            isDir: true,
          },
        ],
        // Only reached if the kept-`?` token SURVIVED the drive-root insertion —
        // the whole reason the absolute shape admits `[A-Za-z]:/` (ADR 0035).
        "C:/Users/you/proj/": [
          {
            name: "src",
            insert: "C:/Users/you/proj/src",
            display: "C:/Users/you/proj/src",
            isDir: true,
          },
        ],
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?C:/Users/you/" } });
      // The row SHOWS the drive-rooted path verbatim (it is not under the home
      // directory, so `display` IS `insert`) with the directory `/`.
      expect(await rowByPrimary("C:/Users/you/proj/")).toBeTruthy();
      const value0 = (screen.getByRole("textbox") as HTMLTextAreaElement).value;
      textarea.setSelectionRange(value0.length, value0.length);
      fireEvent.keyDown(textarea, { key: "Enter" });
      const value = (screen.getByRole("textbox") as HTMLTextAreaElement).value;
      expect(value).toBe("?C:/Users/you/proj/");
      // The grammar property directly (jsdom on Linux can assert it because it
      // is a REGEX property, not a filesystem one): the inserted text is still
      // an active `?` token at the new caret.
      const token = activeMentionToken(value, value.length);
      expect(token).not.toBeNull();
      expect(token!.prefix).toBe("?");
      expect(token!.remainder).toBe("C:/Users/you/proj/");
      expect(isOutsideSpaceQuery(token!.remainder)).toBe(true);
      // And the picker is live one level deeper.
      expect(await rowByPrimary("C:/Users/you/proj/src/")).toBeTruthy();
    });

  it("a long path LABEL truncates instead of blowing the row apart, and carries the full text",
    async () => {
      // A 200-character Windows path is ONE unbreakable token, and the primary
      // line had no truncation on it: the badge is `shrink-0` and the label span
      // carried no `min-w-0` / `truncate`, while the container is
      // `overflow-y-auto` — which per CSS forces the visible x-axis to compute to
      // `auto`, so the row clipped or scrolled horizontally instead of eliding,
      // and the picker's `max-h-[calc(var(--ui-font-size)*22)]` clamp ("~10
      // single-line rows") stopped holding if such a row ever wrapped.
      //
      // WHAT THIS TEST CAN AND CANNOT SAY. jsdom has NO layout engine, so it can
      // observe no clipping, no ellipsis and no width: the elision itself is
      // CSS-reasoned and is NOT measured here. What is asserted is the two class
      // names that opt the span into `text-overflow: ellipsis` in a flex row, and
      // the `title` attribute — which is the user-visible half (the full path on
      // hover) and the only part of this a DOM test can read at all.
      seedLiveSession();
      const LONG =
        "/home/u/Downloads/archimedes-snapshots/2026-02-build-artifacts/" +
        "generated-client-sdks/rust-crates/".repeat(3) +
        "long-generated-module-name.rs";
      expect(LONG.length).toBeGreaterThan(150);
      routeCompletion({
        "/home/u/": [
          {
            name: "long-generated-module-name.rs",
            insert: LONG,
            display: LONG,
            isDir: false,
          },
        ],
      });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?/home/u/long-ge" },
      });
      const row = await rowByPrimary(LONG);
      const label = row.querySelector(".text-ui-base")!;
      // The label span: `min-w-0` is what lets a flex item shrink below its
      // content's intrinsic width, `truncate` is the overflow+ellipsis pair.
      // Without BOTH, one of the two failure modes (no shrink at all, or shrink
      // with no ellipsis) still clips.
      expect(label.className).toContain("min-w-0");
      expect(label.className).toContain("truncate");
      // And the FULL string is what the user needs on hover — the row shows a
      // clipped tail, so `title` is the only place the whole path exists.
      expect(label.getAttribute("title")).toBe(LONG);
      expect(label.textContent).toBe(LONG);
      // The badge is still `shrink-0` (it must never be the thing that gives
      // way) and carries no tooltip of its own, and the secondary line is still
      // absent for a `?` row — the ONE line a `?` row renders is unchanged.
      const badge = row.querySelector(".text-ui-xs")!;
      expect(badge.className).toContain("shrink-0");
      expect(badge.getAttribute("title")).toBeNull();
      expect(row.querySelector(".text-ui-sm")).toBeNull();
    });

  it("directories sort before files even when the name order would not",
    async () => {
      seedLiveSession();
      // The payload arrives FILES-FIRST: the renderer's own sort is what puts
      // the directory on top (a descending picker that buried the directories
      // would make a descent feel broken at exactly the moment it matters).
      routeCompletion({
        "~/.config/": [
          {
            name: "a_file.txt",
            insert: "/home/u/.config/a_file.txt",
            display: "~/.config/a_file.txt",
            isDir: false,
          },
          {
            name: "z_dir",
            insert: "/home/u/.config/z_dir",
            display: "~/.config/z_dir",
            isDir: true,
          },
        ],
      });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?~/.config/" },
      });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        expect(picker.querySelectorAll("button")).toHaveLength(2),
      );
      const labels = Array.from(
        picker.querySelectorAll(".text-ui-base"),
      ).map((el) => el.textContent);
      expect(labels).toEqual(["~/.config/z_dir/", "~/.config/a_file.txt"]);
    });

  it("the render cap never drops a DIRECTORY: the dirs sort last and there are more than 10",
    async () => {
      // THE INTERSECTION the cap test and the sort test both missed. The cap
      // test used 15 FILES (so there was no directory to lose) and the sort test
      // used 2 rows (so the slice never reached); the two never overlapped, and
      // slice-then-sort — which is exactly the failure the sort exists to
      // prevent — reddened NOTHING.
      //
      // The fixture is the hole: MORE entries than MAX_PICKER_ROWS, the payload
      // arriving in NAME ORDER with every FILE sorting before every DIRECTORY
      // (which is also what a case-folded directory listing gives on disk, so
      // this is the realistic shape, not a contrivance). Sorting first keeps a
      // directory inside the slice; slicing first throws every directory away and
      // the user cannot descend at all — a descent that "feels broken" precisely
      // in the directories whose names sort last.
      seedLiveSession();
      const files = Array.from({ length: 12 }, (_, i) => ({
        name: `a_file${String(i).padStart(2, "0")}.txt`,
        insert: `/home/u/.config/a_file${String(i).padStart(2, "0")}.txt`,
        display: `~/.config/a_file${String(i).padStart(2, "0")}.txt`,
        isDir: false,
      }));
      const dirs = ["zz_alpha", "zz_beta"].map((name) => ({
        name,
        insert: `/home/u/.config/${name}`,
        display: `~/.config/${name}`,
        isDir: true,
      }));
      routeCompletion({ "~/.config/": [...files, ...dirs] });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?~/.config/" },
      });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        expect(picker.querySelectorAll("button")).toHaveLength(10),
      );
      const labels = Array.from(
        picker.querySelectorAll(".text-ui-base"),
      ).map((el) => el.textContent);
      // Both directories survive the cap, and they are on TOP: 14 matches for a
      // 10-row cap, and the 12 files are the ones that get trimmed.
      expect(labels).toEqual([
        "~/.config/zz_alpha/",
        "~/.config/zz_beta/",
        "~/.config/a_file00.txt",
        "~/.config/a_file01.txt",
        "~/.config/a_file02.txt",
        "~/.config/a_file03.txt",
        "~/.config/a_file04.txt",
        "~/.config/a_file05.txt",
        "~/.config/a_file06.txt",
        "~/.config/a_file07.txt",
      ]);
      // Spelled out separately because THIS is the claim: a directory is
      // reachable at all. The full `labels` expectation above would also fail on
      // a wrong ORDER; this one fails only on a directory having been dropped.
      expect(labels.filter((l) => l!.endsWith("/"))).toEqual([
        "~/.config/zz_alpha/",
        "~/.config/zz_beta/",
      ]);
    });

  it("an outside completion caps at 10 rows and says the too-many-matches note",
    async () => {
      seedLiveSession();
      const entries = Array.from({ length: 15 }, (_, i) => ({
        name: `entry${i}.txt`,
        insert: `/home/u/.config/entry${i}.txt`,
        display: `~/.config/entry${i}.txt`,
        isDir: false,
      }));
      routeCompletion({ "~/.config/": entries });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?~/.config/entry" },
      });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        expect(picker.querySelectorAll("button")).toHaveLength(10),
      );
      // `matched` is the UNBOUNDED count, so the note survives the slice: drop
      // it from the outside branch and this note disappears entirely.
      expect(screen.getByTestId("mention-picker-note").textContent).toBe(
        "Too many matches — keep typing to narrow the list",
      );
    });

  it("the cap note for an outside completion reads the DIRECTORY's truncation, not the Space's",
    async () => {
      seedLiveSession();
      // The Space Listing is capped (its note string is the SAME one) while the
      // directory being completed is NOT: while the user is completing
      // somewhere else, the Space's cap must stay silent, because it says
      // nothing about the directory on screen.
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: true,
      });
      routeCompletion({
        "~/.config/": [
          {
            name: "htoprc",
            insert: "/home/u/.config/htoprc",
            display: "~/.config/htoprc",
            isDir: false,
          },
        ],
      });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?~/.config/ht" },
      });
      expect(await rowByPrimary("~/.config/htoprc")).toBeTruthy();
      // A `files.truncated || completion.truncated` implementation shows the
      // Space's note here and reddens this assertion.
      expect(screen.queryByTestId("mention-picker-note")).toBeNull();
    });

  it("a truncated DIRECTORY listing shows the cap note while the Space listing is whole",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: false,
      });
      routeCompletion(
        {
          "~/.config/": [
            {
              name: "htoprc",
              insert: "/home/u/.config/htoprc",
              display: "~/.config/htoprc",
              isDir: false,
            },
          ],
        },
        true,
      );
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?~/.config/ht" },
      });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        expect(picker.querySelectorAll("button")).toHaveLength(1),
      );
      const note = screen.getByTestId("mention-picker-note");
      // The SAME string as the Space arm (no new user-facing copy), because the
      // limitation is the same: a truncated-away entry is unreachable.
      expect(note.textContent).toBe(
        "Listing capped — some files may be missing",
      );
    });

  it("a relative ?query still offers the Space Listing rows and NEVER reads a directory",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md", "docs/plan.md"],
        truncated: false,
      });
      // Armed with rows that WOULD render: if the branch split leaked, they
      // would appear for a relative query too.
      routeCompletion({
        "~/.config/": [
          {
            name: "README.md",
            insert: "/home/u/.config/README.md",
            display: "~/.config/README.md",
            isDir: false,
          },
        ],
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?README" } });
      // The Listing row, by its Space-RELATIVE name, unchanged (ADR 0033).
      expect(await rowByPrimary("README.md")).toBeTruthy();
      textarea.setSelectionRange(7, 7);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "README.md ",
      );
      // NEVER entered the completion branch: the mount `null` call is the only
      // one, so no directory was read for a relative token.
      expect(directoryFetches()).toEqual([]);
    });

  // --- Enter during an IN-FLIGHT descent (ADR 0035 gap). --------------------
  //
  // Selecting a DIRECTORY row points `dirPrefix` at a directory whose rows are
  // not here yet, so for one IPC round trip the picker has ZERO rows — and the
  // row count is what gates the Enter intercept in `ComposerRow`. The natural
  // "Enter to descend, Enter to pick" therefore delivered `?/home/u/.config/
  // htop/` (sigil, absolute path, trailing slash) to the model, and it did so
  // PERMANENTLY for a directory that cannot be read (a failed fetch degrades to
  // the empty value). `pending` closes that window and nothing else: ADR 0033's
  // rule that a picker is never a gate is not widened to prose, only to the
  // in-flight window of a directory the user clicked into.

  it("Enter during an in-flight descent does NOTHING — no send, no insert",
    async () => {
      seedLiveSession();
      const htop = deferred<CompletionDirDto>();
      vi.mocked(listCompletionEntries).mockImplementation((query) =>
        query === "~/.config/"
          ? Promise.resolve({
              entries: [
                {
                  name: "htop",
                  insert: "/home/u/.config/htop",
                  display: "~/.config/htop",
                  isDir: true,
                },
              ],
              truncated: false,
            })
          : htop.promise,
      );
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?~/.config/ht" } });
      await rowByPrimary("~/.config/htop/");
      textarea.setSelectionRange(13, 13);
      fireEvent.keyDown(textarea, { key: "Enter" });
      // The descent happened (the token now names the new directory) and its
      // fetch is the one still outstanding.
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "?/home/u/.config/htop/",
      );
      expect(screen.queryByTestId("mention-picker")).toBeNull();
      // THE DEFECT: the second Enter used to fall through to `sendPrompt`.
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(sendPrompt).not.toHaveBeenCalled();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "?/home/u/.config/htop/",
      );
      // A third press is still swallowed — this is not a one-key grace period.
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(sendPrompt).not.toHaveBeenCalled();
      // Unwind the deferred promise so no pending fetch outlives the test.
      await act(async () => {
        htop.resolve({ entries: [], truncated: false });
      });
    });

  it("the Enter after an in-flight descent RESOLVES inserts the row that landed",
    async () => {
      seedLiveSession();
      const htop = deferred<CompletionDirDto>();
      vi.mocked(listCompletionEntries).mockImplementation((query) =>
        query === "~/.config/"
          ? Promise.resolve({
              entries: [
                {
                  name: "htop",
                  insert: "/home/u/.config/htop",
                  display: "~/.config/htop",
                  isDir: true,
                },
              ],
              truncated: false,
            })
          : htop.promise,
      );
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?~/.config/ht" } });
      await rowByPrimary("~/.config/htop/");
      textarea.setSelectionRange(13, 13);
      fireEvent.keyDown(textarea, { key: "Enter" });
      // Rows land: the picker is live on the new directory.
      await act(async () => {
        htop.resolve({
          entries: [
            {
              name: "htoprc",
              insert: "/home/u/.config/htop/htoprc",
              display: "~/.config/htop/htoprc",
              isDir: false,
            },
          ],
          truncated: false,
        });
      });
      const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
      await rowByPrimary("~/.config/htop/htoprc");
      // Caret at the END of the descended token (its length, not a literal that
      // goes stale if the fixture path changes length).
      ta.setSelectionRange(ta.value.length, ta.value.length);
      // Swallowed while pending, INSERTS once settled — the pre-fix keyboard
      // behaviour returns exactly, with no extra keystroke.
      fireEvent.keyDown(ta, { key: "Enter" });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "/home/u/.config/htop/htoprc ",
      );
      expect(sendPrompt).not.toHaveBeenCalled();
    });

  it("the Enter after a descent that resolves EMPTY sends, as it did before the fix",
    async () => {
      seedLiveSession();
      const htop = deferred<CompletionDirDto>();
      vi.mocked(listCompletionEntries).mockImplementation((query) =>
        query === "~/.config/"
          ? Promise.resolve({
              entries: [
                {
                  name: "htop",
                  insert: "/home/u/.config/htop",
                  display: "~/.config/htop",
                  isDir: true,
                },
              ],
              truncated: false,
            })
          : htop.promise,
      );
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?~/.config/ht" } });
      await rowByPrimary("~/.config/htop/");
      textarea.setSelectionRange(13, 13);
      fireEvent.keyDown(textarea, { key: "Enter" });
      await act(async () => {
        htop.resolve({ entries: [], truncated: false });
      });
      await flush();
      // An EMPTY directory is a settled one, not an in-flight one: nothing was
      // inserted before, and nothing is swallowed now.
      const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
      // Caret at the END of the descended token (its length, not a literal that
      // goes stale if the fixture path changes length).
      ta.setSelectionRange(ta.value.length, ta.value.length);
      fireEvent.keyDown(ta, { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "?/home/u/.config/htop/");
    });

  it("a descent into a directory whose fetch REJECTS does not swallow Enter forever",
    async () => {
      // The permanent form of the gap. A missing or unreadable directory has no
      // rows EVER (a failed fetch degrades to the empty value), so a `pending`
      // derived from "the rows have not arrived" would hold Enter down for good
      // in a directory the user clicked into. Rejection settles.
      seedLiveSession();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(listCompletionEntries).mockImplementation((query) =>
        query === "~/.config/"
          ? Promise.resolve({
              entries: [
                {
                  name: "htop",
                  insert: "/home/u/.config/htop",
                  display: "~/.config/htop",
                  isDir: true,
                },
              ],
              truncated: false,
            })
          : Promise.reject(new Error("unreadable dir")),
      );
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?~/.config/ht" } });
      await rowByPrimary("~/.config/htop/");
      textarea.setSelectionRange(13, 13);
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(errSpy).toHaveBeenCalled());
      await flush();
      const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
      // Caret at the END of the descended token (its length, not a literal that
      // goes stale if the fixture path changes length).
      ta.setSelectionRange(ta.value.length, ta.value.length);
      fireEvent.keyDown(ta, { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "?/home/u/.config/htop/");
      errSpy.mockRestore();
    });

  it("a RELATIVE ?query with no rows still sends on Enter while a completion fetch is in flight",
    async () => {
      // ADR 0033's "a picker is never a gate", RE-PINNED against the new flag
      // rather than rewritten by it: only the out-of-Space token's in-flight
      // window is held. `dirPrefix` is `null` for a relative query, so the flag
      // is false and the keydown must fall through to `sendPrompt` exactly as it
      // always did — the mount fetch is in flight on purpose, to catch a
      // `pending` derived from "any fetch" instead of "this directory's".
      seedLiveSession();
      const never = deferred<CompletionDirDto>();
      vi.mocked(listCompletionEntries).mockReturnValue(never.promise);
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?nada" } });
      await waitFor(() => expect(listCompletionEntries).toHaveBeenCalled());
      expect(screen.queryByTestId("mention-picker")).toBeNull();
      textarea.setSelectionRange(5, 5);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "?nada");
    });

  it("a stray ? in prose with no rows still sends on Enter (ADR 0033, unchanged)",
    async () => {
      // The prose half of the same guarantee, with the flag's new dependency
      // present: `x ? y` forms no token at all, so the keydown recompute closes
      // the picker and Enter sends. This test must stay green WITHOUT touching
      // the behaviour or the existing tests around it.
      seedLiveSession();
      const never = deferred<CompletionDirDto>();
      vi.mocked(listCompletionEntries).mockReturnValue(never.promise);
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "pick x ? y" } });
      await waitFor(() => expect(listCompletionEntries).toHaveBeenCalled());
      textarea.setSelectionRange(9, 9);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "pick x ? y");
    });

  it("the in-flight gate holds ONLY the token under the caret, never another ? token",
    async () => {
      // The gate reads BOTH the flag (which belongs to the OPEN picker's token)
      // and the token recomputed at the caret — and this test is what makes the
      // second half non-redundant. Draft `?nada ?/home/u/.config/htop/`: the
      // picker is open on the OUT-OF-SPACE token (its fetch is in flight) while
      // the caret sits on the RELATIVE `?nada`, which has no rows and no
      // dirPrefix of its own. ADR 0033's guarantee belongs to THAT token, so
      // Enter must send. A gate keyed on the flag alone would swallow it.
      seedLiveSession();
      const htop = deferred<CompletionDirDto>();
      vi.mocked(listCompletionEntries).mockImplementation((query) =>
        query === "~/.config/"
          ? Promise.resolve({
              entries: [
                {
                  name: "htop",
                  insert: "/home/u/.config/htop",
                  display: "~/.config/htop",
                  isDir: true,
                },
              ],
              truncated: false,
            })
          : htop.promise,
      );
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, {
        target: { value: "?nada ?~/.config/ht" },
      });
      await rowByPrimary("~/.config/htop/");
      textarea.setSelectionRange(19, 19);
      fireEvent.keyDown(textarea, { key: "Enter" });
      const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(ta.value).toBe("?nada ?/home/u/.config/htop/");
      // Caret onto the RELATIVE token (a click, which fires no `onChange`, so the
      // picker state still describes the out-of-Space token and its fetch is
      // still in flight).
      ta.setSelectionRange(5, 5);
      fireEvent.keyDown(ta, { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith(
        "s1",
        "?nada ?/home/u/.config/htop/",
      );
      await act(async () => {
        htop.resolve({ entries: [], truncated: false });
      });
    });

  it("Shift+Enter is never swallowed by the in-flight gate",
    async () => {
      // `Shift+Enter` is a NEWLINE, not a send — and the in-flight gate must not
      // intercept it (that would eat the newline while the picker is blank).
      // The gate is `Enter && !shiftKey`, exactly like the send branch.
      seedLiveSession();
      const htop = deferred<CompletionDirDto>();
      vi.mocked(listCompletionEntries).mockImplementation((query) =>
        query === "~/.config/"
          ? Promise.resolve({
              entries: [
                {
                  name: "htop",
                  insert: "/home/u/.config/htop",
                  display: "~/.config/htop",
                  isDir: true,
                },
              ],
              truncated: false,
            })
          : htop.promise,
      );
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?~/.config/ht" } });
      await rowByPrimary("~/.config/htop/");
      textarea.setSelectionRange(13, 13);
      fireEvent.keyDown(textarea, { key: "Enter" });
      const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
      // Caret at the END of the descended token (its length, not a literal that
      // goes stale if the fixture path changes length).
      ta.setSelectionRange(ta.value.length, ta.value.length);
      const handled = fireEvent.keyDown(ta, {
        key: "Enter",
        shiftKey: true,
      });
      // `fireEvent` returns false only when a handler called `preventDefault`.
      expect(handled).toBe(true);
      expect(sendPrompt).not.toHaveBeenCalled();
      await act(async () => {
        htop.resolve({ entries: [], truncated: false });
      });
    });

  // --- A directory whose NAME contains a space stays DESCENDABLE ------------
  //
  // `dirPrefix` is the catalog's CACHE KEY and therefore the ONE directory the
  // renderer reads, and it is derived as the remainder up to and INCLUDING its
  // last `/` — over the WHOLE remainder, spaces included. That rule exists
  // because a DIRECTORY row inserts its absolute path VERBATIM, so clicking the
  // row for a directory named `Application Support` leaves a token naming
  // `/home/u/Library/Application Support/`. Cut that token at its first space
  // instead — the rule this branch tried (`2562452`, reverted here) because a
  // `/` in trailing prose would then extend the read — and that token's
  // `dirPrefix` becomes `/home/u/Library/`: the rows come from the directory
  // BEFORE the spaced name, match nothing the user is typing towards, and the
  // spaced directory cannot be descended into by clicking AT ALL. ADR 0035
  // admits spaces precisely so `~/Library/Application Support` is reachable, so
  // that is the case that decides the trade; the prose case it costs is pinned
  // AS A COST in `THE COST WE ACCEPT: a `/` in trailing PROSE reads a directory
  // that cannot exist` below, and in `dirPartOfOutsideQuery` in `skills.ts`.
  it("selecting a DIRECTORY row whose NAME contains a space reads THAT directory",
    async () => {
      seedLiveSession();
      routeCompletion({
        "~/Library/": [
          {
            name: "Application Support",
            insert: "/home/u/Library/Application Support",
            display: "~/Library/Application Support",
            isDir: true,
          },
        ],
        // The directory the FIRST-SPACE rule reads instead. It gets a row of
        // its own so this test cannot pass by accident: a derivation that cuts
        // at the space fetches THIS key, and the assertion below then names the
        // wrong directory rather than merely coming up short.
        "/home/u/Library/": [
          {
            name: "Preferences",
            insert: "/home/u/Library/Preferences",
            display: "~/Library/Preferences",
            isDir: true,
          },
        ],
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?~/Library/" } });
      const row = await rowByPrimary("~/Library/Application Support/");
      textarea.focus();
      // The caret at the END of the token that was just completed (the length of
      // `?~/Library/`), so the splice below replaces the whole token.
      textarea.setSelectionRange(11, 11);
      fireEvent.mouseDown(row);
      // The kept-`?` token is the SPACED absolute path with a trailing `/`.
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "?/home/u/Library/Application Support/",
      );
      await flush();
      // THE ASSERTION THAT CARRIES THE CLAIM: the second read is the SPACED
      // DIRECTORY, with its trailing `/`, and not the directory before the
      // space. Cutting the token at its first space shows up here as
      // `/home/u/Library/` (mutation-checked).
      expect(directoryFetches()).toEqual([
        "~/Library/",
        "/home/u/Library/Application Support/",
      ]);
      expect(directoryFetches()).not.toContain("/home/u/Library/");
    });

  it("…and the rows that render are THAT directory's own, so the descent continues",
    async () => {
      // The sibling of the test above, and the one a user would feel: cutting at
      // the first space does not merely fetch the wrong path, it renders the
      // WRONG DIRECTORY — the children of `~/Library/` shown while the token
      // says `Application Support/`, which is worse than showing nothing. Here
      // the spaced directory's own rows appear, and clicking one descends a
      // THIRD level, so descent through spaced names is demonstrably intact.
      seedLiveSession();
      routeCompletion({
        "~/Library/": [
          {
            name: "Application Support",
            insert: "/home/u/Library/Application Support",
            display: "~/Library/Application Support",
            isDir: true,
          },
        ],
        "/home/u/Library/Application Support/": [
          {
            name: "Font Book",
            insert: "/home/u/Library/Application Support/Font Book",
            display: "~/Library/Application Support/Font Book",
            isDir: true,
          },
        ],
        "/home/u/Library/Application Support/Font Book/": [
          {
            name: "settings.plist",
            insert: "/home/u/Library/Application Support/Font Book/settings.plist",
            display: "~/Library/Application Support/Font Book/settings.plist",
            isDir: false,
          },
        ],
        // The wrong directory, with a row that is UNMISTAKABLY not the spaced
        // directory's: rendering it is the symptom of the reversed rule.
        "/home/u/Library/": [
          {
            name: "Preferences",
            insert: "/home/u/Library/Preferences",
            display: "~/Library/Preferences",
            isDir: true,
          },
        ],
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?~/Library/" } });
      const row = await rowByPrimary("~/Library/Application Support/");
      textarea.focus();
      textarea.setSelectionRange(11, 11);
      fireEvent.mouseDown(row);
      await flush();
      // THE SYMPTOM the reversed rule produced, asserted FIRST so a red test
      // NAMES it: the children of `/home/u/Library/` were on screen while the
      // token said `Application Support/`. A timeout on the row below would say
      // "no rows", which is the wrong diagnosis — the wrong rows are the bug.
      expect(screen.queryAllByText("~/Library/Preferences/")).toEqual([]);

      // LEVEL 2: the spaced directory's OWN row, not its parent's.
      const fontBook = await rowByPrimary(
        "~/Library/Application Support/Font Book/",
      );
      // LEVEL 3: descend again, through the second spaced name.
      const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      fireEvent.mouseDown(fontBook);
      expect(
        await rowByPrimary(
          "~/Library/Application Support/Font Book/settings.plist",
        ),
      ).toBeTruthy();
      expect(directoryFetches()).toEqual([
        "~/Library/",
        "/home/u/Library/Application Support/",
        "/home/u/Library/Application Support/Font Book/",
      ]);
    });

  // --- THE COST OF THAT RULE, PINNED AS A COST: prose with a `/` in it. ------
  //
  // `dirPrefix` is the catalog's CACHE KEY and therefore the ONE directory the
  // renderer reads, and it is "up to the last `/` of the WHOLE remainder".
  // Because the out-of-Space token admits SPACES, prose typed after an absolute
  // path is absorbed into the remainder, and a `/` sitting in that prose extends
  // the key: `?~/notes/ see src/x` issues ONE REAL READ for `~/notes/ see src/`,
  // a directory that exists only because the sentence did.
  //
  // THIS IS A CHOICE, NOT A NON-EVENT, and it was made deliberately: the
  // alternative — cutting at the first space — makes a directory whose NAME
  // contains a space undescentable (pinned by the two tests above), which is the
  // case ADR 0035 admits spaces FOR. Both readings are the same string shape, so
  // no frontend rule separates them. What the prose case costs is exactly one
  // wasted directory read, an empty picker, and one Enter held for that round
  // trip (`560f610`) — pinned below, in those terms, so nobody has to rediscover
  // it from a profile trace.
  it("THE COST WE ACCEPT: a `/` in trailing PROSE reads a directory that cannot exist",
    async () => {
      seedLiveSession();
      // `~/notes/` HAS rows in this table and `~/notes/ see src/` does not, so
      // the read that goes to the prose-extended key shows up as an EMPTY picker
      // rather than as an uninteresting pass: the directory the draft names is
      // real here, and the one the code asks for is the impossible one.
      routeCompletion({
        "~/notes/": [
          {
            name: "todo.md",
            insert: "/home/u/notes/todo.md",
            display: "~/notes/todo.md",
            isDir: false,
          },
        ],
      });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?~/notes/ see src/x" },
      });
      await flush();
      // THE COST, IN ONE LINE: one real read, for a directory that cannot exist.
      // (The rule this replaced would have read `~/notes/`; the row above is
      // deliberately unreachable now — that is the trade.)
      expect(directoryFetches()).toEqual(["~/notes/ see src/"]);
      // It returns empty, so nothing renders and the rows of the directory the
      // draft ACTUALLY names are not offered.
      expect(screen.queryByTestId("mention-picker")).toBeNull();
    });

  it("…and that impossible read holds Enter for ONE round trip, then sends", async () => {
    // The other half of the cost, which is the part a reader is most likely to
    // call harmless: an empty result is still a FETCH, and `560f610` made Enter
    // wait for an in-flight directory read. So the prose draft does not send
    // instantly — Enter is swallowed once, exactly as it is for a real descent
    // that has not landed yet. Cheap, but not free; that is the honest shape of
    // the cost accepted above.
    seedLiveSession();
    const proseDir = deferred<CompletionDirDto>();
    // Every directory read in this test is the prose-extended one, so ONE
    // deferred promise covers it: the mount call (`null`, no directory) resolves
    // at once and the read for `~/notes/ see src/` is the one held open.
    vi.mocked(listCompletionEntries).mockImplementation((query) =>
      query === null
        ? Promise.resolve({ entries: [], truncated: false })
        : proseDir.promise,
    );
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "?~/notes/ see src/x" } });
    expect(directoryFetches()).toEqual(["~/notes/ see src/"]);
    // Still in flight: Enter is HELD (no send), because rows might still land.
    // The caret is the token's LENGTH, not a literal that goes stale if the
    // fixture path changes.
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
    // The read resolves EMPTY — it cannot exist — and the next Enter sends the
    // draft verbatim, which is the pre-`560f610` behaviour restored.
    await act(async () => {
      proseDir.resolve({ entries: [], truncated: false });
    });
    await flush();
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(sendPrompt).toHaveBeenCalledWith("s1", "?~/notes/ see src/x");
  });

  it("the paid-for half: a directory NAME containing a space is never cut",
    async () => {
      // The REWRITE of the pin that used to live here, which recorded the OPPOSITE
      // rule (`?~/Library/Application Support/Font Book` reading `~/Library/`) as
      // an accepted cost. That cost has been paid back: the spaced-directory
      // descent it destroyed is what decided the reversal (see the two tests
      // above), so this test now pins the hand-typed half of the new rule — the
      // half a user reaches by TYPING rather than clicking.
      seedLiveSession();
      routeCompletion({
        "~/Library/Application Support/": [
          {
            name: "Font Book",
            insert: "/home/u/Library/Application Support/Font Book",
            display: "~/Library/Application Support/Font Book",
            isDir: true,
          },
        ],
      });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?~/Library/Application Support/Font" },
      });
      // The read is the SPACED directory, and the row it offers is the one the
      // user is typing towards. Under the reversed rule the key was `~/Library/`
      // and this row did not exist.
      expect(
        await rowByPrimary("~/Library/Application Support/Font Book/"),
      ).toBeTruthy();
      expect(directoryFetches()).toEqual(["~/Library/Application Support/"]);
    });

  // --- An ABSORBED PROSE TAIL can match a real row (ADR 0035's accepted cost).
  //
  // The out-of-Space token admits SPACES, so prose typed after an absolute token
  // is absorbed into the query until a newline, and the absorbed text lands
  // INSIDE the segment the rows are filtered on. The matcher there is a
  // SUBSEQUENCE, so the directory's contents decide whether anything matches —
  // the safety has never been "an absorbed tail cannot match". Usually nothing
  // does, because the tail makes the segment longer than any entry name. This is
  // the counterexample: a directory holding `todo list of items.md`, and a draft
  // that names the directory plus a prose word. One row is offered, Enter
  // INSERTS it, and the prose is gone with the token.
  //
  // ACCEPTED: what it costs is an edit to the user's own draft, not a policy
  // change — nothing is sent that the user did not have on screen, the inserted
  // text is the real absolute path of a real file, and refusing spaces to
  // prevent it would refuse `~/Library/Application Support`. Pinned so the cost
  // stays a decision rather than becoming a surprise.
  it("an absorbed prose tail DOES match a row when the directory holds a name that contains it",
    async () => {
      seedLiveSession();
      routeCompletion({
        "~/notes/": [
          {
            name: "todo list of items.md",
            insert: "/home/u/notes/todo list of items.md",
            display: "~/notes/todo list of items.md",
            isDir: false,
          },
          {
            name: "htoprc",
            insert: "/home/u/notes/htoprc",
            display: "~/notes/htoprc",
            isDir: false,
          },
        ],
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // `?~/notes/` then the PROSE `list of items` — one token, absorbed.
      fireEvent.change(textarea, {
        target: { value: "?~/notes/ list of items" },
      });
      await rowByPrimary("~/notes/todo list of items.md");
      const picker = screen.getByTestId("mention-picker");
      // Exactly ONE row: `htoprc` does not contain that subsequence, so this is
      // the absorbed tail matching, not the picker ignoring the needle.
      expect(picker.querySelectorAll("button")).toHaveLength(1);
      // The read is `~/notes/` because the last `/` of the WHOLE remainder is
      // the one after `notes` — this prose tail happens to carry no `/` of its
      // own, which is the ONLY reason the absorbed prose leaves the key alone.
      // Give it one and the key extends with it (that cost is pinned in
      // `THE COST WE ACCEPT: a `/` in trailing PROSE reads a directory that
      // cannot exist`, above). Do not read this assertion as "prose never moves
      // the directory": it does, whenever it contains a `/`.
      expect(directoryFetches()).toEqual(["~/notes/"]);
      const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
      ta.setSelectionRange(ta.value.length, ta.value.length);
      fireEvent.keyDown(ta, { key: "Enter" });
      // THE COST, OBSERVED: the path is inserted and the prose is GONE — the
      // whole token was replaced, tail included.
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "/home/u/notes/todo list of items.md ",
      );
      expect(sendPrompt).not.toHaveBeenCalled();
    });

  // --- A completed path can carry a LIVE Mention (ADR 0033's own argument). --
  //
  // An out-of-Space path admits SPACES, so a filename may contain ` @name`, and
  // a `@` preceded by whitespace is a legitimate Mention trigger wherever it
  // sits — including mid-path. Completing a file named `notes @scout.md`
  // therefore puts trigger text into the draft, and a later send expands it.
  //
  // THIS IS INTENDED AND IT IS NOT A CAPABILITY GAIN. A user who hand-typed the
  // identical draft got the byte-identical expansion, which is ADR 0033's own
  // argument, and the exact-name catalog gate still holds (a name that is not in
  // the catalog stays verbatim, and ADR 0031's tag-safety argument rests on that
  // exact match, so nothing about the block's shape is reachable from a
  // filename). What is NEW is the SOURCE of the trigger text: out-of-Space
  // completion makes OTHER PEOPLE'S filenames a way to put a Mention into your
  // draft (`~/Downloads`, a cloned repo). That is why this is pinned rather than
  // left to the unit test in `skills.test.ts` — the pin below shows the whole
  // path from a clicked row to an expanded block, and it is the pin that forces a
  // future change here to be a decision.
  it("a completed path containing ' @<catalog agent name>' DOES expand that Mention on send",
    async () => {
      seedLiveSession();
      // The catalog agent the inserted trigger names. The gate is EXACT-NAME:
      // with no such agent the draft would be sent byte-identical.
      vi.mocked(listAgentDefinitionsForSpace).mockResolvedValue([
        { name: "scout", description: "Fast recon.", model: null, scope: "user" },
      ]);
      routeCompletion({
        "/home/u/w/": [
          {
            name: "notes @scout.md",
            insert: "/home/u/w/notes @scout.md",
            display: "/home/u/w/notes @scout.md",
            isDir: false,
          },
        ],
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?/home/u/w/notes" } });
      const row = await rowByPrimary("/home/u/w/notes @scout.md");
      textarea.focus();
      textarea.setSelectionRange(17, 17);
      fireEvent.mouseDown(row);
      // The insertion is VERBATIM, spaces and `@` included — `selectMention` has
      // no rule about a `@` inside a path, and cannot have one without rewriting
      // a path that is a real filename.
      const draft = (screen.getByRole("textbox") as HTMLTextAreaElement).value;
      expect(draft).toBe("/home/u/w/notes @scout.md ");
      // The picker is closed (a FILE row consumes the trigger), so this Enter is
      // an ordinary send of a draft that now contains trigger text.
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledTimes(1);
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1];
      // OBSERVED AND INTENDED: the draft expanded a real `<agent>` block for the
      // ` @scout` that arrived inside somebody else's filename.
      expect(sent.startsWith(draft.trim())).toBe(true);
      expect(sent).toContain('<agent name="scout">');
      expect(sent).toContain('Dispatch a subagent with agentName "scout"');
    });

  it("…and the SAME path with no whitespace before the @ expands NOTHING (the gate is the grammar)",
    async () => {
      // The discriminating half, so the pin above is not "any `@` anywhere in a
      // path fires": `AGENT_MENTION_RE` requires `(^|\s)` before the glyph. A
      // file named `notes@scout.md` inserts trigger-looking text that the grammar
      // cannot see, and the draft goes out byte-identical.
      seedLiveSession();
      vi.mocked(listAgentDefinitionsForSpace).mockResolvedValue([
        { name: "scout", description: "Fast recon.", model: null, scope: "user" },
      ]);
      routeCompletion({
        "/home/u/w/": [
          {
            name: "notes@scout.md",
            insert: "/home/u/w/notes@scout.md",
            display: "/home/u/w/notes@scout.md",
            isDir: false,
          },
        ],
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?/home/u/w/notes" } });
      const row = await rowByPrimary("/home/u/w/notes@scout.md");
      textarea.setSelectionRange(17, 17);
      fireEvent.mouseDown(row);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith(
        "s1",
        "/home/u/w/notes@scout.md",
      );
      expect(vi.mocked(sendPrompt).mock.calls[0]![1]).not.toContain("<agent");
    });

  it("a path-shaped relative query still filters by subsequence and reads no directory",
    async () => {
      // The regression pin on the branch split for the OTHER shape:
      // `?src/comp/Form` is relative, so it stays on the Space Listing.
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["src/components/Formula.tsx", "README.md"],
        truncated: false,
      });
      routeCompletion({
        "src/": [
          {
            name: "Formula.tsx",
            insert: "/home/u/proj/src/Formula.tsx",
            display: "/home/u/proj/src/Formula.tsx",
            isDir: false,
          },
        ],
      });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?src/comp/Form" },
      });
      expect(await rowByPrimary("src/components/Formula.tsx")).toBeTruthy();
      expect(screen.queryAllByText("README.md")).toEqual([]);
      expect(directoryFetches()).toEqual([]);
    });

  // --- THE PICKER'S TWO FILTERS, driven through the real picker. -----------
  //
  // This group REPLACES the source-reading pin that used to live at the bottom
  // of `src/lib/skills.test.ts`: it lifted the picker's predicates out of
  // `ChatStream.tsx` with `readFileSync` + `new Function` and evaluated them,
  // which made behaviour-preserving edits (a local rename, extracting the
  // predicate into a named function, a comment that named `fuzzyMatch(`) redden
  // tests that had nothing to do with filters — including one failure mode that
  // threw at module scope and took the whole 119-test file down to ZERO tests
  // run. Its unique detection value was nil: every mutation it caught was caught
  // elsewhere too. What it existed to defend is the guarantee below, and that
  // guarantee IS a behaviour, so it is pinned here by driving the component the
  // way a user drives it.
  //
  // THE GUARANTEE: the picker is SHARED, the filters are not. The three
  // **Mention** prefixes (`$` skills / `@` agents / `#` MCP servers) filter on a
  // case-insensitive name SUBSTRING; BOTH `?` arms — the Space **Listing** and
  // out-of-Space **Directory completion** — filter with `fuzzyMatch`, a
  // SUBSEQUENCE, because a path query is path-shaped (`src/comp/Form` must reach
  // `src/components/Formula.tsx`). A substring is a special case of a subsequence
  // so unifying them would break no existing query, and it was still refused:
  // `sm` would start matching `skill-manager` and every Mention list would get
  // looser and noisier. Read a red test below as "this side's filter changed",
  // NOT as "the test needs updating" — which is why each side is asserted on its
  // own, with a named message, rather than in one shared expectation.
  //
  // THE FIXTURE. Two names, doing two different jobs:
  //   • `skill-manager` DISCRIMINATES: the needle `sm` is a SUBSEQUENCE of it
  //     (`s`kill-`m`anager) and is NOT a substring of it, so the two filters give
  //     OPPOSITE answers on it.
  //   • `deploy` is the CONTROL that keeps the negative assertion honest. A
  //     substring hit is ALWAYS also a subsequence hit, so no single name can
  //     discriminate for both filters under one needle — hence two needles. `dep`
  //     is a substring of `deploy`, so BOTH filters must offer it, and every
  //     negative assertion below FIRST watches that control row appear on the same
  //     prefix and only then swaps the needle and watches it vanish. Without that,
  //     "no rows for `sm`" would be indistinguishable from "the catalog never
  //     loaded" — the classic way a filter pin goes green while testing nothing.
  describe("the picker's two filters (substring for Mentions, subsequence for both ? arms)", () => {
    /** The name the two filters SPLIT on: `sm` reaches it only as a subsequence. */
    const DISCRIMINATING_NAME = "skill-manager";
    /** A SUBSEQUENCE-only needle on `DISCRIMINATING_NAME`. */
    const SUBSEQUENCE_ONLY_NEEDLE = "sm";
    /** The control: `dep` is a SUBSTRING of it, so both filters must hit it. */
    const CONTROL_NAME = "deploy";
    const CONTROL_NEEDLE = "dep";
    /** The one directory the out-of-Space arm is driven against. Its rows SHOW
     *  the absolute path (that is what an out-of-Space row displays), which is
     *  why the expected primary line is spelled out per arm below. */
    const DIR = "/home/u/dir/";

    /** Seed all FOUR catalogs with the same two names — plus an UPPERCASED
     *  variant of the control, which is the only way to reach the CASE side of
     *  either filter from the keyboard: a Mention NEEDLE cannot contain an
     *  uppercase letter (`[$#@][a-z0-9-]*` will not form a token), so
     *  case-insensitivity is only reachable through a catalog NAME whose case
     *  differs from the needle. */
    function seedDiscriminatingCatalogs(): void {
      const skill = (name: string) => ({
        name,
        description: "D",
        path: `/s/.agents/skills/${name}/SKILL.md`,
        dir: `/s/.agents/skills/${name}`,
        scope: "space" as const,
        body: "B",
        disableModelInvocation: false,
        shadowed: [],
      });
      vi.mocked(listSkills).mockResolvedValue([
        skill(DISCRIMINATING_NAME),
        skill(CONTROL_NAME),
        skill("Deploy"),
      ]);
      vi.mocked(listAgentDefinitionsForSpace).mockResolvedValue([
        { name: DISCRIMINATING_NAME, description: "D", model: null, scope: "user" },
        { name: CONTROL_NAME, description: "C", model: null, scope: "user" },
        { name: "Deploy", description: "U", model: null, scope: "user" },
      ]);
      vi.mocked(listMcpServersEffective).mockResolvedValue([
        { name: DISCRIMINATING_NAME, kind: "stdio", summary: "D" },
        { name: CONTROL_NAME, kind: "stdio", summary: "C" },
        { name: "Deploy", kind: "stdio", summary: "U" },
      ]);
      // The Listing rows are Space-RELATIVE names verbatim, and `deploy` /
      // `Deploy` are BOTH offered by `dep` (it is a substring and a subsequence
      // of each), so the Listing's expected set is the pair.
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: [DISCRIMINATING_NAME, CONTROL_NAME, "Deploy"],
        truncated: false,
      });
      // The completion rows carry only the two discriminating names: the case
      // side is pinned on the Mention and Listing sides, where an out-of-Space
      // row's `display` rewrite cannot blur which filter answered.
      routeCompletion({
        [DIR]: [
          {
            name: DISCRIMINATING_NAME,
            insert: `${DIR}${DISCRIMINATING_NAME}`,
            display: `${DIR}${DISCRIMINATING_NAME}`,
            isDir: false,
          },
          {
            name: CONTROL_NAME,
            insert: `${DIR}${CONTROL_NAME}`,
            display: `${DIR}${CONTROL_NAME}`,
            isDir: false,
          },
        ],
      });
    }

    /** The PRIMARY lines the picker currently renders (empty when it is closed —
     *  "no picker" IS the answer a substring filter gives for `sm`). */
    function primaryLines(): string[] {
      const picker = screen.queryByTestId("mention-picker");
      return picker
        ? Array.from(picker.querySelectorAll(".text-ui-base")).map(
            (el) => el.textContent!,
          )
        : [];
    }

    /** Type `value` and wait until the picker shows `waitFor` — the control row
     *  that proves this prefix renders AT ALL. Without that wait a "no rows yet"
     *  render would satisfy every negative assertion in this group. */
    async function typeAndWait(
      textarea: HTMLTextAreaElement,
      value: string,
      waitFor: string,
    ): Promise<void> {
      fireEvent.change(textarea, { target: { value } });
      await waitForRows(waitFor);
    }

    async function waitForRows(text: string): Promise<void> {
      await waitFor(() => expect(primaryLines()).toContain(text));
    }

    it("a Mention filter is a SUBSTRING: it offers the control, never the subsequence-only name",
      async () => {
        seedLiveSession();
        seedMcpMentionsOn();
        seedDiscriminatingCatalogs();
        render(<ChatStream />);
        const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
        for (const prefix of ["$", "@", "#"] as const) {
          // (a) the control appears, so this prefix's catalog is live and
          // rendering — the negative half below now means something. (`Deploy`
          // is a substring hit on `dep` too.)
          await typeAndWait(textarea, `${prefix}${CONTROL_NEEDLE}`, CONTROL_NAME);
          expect(primaryLines(), `${prefix}${CONTROL_NEEDLE}`).toEqual([
            CONTROL_NAME,
            "Deploy",
          ]);
          // (b) the discriminating needle: a substring filter offers NOTHING, a
          // `fuzzyMatch` would offer `skill-manager`. Asserted SYNCHRONOUSLY
          // after the change — the line above proved rows WERE rendered a moment
          // ago, and `fireEvent.change` is `act`-wrapped, so an empty list here
          // is the re-derivation's answer and not a render that has not landed.
          // Named per prefix, so a failure says WHICH catalog drifted.
          fireEvent.change(textarea, {
            target: { value: `${prefix}${SUBSEQUENCE_ONLY_NEEDLE}` },
          });
          expect(
            primaryLines(),
            `the ${prefix} catalog matched "${SUBSEQUENCE_ONLY_NEEDLE}" — its filter is no longer a substring`,
          ).toEqual([]);
        }
      });

    it("a Mention filter keeps EVERY substring hit and is case-INSENSITIVE on the catalog side",
      async () => {
        // The other half of "substring, unchanged": no MORE than substring (the
        // test above), and no LESS. `Deploy` is the case probe — reachable only
        // from the catalog side, because the Mention grammar will not form an
        // uppercase NEEDLE token at all.
        seedLiveSession();
        seedMcpMentionsOn();
        seedDiscriminatingCatalogs();
        render(<ChatStream />);
        const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
        // Each needle is a substring of exactly one fixture name, so the
        // expected row set is derived from the fixture, not restated by hand.
        // `deploy` and `Deploy` are BOTH substring hits on `ploy`, which is the
        // case-insensitive half: the NEEDLE side cannot be uppercase at all (the
        // Mention grammar forms no token for `$DEP`), so case-insensitivity is
        // only observable through a catalog NAME whose case differs.
        for (const [needle, expected] of [
          ["skill-man", [DISCRIMINATING_NAME]],
          ["ll-manager", [DISCRIMINATING_NAME]],
          ["ploy", [CONTROL_NAME, "Deploy"]],
          ["de", [CONTROL_NAME, "Deploy"]],
        ] as const) {
          for (const prefix of ["$", "@", "#"] as const) {
            await typeAndWait(textarea, `${prefix}${needle}`, expected[0]!);
            expect(primaryLines(), `${prefix}${needle}`).toEqual([...expected]);
          }
        }
      });

    it("the SPACE LISTING arm of ? is a SUBSEQUENCE: `sm` reaches what the Mentions refused",
      async () => {
        seedLiveSession();
        seedDiscriminatingCatalogs();
        render(<ChatStream />);
        const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
        await typeAndWait(textarea, `?${CONTROL_NEEDLE}`, CONTROL_NAME);
        expect(primaryLines()).toEqual([CONTROL_NAME, "Deploy"]);
        fireEvent.change(textarea, {
          target: { value: `?${SUBSEQUENCE_ONLY_NEEDLE}` },
        });
        await waitForRows(DISCRIMINATING_NAME);
        // The needle the Mention side refused, ACCEPTED — that is the split.
        // (`deploy`/`Deploy` correctly drop out: `s` is not in either.)
        expect(primaryLines()).toEqual([DISCRIMINATING_NAME]);
        // And it never left the Space: no directory was read for a relative `?`.
        expect(directoryFetches()).toEqual([]);
      });

    it("the OUT-OF-SPACE arm of ? is a SUBSEQUENCE too (its own predicate, its own pin)",
      async () => {
        // The second `?` arm filters a DIFFERENT shape (`e.name`, not the row's
        // `r.name`), so it is a separate predicate and needs its own assertion:
        // an implementation that made one arm a substring and left the other
        // loose would pass a one-arm test.
        seedLiveSession();
        seedDiscriminatingCatalogs();
        render(<ChatStream />);
        const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
        await typeAndWait(textarea, `?${DIR}${CONTROL_NEEDLE}`, `${DIR}${CONTROL_NAME}`);
        expect(primaryLines()).toEqual([`${DIR}${CONTROL_NAME}`]);
        fireEvent.change(textarea, {
          target: { value: `?${DIR}${SUBSEQUENCE_ONLY_NEEDLE}` },
        });
        await waitForRows(`${DIR}${DISCRIMINATING_NAME}`);
        expect(primaryLines()).toEqual([`${DIR}${DISCRIMINATING_NAME}`]);
        // It really did go OUT of the Space, so this cannot be the Listing arm
        // having answered twice: the Listing's `skill-manager` row (the bare
        // name) is not on screen, and exactly ONE directory was read.
        expect(screen.queryAllByText(DISCRIMINATING_NAME)).toEqual([]);
        expect(directoryFetches()).toEqual([DIR]);
      });
  });
});
