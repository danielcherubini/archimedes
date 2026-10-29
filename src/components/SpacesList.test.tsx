import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import {
  cancelSession,
  closeSession,
  deleteSession,
  getSettings,
  listAgentConfig,
  listSkills,
  reorderSessions,
  saveSettings,
  setSessionArchived,
  startSession,
  type AgentConfigDto,
  type AppSettings,
} from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { useSettings } from "../store/settings";
import { usePermissions } from "../store/permissions";
import { useInteractive } from "../store/interactive";
import {
  getLeftPaneCollapsed,
  LEFT_PANE_RAIL,
  setLeftPaneCollapsed,
} from "../lib/leftPaneState";
import {
  getNewSpaceDialogOpen,
  setNewSpaceDialogOpen,
} from "../lib/newSpaceDialogState";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearAgentCatalogCache } from "../hooks/useAgentCatalog";
import {
  makeMessage,
  makeSessionRow,
  makeSettings,
  makeSpaceRow,
} from "../test/fixtures";
import { resetModuleFlags, resetStores } from "../test/resetStores";
import SpacesList from "./SpacesList";
import { SessionListRow } from "./SessionListRow";

/**
 * The settings document the STORE is seeded with (see the `beforeEach` below).
 *
 * The shared `makeSettings()` fixture (Task B4a), with the ONE field this file
 * overrides: `defaultModel` is `"stale/model"` here because the read-modify-write
 * test below makes the RE-READ return a different value, which is what proves the
 * save composes from the fresh document and not from this copy.
 *
 * TYPED as `AppSettings` through the fixture, which is the point of it: the
 * `getSettings` mock factory's literal used to be an untyped hand-copy of all 22
 * required fields, and a field added to the real type would miss every copy at
 * once. `makeSettings` is `AppSettings`-typed, so it is now a compile error in
 * the one file that has to change.
 */
const SETTINGS_FIXTURE: AppSettings = makeSettings({
  defaultModel: "stale/model",
});

/** One `list_agent_config` row (the Agents modal's data). */
function agentRow(overrides: Partial<AgentConfigDto> = {}): AgentConfigDto {
  return {
    name: "scout",
    description: "Fast recon",
    scope: "user",
    path: "/u/.agents/agents/scout.md",
    file: { model: null, thinking: null, tools: null, permission: null },
    override: { model: null, thinking: null, tools: null, permission: null },
    effective: { model: null, thinking: null, tools: null, permission: null },
    source: { model: "parent", thinking: "parent", tools: "parent", permission: "parent" },
    shadowed: [],
    // issue #101: the two new REQUIRED wire fields at Rust's empty value. This
    // builder is called from INSIDE the hoisted `vi.mock("../lib/tauri")`
    // factory below — a hoisted `function` declaration, so the factory can reach
    // it (unlike the object-literal `row()` in `useAgentCatalog.test.ts`, whose
    // inline twin had to be edited separately).
    filePermission: null,
    frontmatterNotes: [],
    ...overrides,
  };
}

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  // The shared settings fixture, reached through a DYNAMIC import inside the
  // factory — the route `src/test/fixtures/settings.ts` documents and
  // `src/test/fixtures.test.ts` proves: `vi.hoisted()` is per-file and does NOT
  // make a module importable from a hoisted `vi.mock` factory, but every factory
  // here is already `async`, so `await import()` runs at factory time, after the
  // module graph exists. This replaces a 30-line untyped hand-copy of all 22
  // required `AppSettings` fields whose only guard was a comment.
  const { makeSettings } = await import("../test/fixtures/settings");
  return {
    ...actual,
    // `AppSettings` document: the fresh-install defaults (`defaultModel: null`
    // included — the store's copy of the document differs by that field alone,
    // which is why the `beforeEach` re-arm restates it).
    getSettings: vi.fn().mockResolvedValue(makeSettings()),
    startSession: vi.fn().mockResolvedValue({
      sessionId: "new1",
      cwd: "/tmp/ws",
      capabilities: { loadSession: false },
      archived: false,
    }),
    respondPermission: vi.fn(),
    respondInteractiveRequest: vi.fn(),
    loadHistory: vi.fn().mockResolvedValue({ rows: [], hasMore: false, todos: null }),
    setSpaceTrusted: vi.fn().mockResolvedValue(undefined),
    deleteSpace: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([
      {
        name: "alpha",
        description: "Alpha skill",
        path: "/p/.agents/skills/alpha/SKILL.md",
        dir: "/p/.agents/skills/alpha",
        scope: "space",
        body: "B",
        shadowed: [],
      },
    ]),
    setSessionArchived: vi.fn().mockResolvedValue(true),
    // The sidebar drag's ONE write (ADR 0075). The store's `reorderSessions`
    // action calls through this same module, and this file's mock replaces the
    // module — so without this arm the store's drag write would call a `vi.fn()`
    // returning `undefined`, and `reorderChain.sessions.then(…)` would throw
    // (`undefined` has no `.then`) inside the store's link.
    reorderSessions: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    // The row's Stop button: cancel a turn, or close the Session.
    closeSession: vi.fn().mockResolvedValue(undefined),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    // The Agents modal's three catalog sources + its write path.
    listAgentConfig: vi.fn().mockResolvedValue([agentRow()]),
    listModels: vi.fn().mockResolvedValue([
      {
        id: "Qwen3.8",
        provider: "tama",
        contextWindow: 200_000,
        supportsThinking: true,
        thinkingLevels: ["high", "medium", "low"],
      },
    ]),
    listTools: vi.fn().mockResolvedValue(["grep", "read_file"]),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedStartSession = vi.mocked(startSession);
const mockedListSkills = vi.mocked(listSkills);
const mockedDeleteSession = vi.mocked(deleteSession);
const mockedGetSettings = vi.mocked(getSettings);
const mockedSaveSettings = vi.mocked(saveSettings);
const mockedListAgentConfig = vi.mocked(listAgentConfig);

/**
 * The MOUNT PROBE for the render-site pin (see
 * `the dialog is mounted OUTSIDE the panes content region`).
 *
 * Why a probe and not an ancestor walk on the dialog node: `DialogContent` portals
 * itself to `document.body` — Radix's `Dialog.Content` renders an internal `Portal`
 * for a modal dialog, NOT the `DialogPortal` the app's `ui/dialog` merely re-exports
 * (stubbing that wrapper is INERT; `Dialog.Content` portals regardless, which is how
 * this test was first written and found vacuous). So in any real mount the dialog
 * node is a child of `document.body` whether the component was mounted inside the
 * `visibility: hidden` content region or beside it — `contains()` and any
 * `painted()`-style ancestor walk pass EVEN WITH THE BUG PRESENT.
 *
 * The wrapper below renders an ordinary (unportalled) node next to the real dialog.
 * Its position in the DOM is EXACTLY where `SpacesList` mounted the component, so it
 * reports the one fact the collapse depends on. Real `AgentsDialog` is still
 * rendered, so every other test in this file runs against the real modal; the probe
 * is a sibling `div` with no role, so it cannot disturb a `getByRole` query.
 */
let probeOn = false;

/**
 * A RENDER-TIME RECORD of the `rolledBackWrites` value the mount handed the dialog,
 * consecutive duplicates collapsed (the shape `traceAgentOverrides` uses).
 *
 * Why the renders and not the DOM: this counter is the FACT the modal's stored-pin
 * suppression is stamped against (see `AgentsDialog`'s `edits`), and a test whose
 * rows carry all-`null` `override` columns has no column disagreement for the cue to
 * name — the cue is then unobservable in the DOM, while the spurious increment that
 * would have armed it is still a lie the mount told. The counter is that cue's
 * upstream, and it is readable on every render.
 *
 * Recorded in the mock wrapper below (the seam the mount probe already uses), because
 * the prop belongs to the dialog and the mount is its only writer. Pushed at render
 * time, so a value that appeared for one render and was overwritten next render is
 * still in the record. Readers reset it first — this is module scope, shared across
 * every test in the file.
 */
let rollsSeen: (number | undefined)[] = [];

/** Discard the record so it describes ONE test's renders. */
function resetRolledBackWritesRecord(): void {
  rollsSeen = [];
}

vi.mock("./AgentsDialog", async () => {
  const actual = await vi.importActual<typeof import("./AgentsDialog")>(
    "./AgentsDialog",
  );
  const Real = actual.default;
  return {
    default: (props: Parameters<typeof Real>[0]) => {
      // Both reads happen at RENDER time (the factory is hoisted above this file's
      // `let`s, so the factory BODY could not touch them at all — only this closure
      // body, which runs per render, can).
      if (rollsSeen[rollsSeen.length - 1] !== props.rolledBackWrites) {
        rollsSeen.push(props.rolledBackWrites);
      }
      return React.createElement(
        React.Fragment,
        null,
        // Read at RENDER time (the factory is hoisted above this file's `let`).
        probeOn
          ? React.createElement("div", {
              "data-testid": "agents-mount-probe",
            })
          : null,
        React.createElement(Real, props),
      );
    },
  };
});

/**
 * Whether a node is PAINTED — i.e. neither it nor any ancestor carries
 * `visibility: hidden` (Tailwind's `invisible`). jsdom resolves no CSS, so
 * "does this text bleed into the 40px sliver?" is read off the class list the
 * component renders, which is exactly what the collapse controls.
 */
function painted(node: HTMLElement): boolean {
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    if (el.classList.contains("invisible")) return false;
  }
  return true;
}

/**
 * Open the Agents modal AND wait until it holds a ROW.
 *
 * `await screen.findByRole("dialog")` on its own is not enough to open the modal
 * the tests then edit: the rows come from `useAgentCatalog`, which starts at `[]`
 * and only fills in when `list_agent_config` lands, so a dialog found on the
 * click's own tick can be the one rendering `No Agent definitions found.`. Every
 * test below that open makes the next lookup SYNCHRONOUS
 * (`within(dialog).getByRole("Model for scout")`), so whenever the fetch lost that
 * race the failure read "the model button is missing" for a modal that was fine and
 * a write path that was fine — a flake with no subject. Awaiting one row control
 * makes the open deterministic, and it happens BEFORE any edit, so it cannot reorder
 * the writes the tests are about.
 */
async function openAgentsModal(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("button", { name: "Model for scout" });
  return dialog;
}

/**
 * A RECORDING SUBSCRIPTION to the settings store: every `agentOverrides` map the
 * store holds from now on, in order, as JSON (consecutive duplicates collapsed).
 *
 * Why a trace and not a final read: the defect this exists for is a GLIMPSE, not
 * an end state. Each link of the `agentOverrides` write chain publishes its own
 * snapshot when it completes, so a slow link finishing AFTER a newer optimistic
 * publish hands the store the OLDER map — the user's newer pick flickers back to
 * "Inherits" for a frame, and any edit composed inside that window silently loses
 * a field from `settings.json`. `waitFor(() => store == X)` cannot see that at
 * all: it polls for a condition that the buggy code also ends up satisfying, so
 * the assertion of record has to be about the SEQUENCE the store passed through.
 *
 * `subscribe` is the store's own notify path (zustand without the selector
 * middleware, hence the manual dedupe), and the record is synchronous with each
 * `set`, so a publish that happens inside a promise continuation is captured even
 * when no React render is watching.
 */
function traceAgentOverrides(): { seen: () => string[]; stop: () => void } {
  const seen: string[] = [];
  const record = (settings: AppSettings | null) => {
    const map = JSON.stringify(settings?.agentOverrides ?? null);
    if (seen[seen.length - 1] !== map) seen.push(map);
  };
  record(useSettings.getState().settings);
  const unsubscribe = useSettings.subscribe((state) => record(state.settings));
  return { seen: () => seen, stop: unsubscribe };
}

/**
 * Fixture: two spaces. `alpha` holds a live session `s1` (in-turn, with a
 * loaded transcript) + a stored session `h1` (loaded transcript, ~1h old);
 * `beta` holds a stored session `h2` that was NOT opened this boot (no
 * loaded messages → no relative time).
 */
function seed(): void {
  const now = Date.now();
  // THE ISOLATION HALF, now the shared helper's job: every store back to the
  // state zustand captured at creation, BEFORE this fixture writes its keys.
  // This file used to hand-list the keys it happened to remember —
  // `archivedSessions: []`, `closeReasons: {}`, `stopReasons: {}`, plus a whole
  // `setState` on each of the permissions and interactive stores — and
  // `useSessions` has more data fields than that list named, so whatever it
  // omitted leaked from one test to the next. `resetStores()` installs the WHOLE
  // captured state (with `replace = true`, so nothing shallow-merges over it),
  // which includes the archived list the comment below used to guard by hand.
  // What stays below is therefore the FIXTURE, not the hygiene.
  resetStores();
  // Seed via `setState` directly — NOT `getState().setSpaces(…)` (that
  // triggers boot auto-selection + `openSession` → `loadHistory` IPC).
  useSessions.setState({
    spaces: [
      makeSpaceRow({ path: "/tmp/alpha", createdAt: now, lastOpenedAt: now }),
      makeSpaceRow({
        path: "/tmp/beta",
        createdAt: now,
        lastOpenedAt: now,
        trusted: true,
      }),
    ],
    sessions: [makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha" })],
    historySessions: [
      makeSessionRow({ sessionId: "h1", cwd: "/tmp/alpha" }),
      makeSessionRow({ sessionId: "h2", cwd: "/tmp/beta" }),
    ],
    activeSessionId: "s1",
    // The selected space (the top tabs' state): `alpha` — the active
    // session's space (the sidebar lists THIS space's sessions).
    activeSpacePath: "/tmp/alpha",
    messages: {
      s1: [makeMessage("user", { text: "Fix the login bug", at: now - 10_000 })],
      h1: [
        makeMessage("user", {
          text: "Refactor the parser",
          at: now - 3_600_000,
        }),
      ],
    },
    inTurn: { s1: true },
  });
}

beforeEach(() => {
  seed();
  vi.clearAllMocks();
  // `clearAllMocks` clears CALL RECORDS and nothing else: an UNCONSUMED `…Once`
  // arm survives it and fires in the NEXT test (measured — a `mockRejectedValueOnce`
  // left over from a test whose assertion threw before consuming it rejects the
  // next test's `saveSettings`), and so does a bare `mockResolvedValue` override.
  // The mocks this file re-arms are therefore reset and handed their factory
  // default again, so "which test ran before me" cannot decide what my IPC layer
  // answers.
  //
  // (`listSkills` is deliberately NOT in this list, and the reason is mechanical
  // rather than about any one test: `mockReset()` strips a mock's implementation, so
  // the bare reset leaves `listSkills()` returning `undefined`, and
  // `useSkillCatalog.ts:66` calls `listSkills(spacePath).catch(…)` on EVERY mount —
  // adding this line as-is measured 67 of this file's 69 tests failing on
  // "Cannot read properties of undefined (reading 'catch')". It would need its
  // factory default restated to belong here — which is ALSO the fix for the
  // override the empty-skills test leaves behind (see its comment: declaration
  // order is what keeps that `mockResolvedValue([])` from leaking further).)
  mockedSaveSettings.mockReset().mockResolvedValue(undefined);
  // Each re-arm restates that mock's FACTORY default (`getSettings`'s differs from
  // `SETTINGS_FIXTURE` by `defaultModel: null` alone — verified deep-equal), so
  // re-arming here changes no behavior; it only makes the default unconditional.
  mockedGetSettings
    .mockReset()
    .mockResolvedValue({ ...SETTINGS_FIXTURE, defaultModel: null });
  mockedListAgentConfig.mockReset().mockResolvedValue([agentRow()]);
  vi.mocked(setSessionArchived).mockReset().mockResolvedValue(true);
  mockedDeleteSession.mockReset().mockResolvedValue(undefined);
  // Stop's two commands, re-armed for the SAME reason as the two lines above:
  // `clearAllMocks` clears the CALL RECORD only and never an armed implementation,
  // so a `mockRejectedValueOnce` left unconsumed (a Stop test that pins the
  // rejection reaching the row's logger and asserts before draining it) would be
  // handed to the NEXT test's click. None is armed today, which is exactly the
  // claim the neighbours make too: restating the factory default here changes no
  // behaviour, it only makes the default unconditional. `mockReset` alone would
  // not do — it strips the implementation, leaving the mock answering
  // `undefined`, which is not the `Promise` these wrappers return.
  vi.mocked(closeSession).mockReset().mockResolvedValue(undefined);
  vi.mocked(cancelSession).mockReset().mockResolvedValue(undefined);
});
// Seed the SETTINGS STORE. `SpacesList.tsx` did not read `useSettings` before the
// Agents modal mounted (only `main.tsx`'s boot path ever populated it), and this
// file never seeded it — so with the mount's `settings &&` guard the dialog would
// render in NO test here, and every failure would read as "the Agents button is
// broken" when the real cause is an empty store. The same seeding pattern
// `ChatStream.test.tsx` uses. Reset to `null` first: the store is module-scoped,
// so a test that writes settings must not leak them into the next one.
// (Since D2 the read travels through `useAgentOverridesWrites`, which selects
// `settings` off this same store — so the seeding below is still exactly what the
// gate reads, and `holds the Agents dialog back while there is no settings
// document` is the pin that keeps it honest.)
beforeEach(() => {
  useSettings.setState({ settings: null, loaded: false });
  useSettings.getState().setSettings(SETTINGS_FIXTURE);
});
// The hook's module-level catalog cache is shared across tests in a
// file: clear it so each test refetches (without this, test 1's warm
// cache — keyed by the `seed()` fixture's `cwd` — makes a later test's
// fresh `listSkills` mock moot).
beforeEach(clearSkillCatalogCache);
// …and the same for the Agent catalog's module-level cache (the Agents modal
// fetches through `useAgentCatalog`, keyed by the `seed()` fixture's Space).
beforeEach(clearAgentCatalogCache);
// The two module-scoped pane/dialog flags this file can raise, back to their
// value at import — the shared helper (Task B4a) instead of two hand-written
// `beforeEach` blocks. `resetModuleFlags()` restores the left pane, the side
// pane and the Open-Space flag; the side pane is a no-op here (this component
// never reads it) and the other two are exactly what these blocks reset. The
// dialog flag is the one that bites: a leaked `true` auto-mounts a real Radix
// modal in every later `render(<SpacesList/>)`, which sets
// `document.body.style.pointerEvents = "none"` and `aria-hidden`s its siblings —
// so unrelated `getByRole` queries further down this file throw for a reason
// that has nothing to do with them.
beforeEach(resetModuleFlags);
// DELETED here, and now owned by `src/test/setup.tsx`: this file's hand-written
// `Element.prototype.scrollIntoView = vi.fn()` (jsdom has no layout, so Radix's
// `Select` throws on the focus-first-option scroll). The setup file installs the
// same plain prototype assignment for every file, and this one is NOT among the
// four `vi.unstubAllGlobals()` files the deletion checklist excludes.
// The mount probe above is a module-level switch: a test that asks for it must
// not leak it into the tests after it.
beforeEach(() => {
  probeOn = false;
});
// FILE-SCOPE spy restore. Several tests below install a `console.error` spy to
// swallow (or observe) a failure log and restore it on the last line — with no
// `try/finally`. An assertion that throws mid-test therefore never reaches that
// restore, and a SILENCED `console.error` walks into every later test in the
// file: exactly the leak that makes the first red hard to read, because the
// tests after it stop printing the errors they were supposed to print. Restoring
// here costs the tests nothing and holds whatever the throw skipped.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("SpacesList", () => {
  it("renders its labelled action buttons with their labels and kbd hints", () => {
    // The row holds FOUR labelled buttons (Open Space, New Session, Skills,
    // Agents) since Agents landed — this name used to say "two", which was true only
    // of the two that carry a chord. The kbd assertions below stay on those two on
    // purpose: `Skills` and `Agents` render no `Kbd` at all (matching each other), so
    // a `⌘`-hint assertion for them would pin copy the component never renders.
    render(<SpacesList />);
    expect(screen.getByRole("button", { name: /New Session/ })).toBeTruthy();
    expect(screen.getByText("⌘N")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open Space/ })).toBeTruthy();
    expect(screen.getByText("⌘O")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
  });

  it("opens the Open Space dialog from the action button", () => {
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: /Open Space/ }));
    // Asserted on the SHARED FLAG, not on the dialog's "New space" title: this
    // pane RAISES the flag and no longer renders the dialog (`App` root owns the
    // render site), so a text query here can only ever fail. The dialog's own
    // title is pinned in `NewSpaceDialog.test.tsx`, and its root render in
    // `App.test.tsx`.
    expect(getNewSpaceDialogOpen()).toBe(true);
  });

  it("opens the Open Space dialog from the New Session button when no space is selected", () => {
    useSessions.setState({ activeSpacePath: null });
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: /New Session/ }));
    // The no-Space routing is the STORE command's now (`startSessionInActiveSpace`
    // → `openNewSpaceDialog`), so the button just delegates. Same flag assertion
    // as above — the dialog itself is rendered at `App` root.
    expect(getNewSpaceDialogOpen()).toBe(true);
    expect(mockedStartSession).not.toHaveBeenCalled();
  });

  it("raises the flag but renders NO dialog of its own (the render site is `App` root)", () => {
    // The one-dialog rule, pinned from this side: this pane is one of the flag's
    // FOUR raisers, so if it also mounted a dialog the app would paint two (and
    // `App.test.tsx` would see a doubled title). Put the flag-gated dialog render
    // back in `SpacesList.tsx` and this goes red.
    setNewSpaceDialogOpen(true);
    render(<SpacesList />);
    expect(getNewSpaceDialogOpen()).toBe(true);
    expect(screen.queryByText("New space")).toBeNull();
  });

  it("starts a new session in the SELECTED space (not the active session's space)", async () => {
    // The active session's cwd (`/tmp/gamma`) matches NO space in the
    // fixture — but the SELECTED space is `/tmp/beta` (the tabs' state
    // is independent of the active session): the button must start in
    // the selected space, not the orphan's cwd (and not the dialog).
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s-orphan", cwd: "/tmp/gamma" }),
      ],
      activeSessionId: "s-orphan",
      activeSpacePath: "/tmp/beta",
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: /New Session/ }));
    await waitFor(() =>
      expect(mockedStartSession).toHaveBeenCalledWith("/tmp/beta"),
    );
  });


  it("renders the stored row's stored ring and its relative time, and NO spinner", () => {
    render(<SpacesList />);
    const row = screen
      .getByText("Refactor the parser")
      .closest('[role="button"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector('[role="status"]')).toBeNull();
    // A STORED session wears the dim ring — the idle cue the collapsed rail has
    // always had and the expanded list used to omit entirely (an empty slot
    // unless the session was in a turn).
    expect(row!.querySelector('[data-dot="stored"]')).toBeTruthy();
    // Last message ~1h ago → `1h`.
    expect(row!.textContent).toContain("1h");
  });

  it("renders an empty time slot (no time text) for a session with no loaded messages", () => {
    // A stored session in the ACTIVE space (`/tmp/alpha`) that was not
    // opened this boot: no loaded messages → the title falls back to
    // the space's base name (`alpha`) and the time slot is empty.
    useSessions.setState({
      historySessions: [
        makeSessionRow({ sessionId: "h1", cwd: "/tmp/alpha" }),
        makeSessionRow({ sessionId: "h3", cwd: "/tmp/alpha" }),
      ],
    });
    render(<SpacesList />);
    const alphas = screen.getAllByText("alpha");
    // `h3`'s row (the third `alpha` — `s1`'s + `h1`'s rows have loaded
    // messages, `h3`'s does not → its title is the base name). It is also
    // LAST: no loaded transcript is no evidence, and the stored group puts
    // evidence-free below a session it can prove was used an hour ago.
    const row = alphas[alphas.length - 1].closest('[role="button"]');
    expect(row).not.toBeNull();
    // Title only — no time text.
    expect(row!.textContent).toBe("alpha");
  });

  it("marks a pending-permission row with the ? and KEEPS its relative time", () => {
    usePermissions.setState({
      prompts: {
        s1: [{ requestId: "r1", toolTitle: "Run a tool", options: [] }],
      },
    });
    render(<SpacesList />);
    const row = screen
      .getByText("Fix the login bug")
      .closest('[role="button"]');
    // The `?` replaces the green "Waiting" PILL: the pill and the rail's dot
    // were one fact in two shapes, and the pill's cost was the time — while a
    // session waited you could not see how long ago it had been active.
    expect(screen.queryByText("Waiting")).toBeNull();
    expect(row!.querySelector('[data-dot="waiting"]')).toBeTruthy();
    expect(row!.querySelector('[role="status"]')).toBeNull();
    expect(row!.textContent).toContain("now");
  });

  it("marks a pending interactive ask/confirm/password row with the ? too", () => {
    useInteractive.setState({
      requests: {
        h1: [
          {
            requestId: "br1",
            method: "password",
            source: "main",
            params: { command: "sudo apt install foo", reason: "test" },
          },
        ],
      },
    });
    render(<SpacesList />);
    const row = screen
      .getByText("Refactor the parser")
      .closest('[role="button"]');
    // `password` included: a pending sudo password had no cue anywhere else.
    expect(row!.querySelector('[data-dot="waiting"]')).toBeTruthy();
    expect(row!.textContent).toContain("1h");
  });

  it("opens a session on row click (the store's activeSessionId + the selection styling)", () => {
    render(<SpacesList />);
    expect(useSessions.getState().activeSessionId).toBe("s1");
    fireEvent.click(screen.getByText("Refactor the parser"));
    expect(useSessions.getState().activeSessionId).toBe("h1");
    const row = screen
      .getByText("Refactor the parser")
      .closest('[role="button"]');
    expect(row!.className).toContain("bg-selected");
  });

  it("shows the IDLE mark in the EXPANDED list too (the cue the collapsed rail has always had)", () => {
    // The bug this pins: the open row's leading slot was empty unless the
    // session was in a turn, while the collapsed rail drew a dot for every
    // session — so EXPANDING the sidebar deleted the idle mark the user could
    // see when it was collapsed.
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha" }),
      ],
      activeSessionId: "s1",
      inTurn: {},
      messages: {
        s1: [makeMessage("user", { text: "Fix the login bug", at: Date.now() - 10_000 })],
      },
    });
    render(<SpacesList />);
    const row = screen
      .getByText("Fix the login bug")
      .closest('[role="button"]');
    // Live and NOT in a turn → the filled live ring, and no spinner.
    expect(row!.querySelector('[data-dot="live"]')).toBeTruthy();
    expect(row!.querySelector('[role="status"]')).toBeNull();
  });

  it("renders its rows in the store's ONE sessionIds sequence, so a STORED row above a LIVE one in the manual order renders FIRST", () => {
    // THE manual order reaching the DOM. The store's ONE sequence (`sessionIds`)
    // answers `[h_stored, s_live]` for these numbers; the deleted display sort
    // answers `[s_live, h_stored]`, because the live block was rendered first
    // regardless of any number. This is the store-level case that
    // `sessions.test.ts`'s "groups a space with a live session and a stored
    // session" pins, shown in the DOM.
    //
    // The seed is overridden COMPLETELY — a row the seed leaves behind silently
    // joins the list and can satisfy an order assertion by accident. Both rows
    // carry a generated `title` so the labels are queryable with no transcript
    // (the trick "labels a titled STORED row by its title…" uses).
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s_live", cwd: "/tmp/alpha", title: "Live row" }),
      ],
      historySessions: [
        makeSessionRow({ sessionId: "h_stored", cwd: "/tmp/alpha", title: "Stored row" }),
      ],
      messages: {},
      activeSpacePath: "/tmp/alpha",
      // The STORED row holds the SMALLER number, i.e. the HIGHER row — the one
      // arrangement the old live-block-first render could never produce.
      sessionOrder: { h_stored: 2, s_live: 5 },
    });
    render(<SpacesList />);
    const storedRow = screen.getByText("Stored row");
    const liveRow = screen.getByText("Live row");
    expect(
      storedRow.compareDocumentPosition(liveRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders a Session started after the boot fetch at the BOTTOM of the list (the new-row rule, not the live block)", () => {
    // The rule ADR 0075 chose: a NEW row joins at the BOTTOM. The order map only
    // knows what the boot fetch returned, so `s-new` has NO entry and
    // `sortByManualOrder` sinks it — while the deleted live block put a fresh
    // row FIRST (this replaces the deleted "keeps a brand-new live session … at
    // the TOP of the live group", which asserted the opposite).
    //
    // The seed's live `s1` is DROPPED, not kept: it would join the list and could
    // satisfy the assertion by accident. `h1`'s seed entry stays (its seed
    // transcript is what labels the row "Refactor the parser"); `h2` lives in
    // `/tmp/beta` and renders nowhere here.
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s-new", cwd: "/tmp/alpha", title: "Just created" }),
      ],
      // The empty array is what `addSession` gives a fresh session.
      messages: { ...useSessions.getState().messages, "s-new": [] },
      sessionOrder: { h1: 0 },
    });
    render(<SpacesList />);
    const storedRow = screen.getByText("Refactor the parser");
    const freshRow = screen.getByText("Just created");
    expect(
      storedRow.compareDocumentPosition(freshRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("updates a row's relative time while its POSITION stays frozen", () => {
    // The user-visible promise this whole branch exists for: a row's LABEL stays
    // live (its own per-row `messages` subscription) while its SLOT never moves.
    // Red at HEAD for exactly the reason it exists to forbid: after the append,
    // the deleted display sort floated the newly-active row to the top of the
    // stored group, so the SECOND position comparison failed.
    const now = Date.now();
    useSessions.setState({
      sessions: [],
      historySessions: [
        makeSessionRow({ sessionId: "h_first", cwd: "/tmp/alpha", title: "Row A" }),
        makeSessionRow({ sessionId: "h_second", cwd: "/tmp/alpha", title: "Row B" }),
      ],
      activeSpacePath: "/tmp/alpha",
      sessionOrder: { h_first: 0, h_second: 1 },
      messages: {
        h_first: [makeMessage("user", { text: "Row A asked", at: now - 10_000 })],
        h_second: [makeMessage("user", { text: "Row B asked", at: now - 3_600_000 })],
      },
    });
    render(<SpacesList />);
    const rowOf = (text: string): HTMLElement =>
      screen.getByText(text).closest('[role="button"]') as HTMLElement;
    const a = screen.getByText("Row A");
    const b = screen.getByText("Row B");
    expect(
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(rowOf("Row B")).getByText("1h")).toBeTruthy();

    // A future stamp → `now - at` is negative → the `< 60_000` bucket → "now".
    // Deterministic label change with no fake timers, and the position must not
    // move an inch.
    act(() => {
      useSessions.setState({
        messages: {
          ...useSessions.getState().messages,
          h_second: [
            makeMessage("user", {
              text: "Row B answered",
              at: Date.now() + 9_000_000_000,
            }),
          ],
        },
      });
    });
    expect(
      screen.getByText("Row A").compareDocumentPosition(screen.getByText("Row B")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(rowOf("Row B")).getByText("now")).toBeTruthy();
  });

  it("truncates a long title on a single line (the fade mask is the sole cue)", () => {
    // A 120-char first user message → `titleFor` slices it to 80 chars; the
    // title span must carry the truncation classes so it overflows under the
    // fade instead of wrapping.
    useSessions.setState({
      messages: {
        s1: [makeMessage("user", { text: "x".repeat(120), at: Date.now() - 10_000 })],
      },
    });
    render(<SpacesList />);
    const title = screen.getByText("x".repeat(80));
    expect(title.className).toContain("overflow-hidden");
    expect(title.className).toContain("whitespace-nowrap");
    expect(title.className).toContain("min-w-0");
  });

  it("ignores nothing on its own: ⌘N on an <input> is the chord's business now, and a dialog is inert", () => {
    // The chord left this component, so this file cannot test the guard — but it
    // keeps the two facts that used to be entangled with it, and separates them:
    // (1) the OLD input half is INVERTED. A text-field target no longer suppresses
    // the chord; whether the chord fires is `useAppShortcuts.test.ts`'s case, and
    // what belongs HERE is that this pane mounts no listener at all, so dispatching
    // a chord against an input inside it starts nothing on its own.
    // (2) the `role="dialog"` half survives as a statement about THIS pane: raising
    // the flag while a keypress happens inside a dialog does not stack a second
    // dialog, because the flag has one owner.
    render(<SpacesList />);
    const input = document.createElement("input");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    // Appended to `document.body` OUTSIDE RTL's render tree — RTL cleanup
    // does not touch manually appended nodes, so remove them explicitly.
    document.body.append(input, dialog);
    try {
      fireEvent.keyDown(input, { key: "n", ctrlKey: true });
      // No listener in this pane any more: nothing this component owns reacts.
      expect(mockedStartSession).not.toHaveBeenCalled();
      expect(getNewSpaceDialogOpen()).toBe(false);
      // A `[role="dialog"]` keypress raises nothing either — and the guard that
      // makes the chord inert there is pinned in `useAppShortcuts.test.ts`.
      fireEvent.keyDown(dialog, { key: "o", metaKey: true });
      expect(getNewSpaceDialogOpen()).toBe(false);
    } finally {
      input.remove();
      dialog.remove();
    }
  });

  // The two chord tests that used to live here — `⌘N / Ctrl+N trigger the New
  // Session handler (a bare key does not)` and `⌘O opens the Open Space dialog` —
  // MOVED to `../hooks/useAppShortcuts.test.ts`. They dispatched on `window`, which
  // was only reachable because this component subscribed on `window`; no listener
  // remains here, so keeping them would mean they pass vacuously. Their coverage
  // moved with them (plus the `contenteditable="false"` case, the textarea cases,
  // the auto-repeat case and the dialog/alertdialog guard cases).

  it("the_skills_button_sits_in_the_button_row", async () => {
    render(<SpacesList />);
    // The third button in the `New Session` / `Open Space` row (the skill
    // LIST no longer renders in the pane — the button opens a modal).
    expect(await screen.findByText("Skills")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    // The one-fetch property (single consumer): one `listSkills` call.
    expect(mockedListSkills).toHaveBeenCalledTimes(1);
  });

  it("the_skills_modal_shows_the_empty_state_when_there_are_no_skills", async () => {
    // `clearAllMocks` PRESERVES the factory's 1-skill implementation, so
    // override it here. Declared LAST so the override cannot leak into
    // the other test (the `beforeEach` cache-clear makes each test
    // refetch; because implementations are preserved, this test's
    // `mockResolvedValue([])` would leak to any test declared after it —
    // declaration order is what keeps the two independent).
    vi.mocked(listSkills).mockResolvedValue([]);
    render(<SpacesList />);
    // Open the modal from the button.
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    await screen.findByText("No skills found.");
  });

  // -------------------------------------------------------------------------
  // The Agents modal (ADR 0066 / ADR 0068) — the fourth command in this pane,
  // mounted beside `Skills` with the same two boundaries: it must survive the
  // collapse (the rail icon), and it must render OUTSIDE the content region.
  // -------------------------------------------------------------------------

  it("an_Agents_button_exists_and_opens_the_dialog", async () => {
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    // `getByRole("dialog")`, NEVER a text query: the pane now holds BOTH a
    // button labelled `Agents` AND a `DialogTitle` reading `Agents`, so
    // `findByText("Agents")` matches two nodes and throws on ambiguity (the same
    // hazard this file documents for `Skills`).
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Agents")).toBeTruthy();
    // The row came from `list_agent_config` keyed by the ACTIVE Space. AWAITED,
    // for the reason `openAgentsModal` states: the rows arrive with the fetch, so
    // a row queried on the dialog's own tick can race it.
    expect(await within(dialog).findByText("scout")).toBeTruthy();
  });

  it("the_collapsed_rails_Agents_icon_opens_the_dialog_too", async () => {
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByTitle("Agents"));
    // The dialog renders while the pane is COLLAPSED — the acceptance criterion,
    // and the reason the render site sits outside the `invisible` content region.
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("scout")).toBeTruthy();
  });

  it("the dialog is mounted OUTSIDE the panes content region (structural)", async () => {
    // The hazard is real and invisible: the content region carries
    // `visibility: hidden` while the pane is collapsed, and `visibility` INHERITS
    // into `fixed` descendants — a dialog mounted inside that region opens with
    // nothing painted. The file's comment at the close of the region says exactly
    // this about `SkillsDialog`, and the Agents dialog has the same requirement.
    //
    // WHY THE ASSERTION IS STRUCTURAL AND NOT A `visibility` TEST OF THE DIALOG.
    // `DialogContent` portals itself to `document.body` (Radix's `Dialog.Content`
    // renders an internal `Portal` — not the `DialogPortal` `ui/dialog`
    // re-exports, so stubbing THAT wrapper is inert; an ancestor walk on the real
    // dialog passed even with the dialog mounted inside the hidden region).
    // jsdom therefore CANNOT demonstrate the `visibility` argument behaviourally on
    // the dialog node: it is never a DOM descendant of the region in ANY
    // configuration.
    //
    // The `agents-mount-probe` (see the mock at the top of this file) is an
    // ordinary un-portalled node rendered at the same site as the dialog, so its
    // PARENT reports where the component was actually mounted. The second
    // assertion reads the same `invisible` class the collapse applies through the
    // `painted()` helper — the structural statement of the `visibility` argument.
    // Move the `{agentsOpen && settings && …}` render inside the content-region
    // `<div>` and BOTH assertions go red (measured; see the commit notes).
    probeOn = true;
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    const pane = container.firstChild as HTMLElement;
    expect(pane.tagName).toBe("ASIDE");
    // THE CONTENT REGION — the div that carries `invisible` while collapsed. The
    // dialogs sit under the `<aside>` BESIDE this div, so the region (not the pane
    // frame) is the container whose `visibility` is the hazard.
    const contentRegion = pane.firstElementChild as HTMLElement;
    expect(contentRegion.classList.contains("invisible")).toBe(true);
    fireEvent.click(screen.getByTitle("Agents"));
    const probe = await screen.findByTestId("agents-mount-probe");
    // The dialog ITSELF is rendered too (the probe is a sibling, not a
    // replacement) — so this cannot pass on a component that never mounted.
    expect(screen.getByRole("dialog")).toBeTruthy();
    // The mount site is outside the hidden region…
    expect(contentRegion.contains(probe)).toBe(false);
    // …and consequently PAINTED while collapsed.
    expect(painted(probe)).toBe(true);
  });

  it("the Portal relocates the dialog to document.body (why the test above needs a probe)", async () => {
    // The fact that makes a plain structural walk vacuous, pinned rather than
    // assumed: with the Portal live (the default here), the dialog node is a
    // child of `document.body` — NOT of the pane — whichever render site the
    // component uses. If Radix ever stops relocating (or the app starts passing a
    // `container`), the probe above stops being the only discriminator and this
    // test says so out loud.
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    const pane = container.firstChild as HTMLElement;
    fireEvent.click(screen.getByTitle("Agents"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.parentElement).toBe(document.body);
    // Which is exactly the configuration in which `pane.contains(dialog)` is
    // `false` for BOTH render sites — the reason it is not the assertion of
    // record above.
    expect(pane.contains(dialog)).toBe(false);
  });

  it("the dialog opens cleanly when the catalog answers with no definitions", async () => {
    // The empty path, which no test here used to take: every other open goes
    // through `openAgentsModal`, which WAITS FOR A ROW, so `[]` was only ever
    // reachable as the transient pre-fetch paint that helper is written to avoid.
    // The state is real — `list_agent_config` can answer `[]`, and the hook
    // degrades a FAILED fetch to `[]` — and the dialog's orphan scan, its
    // thinking-level union and the per-row `stored` lookup all read those rows.
    //
    // Which arm this reaches, stated honestly: `useAgentCatalog` starts at
    // `rows: []`, so `rows.length === 0` is ALSO what a still-pending fetch
    // paints (measured — handing the mock a promise that never settles renders the
    // same line). And the dialog's only `Loading…` arm is gated on
    // `settings === null`, which the mount's `settings &&` guard already excludes,
    // so that arm is unreachable from this render site. So the copy pinned below
    // is the empty/unknown-rows arm, `Loading…` is asserted absent, and this test
    // proves "an empty answer renders instead of throwing" — not "a hung IPC is
    // distinguishable from an empty answer", which the component cannot express.
    mockedListAgentConfig.mockResolvedValue([]);
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("No Agent definitions found."),
    ).toBeTruthy();
    expect(within(dialog).queryByText("Loading…")).toBeNull();
    // …and the modal is still a working dialog, not a crashed shell: the search
    // field survived, and the dialog found by the empty copy is the open one.
    expect(within(dialog).getByPlaceholderText("Search agents…")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(dialog);
    // One fetch for the mount (no retry storm against the empty answer).
    expect(mockedListAgentConfig).toHaveBeenCalledTimes(1);
  });

  it("picking_a_model_saves_agentOverrides_through_a_read_modify_write", async () => {
    // The one new write path in the feature. The save must be composed from a
    // FRESH `get_settings` read, never from the store's copy: Rust writes
    // `settings.json` on its own (`agent/session/mod.rs:1678` persists a
    // remembered thinking level via load-mutate-write), so the store can be
    // holding a stale document and composing from it would silently clobber a
    // concurrent change.
    //
    // The re-read returns a document whose `defaultModel` DIFFERS from the store
    // fixture's, so "every other field preserved" can only pass by reading the
    // fresh document — a save composed from the store would write `stale/model`.
    // Its `agentOverrides` carries a SECOND agent on purpose: that entry is
    // expected to be REPLACED away, because the map is the one field the user is
    // editing and the dialog hands over the whole edited map (see the write
    // helper's comment in `hooks/useAgentOverridesWrites.ts`, where the chain moved
    // for D2 — sound because no writer outside this
    // modal is live while the modal is, the one exception being `SettingsPage`'s
    // Provider-rename remap, which cannot overlap because Settings unmounts this pane).
    const fresh: AppSettings = {
      ...SETTINGS_FIXTURE,
      defaultModel: "fresh/model",
      agentOverrides: { plan: { thinking: "high" } },
    };
    // The store seed (already set) is `SETTINGS_FIXTURE`; the RE-READ is `fresh`.
    mockedGetSettings.mockResolvedValue(fresh);
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    await waitFor(() => expect(mockedSaveSettings).toHaveBeenCalledTimes(1));
    // The re-read happened BEFORE the save (the read-modify-write order).
    expect(mockedGetSettings.mock.invocationCallOrder[0]).toBeLessThan(
      mockedSaveSettings.mock.invocationCallOrder[0],
    );
    expect(mockedSaveSettings).toHaveBeenCalledWith({
      ...fresh,
      agentOverrides: { scout: { model: "tama/Qwen3.8" } },
    });
    // Every field OTHER than the edited map is the FRESH document's, byte-identical
    // — the store's stale `defaultModel` must not appear anywhere in the call.
    const saved = mockedSaveSettings.mock.calls[0][0];
    expect(saved.defaultModel).toBe("fresh/model");
    expect(JSON.stringify(saved)).not.toContain("stale/model");
    // And the store now agrees with the file (a divergent store is how the next
    // write gets composed from a document that no longer exists).
    expect(useSettings.getState().settings).toEqual({
      ...fresh,
      agentOverrides: { scout: { model: "tama/Qwen3.8" } },
    });
  });

  it("two rapid edits both land in the file (the writes are serialized)", async () => {
    // The dialog builds the map it hands over from the RENDER-TIME store
    // snapshot, and the store only catches up once `getSettings` → `saveSettings`
    // resolve. So a second edit issued inside that window carries a map that has
    // never seen the first edit's field, and the write replaces the map
    // WHOLESALE — the first pick vanishes from `settings.json` with no feedback.
    // A model-pick then a thinking-pick is one natural ~300ms gesture, so this is
    // the ordinary case, not a corner.
    //
    // The save is held open here to make that window deterministic instead of
    // timing-dependent: the second edit is issued while the first save is
    // provably still in flight. What is asserted is the END STATE of the file —
    // the LAST document written carries both fields, whether that comes from one
    // coalesced save or from two serialized ones.
    let releaseFirstSave!: () => void;
    mockedSaveSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstSave = resolve;
        }),
    );
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    // Edit 1: the model.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    // Edit 2: the thinking level, WITHOUT awaiting the first save.
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    act(() => releaseFirstSave());
    // The second write still flows after the first lands (the chain is not
    // abandoned when a link resolves slowly — or when one fails).
    //
    // The pass-condition must be as strong as the read: a weaker condition makes
    // correctness depend on RTL internals. `>= 1` here is satisfied while only
    // edit 1's link has been issued, and passing anyway would then be a property
    // of RTL's `asyncWrapper` draining the macrotask queue before the assertion
    // below runs — not a property of the write chain. Both edits were demanded,
    // so the LAST call is the one the file ends up holding.
    await waitFor(() =>
      expect(mockedSaveSettings.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    const lastSaved =
      mockedSaveSettings.mock.calls[mockedSaveSettings.mock.calls.length - 1][0];
    expect(lastSaved.agentOverrides).toEqual({
      scout: { model: "tama/Qwen3.8", thinking: "high" },
    });
    // …and the store agrees with the file the user just wrote.
    await waitFor(() =>
      expect(useSettings.getState().settings?.agentOverrides.scout).toEqual({
        model: "tama/Qwen3.8",
        thinking: "high",
      }),
    );
  });

  it("a newer optimistic publish is never reverted by an older link completing (no flicker)", async () => {
    // The half of the serialized chain the FILE writes do not cover. Every link
    // writes its map in the right ORDER, but each link also PUBLISHES its own
    // snapshot on completion: success → `setSettings(freshDocument)` with THIS
    // link's map, failure → a re-fetched FILE document published under a commit-time
    // staleness check. So with edit A in flight and
    // edit B published optimistically on top of it, link A landing hands the store
    // the {A}-only map — B's pick visibly reverts for a frame, and an edit C
    // composed in that window builds on {A} and silently drops B from the file.
    // Deterministic on every rapid two-edit gesture (this is the same window the
    // test above holds open on purpose).
    //
    // The assertion is the STORE TRACE (see `traceAgentOverrides`): the end state
    // is what the buggy code also eventually reaches, so only the SEQUENCE shows
    // the regression. `settle()` is a macrotask turn — enough for the continuation
    // after a resolved `getSettings`/`saveSettings` to run and publish, which is
    // the exact moment the bug paints.
    const MODEL_ONLY = JSON.stringify({ scout: { model: "tama/Qwen3.8" } });
    const BOTH = JSON.stringify({
      scout: { model: "tama/Qwen3.8", thinking: "high" },
    });
    let releaseFirstSave!: () => void;
    mockedSaveSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstSave = resolve;
        }),
    );
    // The trace starts BEFORE any edit, so its first entry is the empty map and
    // every later entry is something the write path published.
    const trace = traceAgentOverrides();
    try {
      render(<SpacesList />);
      const dialog = await openAgentsModal();
      // Edit A: the model — its save is now provably in flight.
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Model for scout" }),
      );
      fireEvent.click(await screen.findByText("Qwen3.8"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mockedSaveSettings).toHaveBeenCalledTimes(1);
      // Edit B: the thinking level, composed on the optimistically-published map.
      fireEvent.click(
        within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
      );
      fireEvent.click(await screen.findByRole("option", { name: "high" }));
      // B's optimistic publish is in the trace, and nothing older has landed yet.
      expect(trace.seen()).toContain(BOTH);
      // Now land A. Its link still holds the {A}-only map.
      act(() => releaseFirstSave());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // THE FLICKER: after B published the two-field map, the store must never be
      // handed the {A}-only map again. (Read off the trace, not off the store — a
      // later link republishes the newer map, so the end state hides this.)
      const afterB = trace.seen().slice(trace.seen().indexOf(BOTH) + 1);
      expect(afterB).not.toContain(MODEL_ONLY);
      // End states, in the shape `two rapid edits both land` asserts them: the last
      // write is the file's answer and the store agrees with it. The count is
      // awaited FIRST — reading `calls[length-1]` before demanding both links were
      // issued makes the pass depend on the settle above having drained the queue,
      // i.e. on RTL internals rather than on the write chain.
      await waitFor(() =>
        expect(mockedSaveSettings.mock.calls.length).toBeGreaterThanOrEqual(2),
      );
      const lastSaved =
        mockedSaveSettings.mock.calls[
          mockedSaveSettings.mock.calls.length - 1
        ][0];
      expect(JSON.stringify(lastSaved.agentOverrides)).toBe(BOTH);
      expect(JSON.stringify(useSettings.getState().settings?.agentOverrides)).toBe(
        BOTH,
      );
    } finally {
      trace.stop();
    }
  });

  it("three edits while the first save is in flight keep the middle pick", async () => {
    // The gesture the flicker actually costs something in. With link A still in
    // flight, B publishes {A,B}; A's completion reverts the store to {A}; edit C is
    // then composed off the REVERTED store, so the map handed to the third write
    // never saw B and B is deleted from `settings.json` with no feedback. The
    // middle pick is the one the user cannot see being lost, because the picker
    // they are looking at is already showing C.
    //
    // BOTH of the first two saves are held open, so the window between link A's
    // publish and link B's is open for the whole time C is issued — the window the
    // bug lives in, made deterministic instead of a race. (Holding only the first
    // would let link B republish the two-field map before C happens, and the test
    // would pass for the wrong reason.)
    const deferred = (): { promise: Promise<void>; release: () => void } => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };
    const first = deferred();
    const second = deferred();
    mockedSaveSettings
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    // A — the model.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockedSaveSettings).toHaveBeenCalledTimes(1);
    // B — the thinking level.
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    // Link A lands and publishes while link B's save is still held — the exact
    // moment the store is holding the OLDER map.
    act(() => first.release());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockedSaveSettings).toHaveBeenCalledTimes(2);
    // C — a tool tick, composed off whatever the store is holding right now.
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Override tool grep for scout" }),
    );
    // Let C's link start its save, then land B's (the queued one).
    act(() => second.release());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() =>
      expect(mockedSaveSettings.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    // End states (same shape as `two rapid edits both land`): the LAST document
    // written carries all three fields, and the store agrees with the file.
    const lastSaved =
      mockedSaveSettings.mock.calls[mockedSaveSettings.mock.calls.length - 1][0];
    expect(lastSaved.agentOverrides).toEqual({
      scout: { model: "tama/Qwen3.8", thinking: "high", tools: ["grep"] },
    });
    await waitFor(() =>
      expect(useSettings.getState().settings?.agentOverrides.scout).toEqual({
        model: "tama/Qwen3.8",
        thinking: "high",
        tools: ["grep"],
      }),
    );
  });

  it("a slow first save cannot land after the second edit's save (out-of-order writes)", async () => {
    // The other half of the same gesture, and the half the store's optimistic
    // publish CANNOT fix: two `saveSettings` calls are two independent IPC round
    // trips, so the FIRST one can resolve LAST and write the older map over the
    // newer file. The chain in `patchAgentOverrides` is what makes "last edit
    // wins" mean the last map the user produced rather than whichever round trip
    // finished second.
    //
    // Deterministic instead of racy: call 1's save is held open, call 2's resolves
    // at once (the factory's default). Unserialized, call 2 writes both fields
    // first and call 1 then writes the model-only map on top of it; serialized,
    // call 2 does not even start until call 1 has landed.
    let releaseFirstSave!: () => void;
    mockedSaveSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstSave = resolve;
        }),
    );
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    // Let whatever is queued settle, THEN land the first save. Anything that
    // writes after this point is the last word the file gets.
    await act(async () => {
      await Promise.resolve();
    });
    act(() => releaseFirstSave());
    // A REAL settle (not a bare `waitFor`, which would pass on the store's state
    // from BEFORE the late save landed — the exact state the bug leaves behind):
    // each successful save publishes its own document, so the store now reports
    // what the LAST-RESOLVING write wrote, i.e. what the file ends up holding.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useSettings.getState().settings?.agentOverrides.scout).toEqual({
      model: "tama/Qwen3.8",
      thinking: "high",
    });
    // The settle above is what makes the SECOND save exist, but it is a fact about
    // macrotask ordering; the read below takes the last call, so the count is what
    // has to be demanded.
    await waitFor(() =>
      expect(mockedSaveSettings.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    const lastSaved =
      mockedSaveSettings.mock.calls[mockedSaveSettings.mock.calls.length - 1][0];
    expect(lastSaved.agentOverrides).toEqual({
      scout: { model: "tama/Qwen3.8", thinking: "high" },
    });
  });

  it("a failed save does not strand the edit after it (the chain stays alive)", async () => {
    // The chain is a promise held in a ref, so a rejection would be POISON: every
    // later link would resolve to that same stale rejection and no subsequent edit
    // would ever reach the file. The write helper swallows its own error (log +
    // re-seed) precisely so the chain survives a failed link.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedSaveSettings.mockRejectedValueOnce(new Error("boom"));
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    // Edit 1 fails.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to save agent overrides:",
        expect.anything(),
      ),
    );
    // Edit 2 still reaches the file.
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    await waitFor(() =>
      expect(mockedSaveSettings.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    // …and the map that landed carries the second edit.
    const lastSaved =
      mockedSaveSettings.mock.calls[mockedSaveSettings.mock.calls.length - 1][0];
    expect(lastSaved.agentOverrides.scout?.thinking).toBe("high");
  });

  it("a throwing failure logger does not poison the chain (the swallow is structural)", async () => {
    // The swallow's own failure mode. A `catch` block inside `writeAgentOverrides`
    // makes the swallow depend on the error HANDLER being infallible: if
    // `console.error` itself throws — a broken logger, an environment that throws
    // on logging, a re-seed that throws — the CATCH throws, the link resolves to a
    // REJECTION, and every write chained after it silently resolves to that same
    // stale rejection without touching the file. The modal keeps looking like it
    // saves (the optimistic publish is synchronous) forever after.
    //
    // So the swallow belongs on the CHAIN LINK, not only inside the helper: nothing
    // the failure path does can then disable the queue. This test is the difference
    // between those spellings — with the swallow inside the helper it fails, because
    // the poisoned link eats edit 2's save entirely (`saveSettings` is never called a
    // second time).
    //
    // Which half of the link's TWO swallows reddens this test — measured, because the
    // comment used to credit the wrong one: deleting the TRAILING `.catch` fails the
    // run (exit 1) with an UNHANDLED REJECTION pointing at this test's `console.error`
    // spy, because the call site `void`s the link and the mount has nowhere to attach
    // a handler; deleting the LEADING one stays green, since the trailing half covers
    // the same rejection AND the promise stored in the ref is the swallowed one. The
    // leading half is belt-and-braces for link order, and this test pins it not at
    // all — see the `patchAgentOverrides` comment for the division of labour.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        throw new Error("the logger is broken too");
      });
    mockedSaveSettings.mockRejectedValueOnce(new Error("boom"));
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    // Edit 1 fails, and handling that failure fails as well.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    // Edit 2 still reaches the file.
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    await waitFor(() =>
      expect(mockedSaveSettings.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    const lastSaved =
      mockedSaveSettings.mock.calls[mockedSaveSettings.mock.calls.length - 1][0];
    expect(lastSaved.agentOverrides.scout?.thinking).toBe("high");
  });

  it("a landed save still evicts the catalog when the store publish throws (and is not logged as a save failure)", async () => {
    // The other half of making the swallow STRUCTURAL: what the error handler
    // COVERS. Today `setSettings` sits inside the same `try` as the save and the
    // eviction, so a publish that throws after a save that LANDED is reported as
    // "Failed to save agent overrides" — a lie about a write the file has — and the
    // eviction after it is skipped, so the modal keeps serving `runs` columns
    // resolved against the map that edit replaced.
    //
    // The two facts are independent: the save landed (→ evict, → do not log a save
    // failure), and the store mirror failed (→ the store lags, nothing more). So the
    // publish is the one step the epoch guard already stands in front of, and the
    // eviction happens whatever the publish does.
    const realPublish = useSettings.getState().setSettings;
    let publishes = 0;
    // Replaced ON THE LIVE STATE OBJECT (not `vi.spyOn(getState(), …)`): zustand
    // `set` builds a NEW state object on every write, so a spy installed on the old
    // one is what gets restored, and the live store would keep the spy.
    const publish = (document: AppSettings) => {
      publishes += 1;
      // Call 1 is the optimistic publish in `patchAgentOverrides` — let it through,
      // or the modal never re-renders and the second edit cannot happen. Call 2 is
      // the success mirror, and it is the one that throws.
      if (publishes > 1) throw new Error("store publish failed");
      realPublish(document);
    };
    useSettings.setState({ setSettings: publish });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = render(<SpacesList />);
      const dialog = await openAgentsModal();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Model for scout" }),
      );
      fireEvent.click(await screen.findByText("Qwen3.8"));
      await waitFor(() => expect(mockedSaveSettings).toHaveBeenCalledTimes(1));
      // Let the success path run to completion (the throw is inside it).
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // A save that landed is not a save failure.
      expect(consoleError).not.toHaveBeenCalledWith(
        "Failed to save agent overrides:",
        expect.anything(),
      );
      // …and the catalog the edit invalidated is gone anyway — the assertion the
      // eviction test uses (the next MOUNT of the hook, since the pane owns the
      // fetch): unmount and re-mount with the same Space key.
      expect(mockedListAgentConfig).toHaveBeenCalledTimes(1);
      first.unmount();
      render(<SpacesList />);
      await waitFor(() =>
        expect(mockedListAgentConfig).toHaveBeenCalledTimes(2),
      );
    } finally {
      useSettings.setState({ setSettings: realPublish });
      consoleError.mockRestore();
    }
  });

  it("logs a console error when saving Agent overrides fails (the store re-seeds from the file)", async () => {
    // The failure arm of the one write path, in this file's established shape for
    // that class (`logs a console error when Archive fails`, Unfail, Delete): the
    // rejection is LOGGED (no unhandled rejection in the webview) and the state
    // ends up agreeing with the FILE.
    //
    // The second half matters more here than it does for the archive move, because
    // the write path publishes the edited map into the store OPTIMISTICALLY before
    // the save resolves. A save that did not land therefore leaves the store
    // claiming an override the file has never seen — and the NEXT edit would be
    // composed on top of it. The re-fetch has to roll that back, so the fixture's
    // re-read carries a map that is NOT what the user picked.
    const fresh: AppSettings = {
      ...SETTINGS_FIXTURE,
      agentOverrides: { plan: { thinking: "high" } },
    };
    mockedGetSettings.mockResolvedValue(fresh);
    mockedSaveSettings.mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    // ...the rejection is logged...
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to save agent overrides:",
        expect.anything(),
      ),
    );
    // ...and the store ends up holding the RE-FETCHED document: the optimistic map
    // is gone, the file's map is back. (A store left holding `scout` would be the
    // lie — the picker would show a pin nothing saved.)
    await waitFor(() => expect(useSettings.getState().settings).toEqual(fresh));
    expect(useSettings.getState().settings?.agentOverrides.scout).toBeUndefined();
  });

  it("a failure re-seed that lands after a newer edit was published is discarded at commit", async () => {
    // The epoch guard's OTHER arm — the one the dispatch-time check did not cover.
    // Every link re-checks `isStale()` BEFORE it starts its work; the failure arm's
    // work is a whole `get_settings` round trip, and that round trip was never
    // re-checked at COMMIT. A re-seed that resolves after every later optimistic
    // publish therefore lands LAST and writes the FILE's older map into a store the
    // newer edit owns. Nothing publishes over it afterwards — the queue is drained —
    // so the store is left PERMANENTLY behind the file, and the next `patch`
    // composes from it: the wholesale map replace then DELETES from `settings.json`
    // a field the file still holds. That is the drop-a-write class this chain exists
    // to prevent, arriving through the rollback instead of through the publish.
    //
    // MECHANICS. The re-seed's read is held by the mock, so "still in flight" is a
    // state this test looks at rather than races:
    // - read #1 is edit A's in-`try` read (the read-modify-write);
    // - read #2 is THE RE-SEED's read — issued before the failure arm returns, so it
    //   is the second read under either spelling (`getSettings()` in the arm, or
    //   `loadSettings()` fetching internally), which is what makes this repro about
    //   the commit-time check and not about the mock's shape;
    // - read #3 is edit B's link read, and it resolves normally so B can complete.
    // Order of operations: A's save REJECTS → B is issued and its link SUCCEEDS and
    // publishes → only then is the held re-seed released.
    const fileDoc: AppSettings = {
      ...SETTINGS_FIXTURE,
      // A map the user never picked and never cleared: the FILE's answer, and the
      // document a clobbered store would be holding.
      agentOverrides: { plan: { thinking: "high" } },
    };
    const bDocument: AppSettings = {
      ...fileDoc,
      // B composes on A's OPTIMISTICALLY published map, so the map the user is
      // looking at — and the one the file ends up holding — carries both fields.
      agentOverrides: { scout: { model: "tama/Qwen3.8", thinking: "high" } },
    };
    let releaseReseed!: () => void;
    let reads = 0;
    mockedGetSettings.mockImplementation(() => {
      reads += 1;
      if (reads === 2) {
        return new Promise<AppSettings>((resolve) => {
          releaseReseed = () => resolve(fileDoc);
        });
      }
      return Promise.resolve(fileDoc);
    });
    // Edit A's save fails; edit B's lands.
    mockedSaveSettings.mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // Start the roll-counter record before this mount exists, so what it holds is
    // exactly what THIS mount handed the dialog (see `rollsSeen`).
    resetRolledBackWritesRecord();
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    // Edit A: the model — and its save is rejected, so the failure arm runs.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to save agent overrides:",
        expect.anything(),
      ),
    );
    // Edit B: issued while A's re-seed read is provably still held (nothing has
    // released it yet), so B publishes on top of a store whose rollback is pending.
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    // B's link ran to completion: demanded by the COUNT before the last call is read
    // (the discipline the earlier tests in this file had to learn the hard way).
    await waitFor(() =>
      expect(mockedSaveSettings.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() =>
      expect(useSettings.getState().settings?.agentOverrides.scout).toEqual({
        model: "tama/Qwen3.8",
        thinking: "high",
      }),
    );
    const savedByB =
      mockedSaveSettings.mock.calls[
        mockedSaveSettings.mock.calls.length - 1
      ][0];
    expect(savedByB.agentOverrides).toEqual(bDocument.agentOverrides);
    // The roll counter BEFORE the re-seed is allowed to answer: A's save failed, but
    // nothing has been rolled back YET — the rollback IS the re-seed's publish, and
    // that read is still held. So the mount has nothing to have told the dialog, and
    // the counter it hands down is still the zero it mounted at (B, a SUCCEEDING
    // link, never touches it either).
    expect(rollsSeen).toEqual([0]);
    // NOW the held re-seed resolves — after B's publish, which is the race.
    act(() => releaseReseed());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // THE CLOBBER: a re-seed that arrives this late carries the file's map from
    // BEFORE B, and B is gone from the store mirror. The store mirror is what the
    // next edit composes from, so this is not a flicker — it is the poisoned
    // composition, with no later link left to republish over it.
    expect(useSettings.getState().settings).not.toEqual(fileDoc);
    // …and stated positively: the released re-seed leaves the store where B left it,
    // i.e. still agreeing with the file B just wrote.
    expect(useSettings.getState().settings).toEqual(bDocument);
    // THE OTHER HALF OF THE DISCARD: nothing was reported either. `onRolledBack`
    // moved next to the publish precisely because a discarded re-seed rolled NOTHING
    // back — the file already holds B's write, and A's field is being carried by B's
    // composed map, so there is no unexplained difference for the modal to re-arm.
    // An increment here would be the mount claiming a rollback that never happened,
    // and the dialog's stamp would drop the `edited` suppression for a write the user
    // did make: the stored-pin cue then re-appears to blame the last fetch for a
    // difference this modal caused. Read as the whole record (not the last value), so
    // a roll that moved and moved back cannot slip past.
    expect(rollsSeen).toEqual([0]);
  });

  it("a failed save re-arms the stored-pin cue the failed edit explained nothing about", async () => {
    // The cue's suppression has a half-life. A field the user wrote in this mount is
    // skipped, because the difference against the FETCH-time `row.override` column is
    // explained by a save the backend already has. A save that DID NOT LAND takes
    // that explanation away: the failure path re-fetches, so the store goes back to
    // the FILE's map and the difference is again one this modal did not cause — the
    // fetch predating the file, which is exactly the case the cue exists to name. If
    // the suppression survives the failure, the row silently hides a stale-column
    // disagreement forever after, for a gesture that never happened.
    //
    // The fixture wires that case end to end: the fetched row says the stored pin was
    // `max`, the FILE says `low`, and the store starts with no pin at all — so the cue
    // is legitimately up at mount, the pick suppresses it, and only the rollback can
    // bring it back.
    const fresh: AppSettings = {
      ...SETTINGS_FIXTURE,
      agentOverrides: { scout: { thinking: "low" } },
    };
    mockedGetSettings.mockResolvedValue(fresh);
    // The save is held open, so "in flight" is a state the test can look at: the
    // rejection has to arrive on the test's schedule or the suppressed window is
    // over before the assertion runs.
    let failSave!: () => void;
    mockedSaveSettings.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failSave = () => reject(new Error("boom"));
        }),
    );
    mockedListAgentConfig.mockResolvedValue([
      agentRow({ override: { model: null, thinking: "max", tools: null, permission: null } }),
    ]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    // Mount: the fetch's column (`max`) and the store's map (no pin) disagree, and
    // nothing in this modal caused that.
    expect(
      await screen.findByText(/stored pin the last fetch saw differs/),
    ).toBeTruthy();
    // The edit: `high`, and its save is provably still in flight.
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    await waitFor(() => expect(mockedSaveSettings).toHaveBeenCalledTimes(1));
    // The difference is explained by a save the backend is being told about, so the
    // cue goes quiet for that field.
    expect(
      screen.queryByText(/stored pin the last fetch saw differs/),
    ).toBeNull();
    // The save fails and the store rolls back to the FILE's map (`low`).
    act(() => failSave());
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to save agent overrides:",
        expect.anything(),
      ),
    );
    await waitFor(() => expect(useSettings.getState().settings).toEqual(fresh));
    // THE RE-ARM: the suppressed edit never landed, so the `max`-vs-`low`
    // disagreement is unexplained again and the row has to say it.
    const cue = await screen.findByText(/stored pin the last fetch saw differs/);
    expect(cue.textContent).toContain("thinking max");
  });

  it("a successful save evicts the Agent catalog (no stale runs after an edit)", async () => {
    // `useAgentCatalog` caches the in-flight promise per Space on purpose (rule 3
    // of the hook's four rules): an UNCHANGED key never evicts, so a remount reuses
    // the settled entry instead of re-running a NETWORK-BOUND discovery. That is
    // right for a remount that changes nothing, and wrong after a WRITE — `runs` is
    // "what the last fetch saw the dispatch launch with", and the map that fetch
    // resolved against has just been replaced. Invalidation-on-write is what rule
    // 3 assumed someone would add if a writer ever appeared; this is that writer.
    //
    // The assertion is about the next MOUNT of the hook, because that is what the
    // eviction can affect: the catalog is fetched by the PANE (the dialog is
    // prop-driven), so re-opening the modal inside one pane mount cannot re-run the
    // effect — the rows it renders were fetched at mount. Unmounting the pane (the
    // Settings view does exactly that) and mounting it again with the SAME key is
    // the case the cache would otherwise serve a pre-edit answer for.
    const first = render(<SpacesList />);
    const dialog = await openAgentsModal();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    await waitFor(() => expect(mockedSaveSettings).toHaveBeenCalledTimes(1));
    // One fetch so far — the mount's.
    expect(mockedListAgentConfig).toHaveBeenCalledTimes(1);
    // …the pane unmounts (Settings view) and mounts again, same Space key…
    first.unmount();
    render(<SpacesList />);
    // …and the catalog is re-fetched rather than served from the entry the write
    // invalidated.
    await waitFor(() => expect(mockedListAgentConfig).toHaveBeenCalledTimes(2));
  });

  // ---------------------------------------------------------------------------
  // D2's MIGRATION PINS (characterisation tests, written against the code as it
  // stood BEFORE `useAgentOverridesWrites` was wired in).
  //
  // The modal-level suite above already pins the write chain's ordering (read-
  // modify-write, serialization, the epoch in both arms, the swallow, eviction).
  // These two pin the ONLY two facts about that chain that no test above reads —
  // and both are things a hook extraction can move without reddening anything
  // else: the counter the dialog's suppression is stamped against, and the
  // document the render gate reads. They are written against today's behaviour
  // and must stay green across the migration; `useAgentOverridesWrites.test.ts`
  // pins the same properties at hook level, so a loss in either direction shows.
  // ---------------------------------------------------------------------------

  it("a rolled-back write moves the counter the dialog's suppression is stamped against", async () => {
    // The chain's failure arm does two observable things: log (pinned above) and
    // re-seed the store (pinned above). What nothing above reads is the THIRD: the
    // `rolledBackWrites` counter the mount hands the dialog. `a failure re-seed …
    // is discarded at commit` pins that it does NOT move for a STALE link, and the
    // stored-pin-cue test pins its downstream effect in the DOM — but the fresh
    // link's increment, the case the dialog's `edits` stamp is invalidated by, was
    // never read. Without it, a migration that dropped `onRolledBack` would leave
    // the cue test green (its rows carry the column disagreement the cue reads
    // directly) while the suppression stamp silently stops moving.
    const fresh: AppSettings = {
      ...SETTINGS_FIXTURE,
      agentOverrides: { plan: { thinking: "high" } },
    };
    mockedGetSettings.mockResolvedValue(fresh);
    mockedSaveSettings.mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    resetRolledBackWritesRecord();
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to save agent overrides:",
        expect.anything(),
      ),
    );
    // The rollback's re-seed is what the counter reports, so it moves WITH the
    // publish — i.e. only after the store has gone back to the file's map.
    await waitFor(() => expect(useSettings.getState().settings).toEqual(fresh));
    await waitFor(() => expect(rollsSeen).toEqual([0, 1]));
  });

  it("holds the Agents dialog back while there is no settings document, and keeps the button clickable", async () => {
    // The render gate `agentsOpen && settings &&`. It is a behaviour of the
    // document read, and after D2 that read is the hook's `settings` field, so it
    // is pinned here rather than assumed: with no document the modal has nothing
    // correct to edit (it reads `agentOverrides` off the document), so NOTHING
    // mounts — while the button stays a live control, because disabling it would
    // make a boot-load failure look like a dead pane.
    useSettings.setState({ settings: null });
    render(<SpacesList />);
    const button = screen.getByRole("button", { name: "Agents" });
    fireEvent.click(button);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Drain the mount's two catalog fetches INSIDE `act` so this test adds no
    // "not wrapped in act" stderr of its own (the pane's `listModels`/`listTools`
    // promises settle after the assertions above, and a late `setModels` outside
    // `act` is noise a new test should not leave behind).
    await act(async () => {});
  });
});

describe("SpacesList (archive, ADR 0016)", () => {
  /** Seed an archived (flag-on) stored session in the `alpha` space.
   * `messages` (when given) makes the row's title message-derived. */
  function seedArchived(
    id: string = "a1",
    opts: { live?: boolean; messages?: { text: string; at: number } } = {},
  ): void {
    const row = makeSessionRow({
      sessionId: id,
      cwd: "/tmp/alpha",
      archived: true,
    });
    useSessions.setState({
      sessions: opts.live ? [row] : [],
      archivedSessions: [row],
      activeSessionId: id,
      ...(opts.messages
        ? { messages: { [id]: [makeMessage("user", opts.messages)] } }
        : {}),
    });
  }

  /**
   * Scope a query to ONE row. A row is itself `role="button"` and its inner
   * buttons carry `aria-label`s beginning with the action verb, so a whole-
   * document `getByRole("button", { name: "Stop …" })` is not the problem — but
   * a LOOSE regex (`/Stop/`) would match the row too, and worse: in a render
   * where `s1` is live and `h1` is stored, an unscoped query cannot tell which
   * row's button it found. The `.closest('[role="button"]')` step is this file's
   * own row-locating pattern (see the mark tests above).
   *
   * TYPED as the bound-query object `within` returns rather than as the row
   * element, so callers write `rowOf(… ).getByRole(…)` directly. (Annotating it
   * `HTMLElement` — the element `within` was handed — does not compile: `tsc`
   * then rejects every `.getByRole` call, and `build` is the type gate here.)
   */
  const rowOf = (text: string): ReturnType<typeof within> =>
    within(screen.getByText(text).closest('[role="button"]') as HTMLElement);

  it("a stored row offers an Archive hover action that archives it", async () => {
    render(<SpacesList />);
    // `h1`'s title is "Refactor the parser" (its first user message).
    fireEvent.click(
      screen.getByRole("button", { name: "Archive Refactor the parser" }),
    );
    // The store action moved the entry (the backend call resolved via
    // the mock) — `historySessions` lost it, `archivedSessions` gained it.
    await waitFor(() => {
      const { archivedSessions, historySessions } = useSessions.getState();
      expect(
        archivedSessions.some((s) => s.sessionId === "h1"),
      ).toBe(true);
      expect(
        historySessions.some((s) => s.sessionId === "h1"),
      ).toBe(false);
    });
    expect(vi.mocked(setSessionArchived)).toHaveBeenCalledWith("h1", true);
  });

  it("a live in-turn row offers Stop and Archive, and Stop cancels the turn", async () => {
    // The fixture's live `s1` is IN A TURN (`inTurn: { s1: true }`), so Stop
    // must CANCEL the turn — the Worker is kept, the row stays live.
    render(<SpacesList />);
    const stop = rowOf("Fix the login bug").getByRole("button", {
      name: "Stop Fix the login bug",
    });
    // The tooltip promises the turn-level meaning, and it reads the SAME field
    // the store branches on — a row whose hover said "Stop this session" while
    // cancelling a turn would be a promise the click breaks. (No `toHaveAttribute`
    // here: this repo's vitest setup carries no jest-dom.)
    expect(stop.getAttribute("title")).toBe("Stop this turn");
    fireEvent.click(stop);
    await waitFor(() => expect(cancelSession).toHaveBeenCalledWith("s1"));
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("a live idle row's Stop closes the Session", async () => {
    // Same button, different turn state: with nothing in flight there is no
    // turn to cancel, so Stop reaps the Worker (`closeSession`). The branch is
    // read at CLICK time inside `stopSession`, which is why the `setState` below
    // needs no re-render of the row to take effect.
    render(<SpacesList />);
    act(() => useSessions.setState({ inTurn: {} }));
    const stop = rowOf("Fix the login bug").getByRole("button", {
      name: "Stop Fix the login bug",
    });
    // …and the tooltip follows the turn state down to the session-level wording.
    expect(stop.getAttribute("title")).toBe("Stop this session");
    fireEvent.click(stop);
    await waitFor(() => expect(closeSession).toHaveBeenCalledWith("s1"));
    expect(cancelSession).not.toHaveBeenCalled();
  });

  it("Archive on a live row sets the flag then closes the Session", async () => {
    // The ORDER is the design, not a detail: the flag commits and the row moves
    // BEFORE the close, so when `session-closed` lands the store's sticky guard
    // files the row under `archivedSessions` instead of flickering it through
    // the Space group. Close-first would race that async event.
    render(<SpacesList />);
    fireEvent.click(
      rowOf("Fix the login bug").getByRole("button", {
        name: "Archive Fix the login bug",
      }),
    );
    await waitFor(() => expect(closeSession).toHaveBeenCalledWith("s1"));
    expect(setSessionArchived).toHaveBeenCalledWith("s1", true);
    const flagCall = vi
      .mocked(setSessionArchived)
      .mock.calls.findIndex(([id]) => id === "s1");
    const closeCall = vi
      .mocked(closeSession)
      .mock.calls.findIndex(([id]) => id === "s1");
    expect(flagCall).toBeGreaterThanOrEqual(0);
    expect(closeCall).toBeGreaterThanOrEqual(0);
    expect(
      vi.mocked(setSessionArchived).mock.invocationCallOrder[flagCall]!,
    ).toBeLessThan(
      vi.mocked(closeSession).mock.invocationCallOrder[closeCall]!,
    );
    // …and the row landed where Archive puts it.
    await waitFor(() => {
      const { archivedSessions } = useSessions.getState();
      expect(archivedSessions.some((s) => s.sessionId === "s1")).toBe(true);
    });
  });

  it("a stored row offers no Stop button", () => {
    // Stop is a LIVE-row action: a stored Session has no Worker to stop, so
    // `stopSession` would no-op and the button would be a lie. Scoping to the
    // row is what makes this assertion mean anything — `s1` is live in the same
    // render and DOES have a Stop, so a document-wide query finds one either
    // way.
    render(<SpacesList />);
    const row = rowOf("Refactor the parser");
    expect(row.queryByRole("button", { name: /^Stop / })).toBeNull();
    expect(
      row.getByRole("button", { name: "Archive Refactor the parser" }),
    ).toBeTruthy();
  });

  it("a live row offers Stop and Archive, and still no Pause (the pause concept is gone)", () => {
    // The INVERTED assertion of the test this replaces. Live rows used to render
    // the time with no swap at all — Pause was deleted and nothing took its
    // place, so a running Session could not be stopped or put away without
    // opening it. It now swaps like every other row does; the pause concept
    // stays gone, which is the half of the old test still worth pinning.
    render(<SpacesList />);
    const row = rowOf("Fix the login bug");
    expect(row.queryByRole("button", { name: /Pause/ })).toBeNull();
    expect(
      row.getByRole("button", { name: "Stop Fix the login bug" }),
    ).toBeTruthy();
    expect(
      row.getByRole("button", { name: "Archive Fix the login bug" }),
    ).toBeTruthy();
    // The time is still what the row shows at rest (the buttons are hover-only —
    // and jsdom applies no CSS, so "present in the DOM" is not proof of that;
    // what this pins is that the swap keeps the time node in the row).
    expect(row.getByText("now")).toBeTruthy();
  });

  it("Stop and Archive swallow the row's own click-to-open", () => {
    // Both buttons sit INSIDE the row, and the row's click is "open this
    // Session". Without `stopPropagation` a click on Stop would also open the
    // Session it just stopped (and Archive would open the row it just filed
    // away) — the sidebar would fight the command the user just gave.
    //
    // The probe is `activeSessionId`, which ONLY the row's own `onOpen`
    // (`openSession`) writes, and it is deliberately parked on `h2` — a id
    // neither button belongs to. Left at the seed's `s1`, a leaked click on `s1`'s
    // Stop would re-select `s1` and the assertion would pass for the wrong
    // reason.
    useSessions.setState({ activeSessionId: "h2" });
    render(<SpacesList />);
    fireEvent.click(
      rowOf("Refactor the parser").getByRole("button", {
        name: "Archive Refactor the parser",
      }),
    );
    expect(useSessions.getState().activeSessionId).toBe("h2");
    fireEvent.click(
      rowOf("Fix the login bug").getByRole("button", {
        name: "Stop Fix the login bug",
      }),
    );
    expect(useSessions.getState().activeSessionId).toBe("h2");
  });

  it("the Archived section is collapsed by default and lists archived sessions", () => {
    seedArchived("a1", {
      messages: { text: "Archive the logs", at: Date.now() - 3_600_000 },
    });
    render(<SpacesList />);
    // The header renders (with the count badge) even when collapsed…
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    // …and the row is NOT rendered while collapsed. (The prefix match is
    // retained from when the title carried a `· alpha` suffix span; the span is
    // gone now that the section is Space-scoped, but the assertion still reads.)
    expect(screen.queryByText(/^Archive the logs/)).toBeNull();
    // Expanding the section (clicking the header) reveals the row.
    fireEvent.click(screen.getByText("Archived"));
    expect(screen.getByText(/^Archive the logs/)).toBeTruthy();
  });

  /** One archived row of ANOTHER Space (`/tmp/beta`), appended to whatever the
   * store already holds. A generated `title` so the row's text is queryable
   * without seeding a transcript for it.
   *
   * APPENDS (it reads the store's current `archivedSessions` and adds to it), so
   * it is order-sensitive relative to `seed()`: call it AFTER the seed (or after
   * any other archived seeding) whose rows you mean to keep alongside, and note
   * that `seed()` — called from the file's `beforeEach` — resets
   * `archivedSessions` to `[]`, so nothing survives from an earlier test. */
  function seedArchivedElsewhere(
    id: string,
    title: string,
    cwd: string = "/tmp/beta",
  ): void {
    useSessions.setState((s) => ({
      archivedSessions: [
        ...s.archivedSessions,
        makeSessionRow({ sessionId: id, cwd, archived: true, title }),
      ],
    }));
  }

  it("lists ONLY the active Space's archived rows (another Space's row renders nowhere)", () => {
    // The section is Space-scoped (ADR 0016, amended 2026-10-21): `beta` has an
    // open tab but is NOT the selected Space, so its archived row renders in no
    // group of this sidebar at all (a row of a Space with NO tab is in the same
    // boat — it is **Detached** and lives in Settings → Detached sessions, and
    // there is deliberately NO fallback listing here).
    seedArchived("a1", {
      messages: { text: "Archive the logs", at: Date.now() - 3_600_000 },
    });
    seedArchivedElsewhere("b1", "Beta archived work");
    // A GENUINELY Detached row: `/tmp/detached` matches NO entry in the file's
    // `spaces` fixture (seed() opens `/tmp/alpha` and `/tmp/beta` only), so this
    // is the case the component's doc comment calls out — no tab, therefore no
    // fallback listing anywhere in the sidebar.
    seedArchivedElsewhere("d1", "Detached archived work", "/tmp/detached");
    // `activeSpacePath` is `/tmp/alpha` (the file's `seed()` fixture).
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    // The active Space's row is there…
    expect(screen.getByText(/^Archive the logs/)).toBeTruthy();
    // …and the other Space's row is absent from the WHOLE document, not merely
    // from the section (it must not be re-filed into a Space group either).
    expect(screen.queryByText("Beta archived work")).toBeNull();
    // …and so is the Detached row: with no Space of its own it is listed ONLY in
    // Settings → Detached sessions.
    expect(screen.queryByText("Detached archived work")).toBeNull();
  });

  it("the header count counts the active Space's rows only", () => {
    // One `alpha` row + two `beta` rows: the badge reads 1, not 3 — the count is
    // the SAME predicate the rows are filtered by, so the header cannot advertise
    // rows the expanded section will not show.
    //
    // The `alpha` row carries a message so its label is queryable (an untitled,
    // transcript-less row falls back to the SPACE name, which other rows render
    // too and which would make the row-count assertion below ambiguous).
    seedArchived("a1", {
      messages: { text: "Trimming the archived logs", at: Date.now() - 3_600_000 },
    });
    seedArchivedElsewhere("b1", "Beta archived work one");
    seedArchivedElsewhere("b2", "Beta archived work two");
    render(<SpacesList />);
    // Scoped to the header row (`rowOf`): a bare `getByText("1")` would match a
    // count anywhere else in the pane.
    expect(rowOf("Archived").getByText("1")).toBeTruthy();
    expect(rowOf("Archived").queryByText("3")).toBeNull();
    // THE JOINT PROPERTY, in ONE render: the badge's `1` is the number of rows
    // the expanded section actually shows. Both derive from the same `visible`
    // array today, so nothing here fails on the current code — this pins the
    // refactor that SPLITS the two (a count computed before the filter, or a row
    // list filtered differently from the badge) and would otherwise show a
    // header advertising rows that never appear.
    fireEvent.click(screen.getByText("Archived"));
    // Exactly ONE rendered row for the active Space (length, not mere presence —
    // a duplicated row would break the equality with the badge)…
    expect(screen.getAllByText(/^Trimming the archived logs/)).toHaveLength(1);
    // …and NEITHER of the two `beta` rows the badge refused to count is rendered.
    expect(screen.queryByText("Beta archived work one")).toBeNull();
    expect(screen.queryByText("Beta archived work two")).toBeNull();
  });

  it("lists the Archived rows in RECENCY order when the store's input order (the Manual order) disagrees", () => {
    // THE LIVE DEFECT ADR 0075 predicted. The section rendered
    // `archived.filter(…)` in INPUT order and inherited recency for free, because
    // `list_sessions` used to sort by the last-activity expression. T01 swapped
    // that `ORDER BY` to the Manual order, so the same filter has been presenting
    // a manual arrangement under a heading that means recency — and passing every
    // archived test in this file, because not one of them asserted the ORDER.
    //
    // TWO COMPETING ANSWERS: input order (what the component does today, and what
    // the Manual order now means) answers "first" then "last"; the store's
    // `archivedInSpace` explicit recency sort answers "last" then "first".
    // Flipping the two `sessionRecency` values flips the expectation, so this
    // cannot pass by accident.
    //
    // `sessions`/`historySessions` are emptied so nothing else competes for the
    // DOM positions; both rows carry a generated `title`, so no transcript is
    // needed for the labels to be queryable.
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [
        makeSessionRow({
          sessionId: "a_first",
          cwd: "/tmp/alpha",
          archived: true,
          title: "Archived first in the manual order",
        }),
        makeSessionRow({
          sessionId: "a_second",
          cwd: "/tmp/alpha",
          archived: true,
          title: "Archived last in the manual order",
        }),
      ],
      // `a_second` is the RECENT one (a far-future stamp, never arithmetic that
      // can tie) while the input order puts it SECOND.
      sessionRecency: { a_first: 1_000, a_second: 9_000_000_000_000 },
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    const firstInManual = screen.getByText("Archived first in the manual order");
    const lastInManual = screen.getByText("Archived last in the manual order");
    expect(
      lastInManual.compareDocumentPosition(firstInManual) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // …and the BADGE still counts the array the rows came from (the joint
    // property "the header count counts the active Space's rows only" pins for
    // the cross-Space case; this closes the SORT half of it). Scoped to the
    // header row — a bare `getByText("2")` would match a count anywhere in the
    // pane.
    expect(rowOf("Archived").getByText("2")).toBeTruthy();
  });

  it("renders the empty state with NO Space selected, even though archived rows exist", () => {
    // `cwd === activeSpacePath` matches nothing when no Space is selected, which
    // is honest: those rows are Detached (CONTEXT.md) and live in Settings →
    // Detached sessions. The section still renders (header + empty state) rather
    // than silently disappearing.
    seedArchived("a1", {
      messages: { text: "Archive the logs", at: Date.now() - 3_600_000 },
    });
    useSessions.setState({ activeSpacePath: null });
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    expect(screen.getByText("No archived sessions.")).toBeTruthy();
    expect(screen.queryByText(/^Archive the logs/)).toBeNull();
  });

  it("unarchive moves the row back", async () => {
    seedArchived();
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByRole("button", { name: /Unarchive/ }));
    await waitFor(() => {
      const { archivedSessions, historySessions } = useSessions.getState();
      expect(
        archivedSessions.some((s) => s.sessionId === "a1"),
      ).toBe(false);
      expect(
        historySessions.some((s) => s.sessionId === "a1"),
      ).toBe(true);
    });
    expect(vi.mocked(setSessionArchived)).toHaveBeenCalledWith("a1", false);
  });

  it("delete from the Archived section confirms and removes", async () => {
    seedArchived();
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    // The destructive action opens the confirm dialog.
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(screen.getByText("Delete session?")).toBeTruthy();
    // Cancel: the row remains, the dialog closes.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Delete session?")).toBeNull();
    expect(
      useSessions.getState().archivedSessions.some((s) => s.sessionId === "a1"),
    ).toBe(true);
    // Delete: the row vanishes from the store and the dialog closes.
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        useSessions.getState().archivedSessions.some((s) => s.sessionId === "a1"),
      ).toBe(false),
    );
    expect(screen.queryByText("Delete session?")).toBeNull();
    expect(mockedDeleteSession).toHaveBeenCalledWith("a1");
  });

  it("a live session that is also archived is view-filtered out of the Archived section", () => {
    seedArchived("a1", { live: true, messages: { text: "Both lists", at: Date.now() - 10_000 } });
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    // The row renders exactly ONCE — as the live row in its Space group
    // (the sticky live id is view-filtered out of the Archived section).
    // Prefix match retained from when the row's title carried a `· alpha`
    // suffix span (that span is gone — the section is Space-scoped now); the
    // count is what this test pins.
    expect(screen.getAllByText(/^Both lists/)).toHaveLength(1);
  });

  it("New Session with an archived session active starts a conversation in that space (not the Open Space dialog)", async () => {
    seedArchived();
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: /New Session/ }));
    // The `activeView` predicate matches via `archivedSessionIds` → the
    // hook starts a native session in that space.
    await waitFor(() =>
      expect(mockedStartSession).toHaveBeenCalledWith("/tmp/alpha"),
    );
    // The negative pin, on the FLAG: "it did not fall back to the dialog" is the
    // claim, and `queryByText("New space")` could no longer express it — this pane
    // renders no dialog, so a text query there would pass for every input.
    expect(getNewSpaceDialogOpen()).toBe(false);
  });

  it("an archived-only active session still resolves its space for the skill catalog", async () => {
    seedArchived();
    render(<SpacesList />);
    // The `useSkillCatalog` input path (`activeSession ? undefined :
    // activeHistory ?? archivedSessions.find(…)`): the active session's
    // Space path, NOT `null` (which would silently degrade the catalog
    // to user-level skills). `listSkills` is called with the fetch key.
    await waitFor(() =>
      expect(mockedListSkills).toHaveBeenCalledWith("/tmp/alpha"),
    );
  });

  it("logs a console error when Archive fails (the row is NOT moved)", async () => {
    vi.mocked(setSessionArchived).mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    fireEvent.click(
      screen.getByRole("button", { name: "Archive Refactor the parser" }),
    );
    // The rejection is logged (no unhandled rejection in the webview)...
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to archive session:",
        expect.anything(),
      ),
    );
    // ...and the move did NOT land: the row is still a stored session.
    const { archivedSessions, historySessions } = useSessions.getState();
    expect(archivedSessions.some((s) => s.sessionId === "h1")).toBe(false);
    expect(historySessions.some((s) => s.sessionId === "h1")).toBe(true);
  });

  it("logs a console error when Unarchive fails (the row is NOT moved)", async () => {
    seedArchived();
    vi.mocked(setSessionArchived).mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByRole("button", { name: /Unarchive/ }));
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to unarchive session:",
        expect.anything(),
      ),
    );
    // The row is still archived (the mirror move did NOT land).
    const { archivedSessions, historySessions } = useSessions.getState();
    expect(archivedSessions.some((s) => s.sessionId === "a1")).toBe(true);
    expect(historySessions.some((s) => s.sessionId === "a1")).toBe(false);
  });

  it("closes the delete dialog and logs a console error when Delete fails (the row remains)", async () => {
    seedArchived();
    mockedDeleteSession.mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    // The dialog closes even on failure (a stuck-open dialog is worse
    // than a logged failure) — the close is deferred into the `.catch`,
    // so wait for it.
    await waitFor(() =>
      expect(screen.queryByText("Delete session?")).toBeNull(),
    );
    // ...and the rejection is logged (no unhandled rejection).
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to delete session:",
        expect.anything(),
      ),
    );
    // The row remains: the store's delete only lands after the command
    // resolves.
    expect(
      useSessions.getState().archivedSessions.some((s) => s.sessionId === "a1"),
    ).toBe(true);
  });

  // -- The `...` menu (moved from the tab bar to the `Sessions` header,
  // -- right-aligned, next to the word `Sessions`) --

  it("the `...` menu in the Sessions header starts a session in the ACTIVE space", async () => {
    const { startSession } = await import("../lib/tauri");
    // The seed's active space is `/tmp/alpha`.
    render(<SpacesList />);
    // The menu sits in the `Sessions` header row (right of the label).
    const header = screen.getByText("Sessions").parentElement!;
    expect(
      header.querySelector('[aria-label="Session actions"]'),
    ).toBeTruthy();
    // Radix opens on `pointerDown` (`click` does not open the menu in
    // jsdom).
    fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }));
    // NO Resume / NO Pause (the pause concept is gone — the old header's
    // dropdown invariant now applies to this menu): the menu holds ONLY
    // the item below.
    expect(screen.queryByRole("menuitem", { name: /Resume/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Pause/ })).toBeNull();
    // Selection: `Enter` on the item (Radix's keyboard selection model).
    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: "New Session in this Space" }),
      { key: "Enter" },
    );
    await waitFor(() =>
      expect(vi.mocked(startSession)).toHaveBeenCalledWith("/tmp/alpha"),
    );
  });

  // -- The pane holds NO controls at all: the collapse toggle and the Settings
  // -- gear both live in the chrome bar's `ChromeControls`, beside the window
  // -- controls (`App.tsx`, pinned by `App.test.tsx`'s `the chrome bar carries
  // -- the app controls`). What follows asserts the ABSENCE from this pane in
  // -- both states — the shape the move leaves behind. --

  for (const state of ["expanded", "collapsed"] as const) {
    it(`holds NO collapse toggle and NO gear while ${state} (both moved to the chrome bar)`, () => {
      act(() => {
        setLeftPaneCollapsed(state === "collapsed");
      });
      const { container } = render(<SpacesList />);
      // Every label the toggle has ever carried, plus the gear's, so a rename
      // cannot quietly re-add one of these two controls here and leave this
      // test vacuous. The pane's OWN commands (`Open Space`, `New Session`,
      // `Skills`, `Agents`) are NOT in this list — they legitimately survive the
      // collapse as rail icons, which is what the rail's own tests assert.
      for (const label of [
        "Collapse session list",
        "Expand session list",
        "Collapse sidebar",
        "Expand sidebar",
        "Settings",
      ]) {
        expect(screen.queryByRole("button", { name: label }), label).toBeNull();
      }
      // The STABLE hook, not the label: the label flips with the state, so a
      // name-only query could pass on one side of the collapse by accident.
      expect(container.querySelector('[data-testid="left-pane-toggle"]')).toBeNull();
      // The footer ROW is gone, not merely emptied. The pane's last child is
      // now the clipped content region (expanded) or the collapsed rail — both
      // of which DO hold buttons, so the check is which surface ends the pane,
      // not whether it holds any. A footer control strip would come last.
      const last = (container.firstChild as HTMLElement).lastElementChild!;
      const isContentRegion = last.contains(screen.getByText("Sessions"));
      const isRail = last.getAttribute("data-testid") === "session-rail";
      expect(
        isContentRegion || isRail,
        `the pane ends with a ${last.tagName}, not the content region or the rail`,
      ).toBe(true);
    });
  }

  it("takes its collapse from the shared flag with no control of its own", () => {
    // The pane is now a pure READER of `leftPaneState` — the writer sits in the
    // chrome bar — so collapsing from outside still resizes it. This is the
    // contract between `ChromeControls` (writer) and this pane (reader).
    const { container } = render(<SpacesList />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe("260px");
    act(() => {
      setLeftPaneCollapsed(true);
    });
    expect(getLeftPaneCollapsed()).toBe(true);
    expect(frame.style.width).toBe(`${LEFT_PANE_RAIL}px`);
    act(() => {
      setLeftPaneCollapsed(false);
    });
    expect(frame.style.width).toBe("260px");
  });

  it("collapses to the sliver (the content stays mounted, clipped, not unmounted)", () => {
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${LEFT_PANE_RAIL}px`);
    // The content (the `Sessions` label) is clipped (width 0 +
    // `overflow: hidden`) — NOT unmounted (the list's local state
    // survives a collapse; the `fixed` dialogs escape the clipping).
    expect(screen.getByText("Sessions")).toBeTruthy();
    // Expanding via the shared flag restores the full frame.
    act(() => {
      setLeftPaneCollapsed(false);
    });
    expect(frame.style.width).toBe("260px");
  });

  it("carries NO bg-warning FILL in either state, even with a pending request (the dot rides the chrome-bar toggle now)", () => {
    // The pane's own toggle used to wear a `bg-warning` dot while collapsed.
    // That button now lives in `ChromeControls`, so the pane keeps only the
    // ROW's cue — the `?` in `text-warning`, in both sidebar states. Asserted
    // in both states, because the collapsed rail is exactly where a leftover
    // dot would have been.
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha" }),
      ],
      activeSessionId: "s1",
    });
    usePermissions.setState({
      prompts: {
        s1: [{ requestId: "r1", toolTitle: "bash", options: [] }],
      },
    });
    for (const collapsedNow of [false, true]) {
      act(() => {
        setLeftPaneCollapsed(collapsedNow);
      });
      const { container: c } = render(<SpacesList />);
      expect(c.querySelector(".bg-warning"), `collapsed=${collapsedNow}`).toBeNull();
      // …and the row DOES carry its own cue, so the assertion above cannot be
      // satisfied by a pane that shows nothing at all.
      expect(c.querySelector('[data-dot="waiting"]'), `collapsed=${collapsedNow}`).toBeTruthy();
    }
  });

  it("collapses to the sliver: the session marks show, and NO text bleeds in", () => {
    // The two defects the rail replaces, both from one cause: the collapse is
    // width + `overflow: hidden` with the content kept MOUNTED, so the list
    // painted INTO the 40px sliver — the action buttons wrapped to one word per
    // line ("O / Sp / Se / Sk"), the `Sessions` header became "Sess", and the
    // scroller grew a scrollbar in a 40px column.
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${LEFT_PANE_RAIL}px`);
    // The rail: the ACTIVE space's sessions, one mark each (the fixture's
    // `alpha` = live `s1` in-turn + stored `h1`).
    const rail = screen.getByTestId("session-rail");
    expect(screen.getAllByTestId("session-row")).toHaveLength(2);
    // Running first (the list's own order: live, then stored) — the SPINNER,
    // the glyph the open row uses for the same fact. Queried by test id rather
    // than `[role="status"]`: the rail's marks are decoration under one
    // summarising `role="img"`, so the spinner's own role is silenced here.
    const marks = screen.getAllByTestId("session-mark");
    expect(marks[0]!.tagName).toBe("svg");
    expect(marks[0]!.getAttribute("class")).toContain("animate-spin");
    expect(rail.textContent).toBe("");
    expect(screen.getByRole("img", { name: "Sessions 2, 1 running" })).toBeTruthy();
    // Nothing that carries text is painted in the sliver: `visibility: hidden`
    // takes the content AND ITS SCROLLBAR out of the paint while leaving it
    // mounted (`hidden` would unlayout it, and clipping alone is what produced
    // the wrapped text and the stray scrollbar).
    for (const label of ["Open Space", "New Session", "Skills", "Agents", "Sessions", "Archived"]) {
      const node = screen.queryByText(label);
      if (node) {
        expect(painted(node), `${label} bleeds into the sliver`).toBe(false);
      }
    }
    // …and the rail is NOT hidden — the assertion that makes the loop above
    // mean something rather than passing on a blanket `invisible` root.
    expect(painted(rail)).toBe(true);
    // Content stays MOUNTED (not unmounted): the row's title node is still in
    // the tree, just not painted.
    expect(screen.getByText("Fix the login bug")).toBeTruthy();
    // Expanding restores the list and drops the rail.
    act(() => {
      setLeftPaneCollapsed(false);
    });
    expect(painted(screen.getByText("Sessions"))).toBe(true);
    expect(screen.queryByTestId("session-rail")).toBeNull();
  });

  it("keeps the rail's marks POSITIONALLY equal to the rows, because both come from the store's ONE sequence", () => {
    // The rail's whole meaning is "the Nth mark is the Nth row". That equality
    // is now STRUCTURAL — the rows and the rail read the same array
    // (`activeView.sessionIds`) — and this test is the pin that keeps it that way
    // if someone re-derives one of the two and lets them drift.
    //
    // The fixture is what makes it non-vacuous, so the numbers are stated:
    // `sessionOrder: { s2: 0, s1: 1, h1: 2 }` says the live row `s2` is the FIRST
    // row while `s1` is the row with the most recent message. The store's
    // sequence therefore answers rows two/one/three → marks
    // running/waiting/stored; the deleted display sort answers one/two/three
    // (`s1`'s message is newer, so it led the live group) → marks
    // waiting/running/stored. Seed the "obvious" ascending
    // `{ s1: 0, s2: 1, h1: 2 }` instead and BOTH rules answer identically, so the
    // test would pass while certifying nothing.
    const now = Date.now();
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha" }),
        makeSessionRow({ sessionId: "s2", cwd: "/tmp/alpha" }),
      ],
      activeSpacePath: "/tmp/alpha",
      activeSessionId: "s2",
      // `s1` is the most recently ACTIVE live session and the one WAITING; `s2`
      // is the one in a turn. The marks therefore differ BY POSITION between the
      // two orders — a rail that sorted itself differently shows `waiting` first.
      inTurn: { s2: true },
      messages: {
        s1: [makeMessage("user", { text: "Row one", at: now - 5_000 })],
        s2: [makeMessage("user", { text: "Row two", at: now - 90_000 })],
        h1: [makeMessage("user", { text: "Row three", at: now - 3_600_000 })],
      },
      sessionOrder: { s2: 0, s1: 1, h1: 2 },
    });
    usePermissions.setState({
      prompts: { s1: [{ requestId: "r1", toolTitle: "bash", options: [] }] },
    });
    const { unmount } = render(<SpacesList />);
    const one = screen.getByText("Row one");
    const two = screen.getByText("Row two");
    const three = screen.getByText("Row three");
    // The MAP's order (two, one, three) — NOT the activity order (one would lead).
    expect(
      two.compareDocumentPosition(one) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      one.compareDocumentPosition(three) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    unmount();

    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    const marks = [
      ...screen.getByTestId("session-rail-marks").querySelectorAll(
        "[data-testid='session-mark']",
      ),
    ];
    // Same COUNT as the rows, and per position the SAME GLYPH the row above it
    // wears: spinner, `?`, stored. A rail that ordered itself a second way would
    // lead with the `?`.
    expect(marks.map((m) => m.getAttribute("data-dot") ?? "running")).toEqual([
      "running",
      "waiting",
      "stored",
    ]);
  });

  it("shows the marks ONLY while collapsed (the open list is the readout)", () => {
    render(<SpacesList />);
    expect(screen.queryByTestId("session-rail")).toBeNull();
  });

  it("marks a session WAITING in the rail with the app's attention cue", () => {
    // The cue that matters most behind a collapsed pane: a session blocked on
    // the user. The `?` in the attention ink (see `SessionStatusMark`), and it
    // outranks the spinner (a blocked session is not working — see
    // `useSessionStatus`).
    usePermissions.setState({
      prompts: { s1: [{ requestId: "r1", toolTitle: "bash", options: [] }] },
    });
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    const dot = screen.getByTestId("session-rail").querySelector('[data-dot="waiting"]');
    expect(dot).toBeTruthy();
    expect(dot!.getAttribute("class")).toContain("text-warning");
    expect(screen.getByRole("img", { name: "Sessions 2, 1 waiting" })).toBeTruthy();
  });

  // -- The rail's action strip: the pane's commands survive the collapse --

  it("offers the pane's four commands as icons while collapsed (not Settings)", () => {
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    // The list's own four buttons survive the collapse as icons. `Settings` is
    // deliberately NOT among them: the gear lives in the chrome bar in both
    // states, so the rail used to carry a second copy and that tail strip is
    // gone (see `SessionRail`'s doc).
    //
    // FOUR, not three: `Agents` is the fourth, and it is on the rail because the
    // labelled button sits inside the region the collapse hides — dropping it
    // here would give the command a vanishing door, which is the exact defect the
    // `railActions` comment exists to prevent. Widening the count and this name
    // together is intentional, not a broken pin.
    for (const label of ["Open Space", "New Session", "Skills", "Agents"]) {
      expect(
        within(screen.getByTestId("session-rail-actions")).getByRole("button", {
          name: label,
        }),
        label,
      ).toBeTruthy();
    }
    expect(
      within(screen.getByTestId("session-rail-actions")).getAllByRole("button"),
    ).toHaveLength(4);
    // And nothing here reaches for Settings, in either strip or anywhere else.
    expect(container.querySelector('[data-testid="session-rail-tail-actions"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("wires each rail icon to the SAME handler the labelled button uses", () => {
    // Split from the presence test on purpose: `Skills` and `Open Space` open
    // MODALS, and a modal `aria-hidden`s the rest of the app — so a second
    // query against the rail after one opens fails for the correct reason
    // (testing-library honours it) and would read as a broken rail.
    // (`Settings` used to be asserted here too, through an `onOpenSettings`
    // prop — the gear is the chrome bar's now, and the pane has no such prop.)
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByTitle("New Session"));
    expect(mockedStartSession).toHaveBeenCalledWith("/tmp/alpha");
    // The Skills modal renders, and it renders even though the pane's content
    // region is `invisible` — the dialogs sit OUTSIDE that region on purpose
    // (`visibility: hidden` inherits into `fixed` descendants).
    fireEvent.click(screen.getByTitle("Skills"));
    expect(screen.getByPlaceholderText("Search skills…")).toBeTruthy();
  });

  it("opens the Open Space dialog from the rail icon", () => {
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByTitle("Open Space"));
    // The rail's icon and the labelled button are the SAME closure, so they raise
    // the same flag — asserted on the flag, because the dialog renders at `App`
    // root now (see the button case above for why a text query is the wrong probe
    // in this file).
    expect(getNewSpaceDialogOpen()).toBe(true);
  });

  it("the `…` menu's \"New Session in this Space\" gets the no-Space dialog fallback too", () => {
    // The deliberate behaviour change of this task. The menu item used to call the
    // (now deleted) hook DIRECTLY, which no-oped with no Space selected — unlike
    // the button path, it had NO dialog fallback, so it was a menu item that looked
    // alive and did nothing. Routing it through `startSessionInActiveSpace` gives it
    // the store's fallback; this is the only test that would notice it going back to
    // the direct call (the button path's fallback is pinned above).
    useSessions.setState({ activeSpacePath: null });
    render(<SpacesList />);
    // Radix opens on `pointerDown` (`click` does not open the menu in jsdom) and
    // selects on `Enter` — the same two steps the menu's other test here uses.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Session actions" }),
    );
    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: "New Session in this Space" }),
      { key: "Enter" },
    );
    expect(getNewSpaceDialogOpen()).toBe(true);
    // …and it did NOT try to start a Session in a Space that does not exist.
    expect(mockedStartSession).not.toHaveBeenCalled();
  });

  it("holds NO Settings door at all — the pane owns none in either state", () => {
    // The reverse of the old guarantee. This pane used to be Settings' only
    // door, which is why collapsing it needed a replacement gear in the rail;
    // the chrome bar now holds the single gear for both states, so this
    // component must render none — and must not accept an `onOpenSettings`
    // prop to be wired to. The single-door assertion lives in `App.test.tsx`.
    render(<SpacesList />);
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    act(() => {
      setLeftPaneCollapsed(true);
    });
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("renders NO action strip while open (the labelled buttons are the controls)", () => {
    render(<SpacesList />);
    expect(screen.queryByTestId("session-rail-actions")).toBeNull();
  });

  it("keeps the commands available with NO sessions (an empty rail is not an inert rail)", () => {
    // The rail used to render only when the list had rows; the commands are
    // exactly what a user with an empty/fresh space needs (and `New Session`
    // routes to the Open Space dialog when no space is selected).
    useSessions.setState({ activeSpacePath: "/tmp/nonexistent" });
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    expect(screen.queryByTestId("session-rail-marks")).toBeNull();
    expect(
      within(screen.getByTestId("session-rail-actions")).getByRole("button", {
        name: "New Session",
      }),
    ).toBeTruthy();
  });

  it("the left rail is WIDE ENOUGH for its own controls (the sliver is a guarantee, not a vibe)", () => {
    // A collapsed pane keeps a sliver of width so the rail's marks and its
    // three command icons stay visible. jsdom never clips, so NO DOM assertion
    // here can notice a rail that shrank below the icons — the commands would
    // silently vanish while every test stayed green. Hence arithmetic:
    //   24px icon button (`size-6`) + 8px clear of each edge.
    // (It used to be justified as the room for the pane's OWN collapse toggle;
    // that button is in the chrome bar now, and the rail's icons still need it.)
    expect(LEFT_PANE_RAIL).toBeGreaterThanOrEqual(24 + 8 + 8);
  });
});

describe("SpacesList (the generated session title)", () => {
  /** Seed ONE archived session with a generated title and NO transcript —
   * the title is then the row's only label source (the message derivation
   * has nothing to fall back to but the space name). */
  function seedArchivedTitled(title: string): void {
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [
        makeSessionRow({ sessionId: "a1", cwd: "/tmp/alpha", archived: true, title }),
      ],
      messages: {},
    });
  }

  it("labels a titled STORED row by its title, and an untitled row by its first message", () => {
    // `h1` gets a generated title; `s1` carries the backend's pre-naming
    // `title: null`, which must keep the OLD message-derived label.
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha", title: null }),
      ],
      historySessions: [
        makeSessionRow({ sessionId: "h1", cwd: "/tmp/alpha", title: "Rewriting the parser" }),
        makeSessionRow({ sessionId: "h2", cwd: "/tmp/beta" }),
      ],
    });
    render(<SpacesList />);
    // The titled row shows the title INSTEAD of its first message.
    expect(screen.getByText("Rewriting the parser")).toBeTruthy();
    expect(screen.queryByText("Refactor the parser")).toBeNull();
    // …and the untitled row is labelled exactly as before.
    expect(screen.getByText("Fix the login bug")).toBeTruthy();
  });

  it("labels a titled LIVE row by its title (the row reads `sessions`, not only the stored lists)", () => {
    // The live case is the one the `session-titled` push feeds: the row's
    // `SessionInfo` is the entry in `sessions`, which the push rewrites.
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha", title: "Porting the session namer" }),
      ],
    });
    render(<SpacesList />);
    expect(screen.getByText("Porting the session namer")).toBeTruthy();
    expect(screen.queryByText("Fix the login bug")).toBeNull();
  });

  it("shows the titled archived row as the bare title (the Space cue is gone — the section is Space-scoped)", () => {
    // The `· {spaceName}` suffix existed only because the section used to be a
    // cross-space flat list, where which Space a row belonged to was the one
    // thing the row could not omit. Scoped to the active Space, a row can never
    // belong to another Space, so the suffix is dead weight and the title span
    // holds the title ALONE.
    //
    // EXACT match (not the old `/^Archiving the log rotation/` prefix regex):
    // the prefix form existed only because the suffix was a SECOND nested span.
    // A prefix regex would let a re-added suffix throw on a multi-node match
    // instead of failing the assertion below.
    seedArchivedTitled("Archiving the log rotation");
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    const title = screen.getByText("Archiving the log rotation");
    expect(title.textContent).toBe("Archiving the log rotation");
    expect(title.textContent).not.toContain("·");
  });

  it("names the delete-confirmation dialog by the generated title", () => {
    // The dialog's title is the SAME derivation as the row's, so the user
    // confirms the row they just clicked.
    seedArchivedTitled("Rotating the archived logs");
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Rotating the archived logs" }),
    );
    // Scoped to the dialog: the ROW renders the same title text, and
    // `getByText` would otherwise match both and throw on ambiguity.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Delete session?")).toBeTruthy();
    expect(within(dialog).getByText("Rotating the archived logs")).toBeTruthy();
  });
});

/**
 * T06 — the sidebar's rows are DRAGGABLE (ADR 0075, spec §Drag mechanics).
 *
 * `useDragReorder` (T05) owns the gesture and the store's `reorderSessions`
 * (T05) owns the write; what THIS block pins is the WIRING between them and the
 * rows: the hook's six spread keys reaching the row element through
 * `RowButton`'s `...rest`, the pointer's half deciding above-or-below in the
 * RENDERED list, the drop edge drawn on the target row and nowhere else, and the
 * hover actions refusing to start a drag.
 *
 * TWO jsdom FACTS every drag here is built on, both inherited verbatim from
 * `useDragReorder.test.tsx` — reach for the obvious idiom instead and these
 * tests pass VACUOUSLY:
 *  1. `fireEvent.dragOver(el, { clientY })` does NOT deliver `clientY` (a plain
 *     `Event` swallows the unknown init member and it arrives `undefined`), so
 *     `dragOver` below hand-builds the event and assigns the property.
 *  2. `getBoundingClientRect()` is all zeros in jsdom, so the midpoint is `0`
 *     and EVERY pointer answers "after" — hence `layOut`, which makes the half a
 *     fact the test chooses rather than one the environment decides.
 *  3. AND THE RECT MUST BE NON-DEGENERATE ON THE AXIS THIS LIST IS NOT ON. The
 *     tab strip shipped as a silent no-op with every drag test in this repo green,
 *     because nothing here or in `SpaceTabs.test.tsx` ever delivered a `clientX`:
 *     an omitted one compares `undefined < midpoint` → `false` → "after", the same
 *     answer a zero-width rect gives. So `layOut` now gives every row a real x
 *     range AS WELL as a real y range, and `dragOver` demands both coordinates —
 *     with the X always answering the OPPOSITE edge from the Y, so a hook on the
 *     wrong axis reddens this block rather than agreeing by accident. The sidebar
 *     itself is unchanged (default `axis: "y"`); see
 *     "the SIDEBAR stays on the Y axis" below, which is the version of the axis
 *     test this file can construct — `SpacesList` renders no tab strip, so the
 *     horizontal-strip case lives in `SpaceTabs.test.tsx`.
 */
describe("SpacesList (dragging the session rows, ADR 0075)", () => {
  const ROW_TITLES = ["Row 1", "Row 2", "Row 3", "Row 4", "Row 5"];
  const ROW_IDS = ["r1", "r2", "r3", "r4", "r5"];

  /** Five STORED rows in the active Space, in the Manual order `r1…r5`. All
   *  five carry a generated `title` so the label never depends on a transcript
   *  (`messages: {}` — a leftover seed row would silently join the list and
   *  could satisfy an order assertion by accident). */
  function seedFiveRows(): void {
    useSessions.setState({
      sessions: [],
      historySessions: ROW_IDS.map((id, i) =>
        makeSessionRow({ sessionId: id, cwd: "/tmp/alpha", title: `Row ${i + 1}` }),
      ),
      archivedSessions: [],
      messages: {},
      inTurn: {},
      activeSessionId: null,
      activeSpacePath: "/tmp/alpha",
      sessionOrder: { r1: 0, r2: 1, r3: 2, r4: 3, r5: 4 },
    });
  }

  /** jsdom has no layout: override the rect so the pointer's half is chosen
   *  here. (Same helper, same reason, as `useDragReorder.test.tsx`'s `layOut`.)
   *
   *  BOTH AXES NON-DEGENERATE, and that is the fixture fix this block needed: a
   *  row spans x 0..200 AND y `top`..`top`+40, so its two midpoints (100 and
   *  `top`+20) are different numbers. The pointers below always state BOTH, and
   *  the X always answers the OPPOSITE edge from the Y — so a hook reading the
   *  wrong axis reddens this block instead of agreeing by accident. (The tab
   *  strip shipped broken with every test green because nothing here or there
   *  ever delivered a `clientX`: `undefined < 100` is `false`, i.e. "after", the
   *  same answer a zero-width rect gives.) */
  const layOut = (el: HTMLElement, top: number, height = 40) => {
    el.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + height,
        height,
        width: 200,
        left: 0,
        right: 200,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
  };

  /** `fireEvent.dragOver(el, { clientY })` does NOT deliver `clientY` (measured
   *  `undefined`) — nor `clientX` — so both are assigned. The return value is
   *  `false` iff a handler called `preventDefault`, i.e. "this row accepted the
   *  drop".
   *
   *  BOTH COORDINATES ARE MANDATORY: every call below passes an x that answers
   *  the opposite edge from the y, which is what keeps this VERTICAL list honest
   *  about the axis it is on. See `layOut`. */
  const dragOver = (el: Element, clientY: number, clientX: number) => {
    const ev = new Event("dragover", {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.assign(ev, { clientY, clientX });
    return fireEvent(el, ev);
  };

  const buildDrop = () =>
    new Event("drop", { bubbles: true, cancelable: true, composed: true });

  /** A row's `role="button"` element, by its title. */
  const rowEl = (title: string): HTMLElement =>
    screen.getByText(title).closest('[role="button"]') as HTMLElement;

  /** The five rows' RENDER order, derived from the DOM rather than from the
   *  store — the whole point is to assert what the user is shown. `before`
   *  counts how many siblings precede a row, so the sort is a real positional
   *  read rather than a comparator that happens to be consistent. */
  const renderedOrder = (): string[] => {
    const nodes = ROW_TITLES.map((t) => screen.getByText(t));
    return nodes
      .map((node, i) => ({
        id: ROW_IDS[i]!,
        before: nodes.filter(
          (other) =>
            other !== node &&
            (other.compareDocumentPosition(node) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
              0,
        ).length,
      }))
      .sort((a, b) => a.before - b.before)
      .map((x) => x.id);
  };

  /** Press-and-hold on `dragTitle`, hover `overTitle` at `clientY`, release.
   *  Returns the `drop` event so a test can read `defaultPrevented`.
   *  `clientX` is supplied by the caller (see the note on `dragOver`) and always
   *  contradicts `clientY`, so the array each test asserts can only come from the
   *  Y answer. */
  function drag(
    dragTitle: string,
    overTitle: string,
    clientY: number,
    clientX: number,
  ): Event {
    const from = rowEl(dragTitle);
    const to = rowEl(overTitle);
    layOut(from, 0);
    layOut(to, 100); // y 100..140 (midpoint 120), x 0..200 (midpoint 100)
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, clientY, clientX);
    const ev = buildDrop();
    fireEvent(to, ev);
    return ev;
  }

  beforeEach(() => {
    seedFiveRows();
    // The file's documented hygiene: `clearAllMocks` clears call records but
    // NEVER an armed implementation, so a `mockRejectedValueOnce` left
    // unconsumed by a failed assertion would be handed to the next test's drag.
    vi.mocked(reorderSessions)
      .mockReset()
      .mockResolvedValue(undefined);
  });

  it("every session row is draggable, and the ONLY rows that are are the session rows", () => {
    // THE WIRING PIN. `dragProps(id)` reaches the DOM through `RowButton`'s
    // `...rest` — the intended route, which is why `RowButton.tsx` needs no
    // change. TWO COMPETING ANSWERS: `draggable="true"` on all five rows (the
    // spread landed) vs the attribute absent (the prop was dropped at the call
    // site or by the row, and NO drag is possible in the app while every other
    // test in this block still passes, because they drive the handlers).
    render(<SpacesList />);
    for (const title of ROW_TITLES) {
      expect(rowEl(title).getAttribute("draggable")).toBe("true");
    }
    // And the drag prop is not sprayed over the pane: the Archived section
    // HEADER is a `RowButton` too, and it is not a row — it keeps following
    // recency (spec §Archived section), so nothing here may be dragged.
    expect(rowEl("Archived").hasAttribute("draggable")).toBe(false);
  });

  it("dragging row 5 onto row 2's TOP half reorders the rendered rows to 1,5,2,3,4", async () => {
    // Spec §5 test #13, in the DOM. TWO COMPETING ANSWERS: "before" means
    // DIRECTLY ABOVE the target → [r1,r5,r2,r3,r4]; an off-by-one reading
    // "before" as one slot earlier answers [r5,r1,r2,r3,r4], i.e. the row lands
    // above Row 1 while the indicator was promising Row 2. A display sort is a
    // THIRD answer, and the one this branch exists to delete.
    render(<SpacesList />);
    expect(renderedOrder()).toEqual(ROW_IDS);
    drag("Row 5", "Row 2", 110, 150); // 110 < midpoint 120 → top half (x 150 would say AFTER)
    expect(renderedOrder()).toEqual(["r1", "r5", "r2", "r3", "r4"]);
    // The write is the WHOLE visible slice, not the moved id (the Rust side
    // writes each index as the row's stored number, so a partial list is a
    // half-moved list). `waitFor` because the store LINKS its command behind the
    // previous reorder's promise, so the IPC call lands a microtask after the
    // optimistic write the DOM above already reflects.
    await waitFor(() => expect(reorderSessions).toHaveBeenCalledTimes(1));
    expect(reorderSessions).toHaveBeenCalledWith(["r1", "r5", "r2", "r3", "r4"]);
  });

  it("dragging row 5 onto row 2's BOTTOM half reorders to 1,2,5,3,4 — the other answer", async () => {
    // The same gesture with the pointer 20px lower. Without BOTH halves
    // asserted, a call site that ignores `overEdge` (or a hook that always
    // inserts after) passes the top-half test by accident.
    render(<SpacesList />);
    drag("Row 5", "Row 2", 130, 50); // 130 > midpoint 120 → bottom half (x 50 would say BEFORE)
    expect(renderedOrder()).toEqual(["r1", "r2", "r5", "r3", "r4"]);
    await waitFor(() =>
      expect(reorderSessions).toHaveBeenCalledWith(["r1", "r2", "r5", "r3", "r4"]),
    );
  });

  it("the drop edge shows on the TARGET row only, on the edge the pointer is nearest", () => {
    // The indicator is a class on the real row (spec §Indicator) — this asserts
    // it lands on the row under the pointer and on NO other row. TWO COMPETING
    // ANSWERS at the call site: `dropEdge={overId === id ? overEdge : null}` (the
    // hook's edge, gated on the hook's target) vs `dropEdge={overEdge}` — which
    // paints the edge on EVERY row and would read as the whole list lifting.
    render(<SpacesList />);
    const from = rowEl("Row 5");
    const to = rowEl("Row 2");
    layOut(from, 0);
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, 110, 150);
    expect(to.className).toContain("border-t-2");
    expect(to.className).not.toContain("border-b-2");
    for (const title of ["Row 1", "Row 3", "Row 4", "Row 5"]) {
      const el = rowEl(title);
      expect(el.className, title).not.toContain("border-t-2");
      expect(el.className, title).not.toContain("border-b-2");
    }
    // The pointer crossing to the bottom half flips the edge, and the top edge
    // goes away — an indicator that only ever paints one edge is the bug the
    // hook's `overEdge` exists to prevent.
    dragOver(to, 130, 50);
    expect(to.className).toContain("border-b-2");
    expect(to.className).not.toContain("border-t-2");
  });

  it("no edge is painted before the gesture and none after it ends", () => {
    // A lingering indicator reads as "drop here" on a list that is no longer
    // being dragged at, so the class must ride the gesture's lifetime exactly.
    // THE POSITIVE CONTROL is the middle assertion: without proving the edge
    // APPEARS mid-gesture, this whole test is a statement about a class that
    // nothing in the tree can ever paint — the "certifying the absence of the
    // mechanism" shape this branch has been bitten by twice.
    render(<SpacesList />);
    const edge = (el: HTMLElement) =>
      el.className.includes("border-t-2") || el.className.includes("border-b-2");
    for (const title of ROW_TITLES) expect(edge(rowEl(title))).toBe(false);
    const from = rowEl("Row 5");
    const to = rowEl("Row 2");
    layOut(from, 0);
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, 130, 50);
    expect(edge(to)).toBe(true);
    // Release (which clears the gesture) — no edge survives it.
    fireEvent(to, buildDrop());
    for (const title of ROW_TITLES) expect(edge(rowEl(title))).toBe(false);
  });

  it("the SIDEBAR stays on the Y axis: a pointer whose X says the opposite edge still moves the row up", () => {
    // THE OTHER HALF OF THE AXIS BUG'S TEST-BLINDNESS, and the reason this block
    // had to change its fixtures. `SpacesList` renders no tab strip, so a
    // horizontal-strip drag cannot be constructed HERE (that one lives in
    // `SpaceTabs.test.tsx`); what this file can and must pin is the direction the
    // fix could have gone wrong: a hook that GUESSED the axis from the rect's
    // proportions would flip this list onto X, because a sidebar row is 200px wide
    // and 40px tall.
    // TWO COMPETING ANSWERS: [r1,r5,r2,r3,r4] — the pointer's Y (110, above the
    // row's midpoint 120) answers "before" and the sidebar behaves exactly as it
    // did before the `axis` option existed — vs [r1,r2,r5,r3,r4], which is what a
    // hook reading this pointer's X (150, right of the midpoint 100) would do, and
    // also what the old Y rule would answer if a future edit swapped the axes.
    // The row's edges are asserted as TOP/BOTTOM too: the sidebar's indicator must
    // not become the tab strip's left/right pair.
    render(<SpacesList />);
    const from = rowEl("Row 5");
    const to = rowEl("Row 2");
    layOut(from, 0);
    layOut(to, 100); // y 100..140 (midpoint 120), x 0..200 (midpoint 100)
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, 110, 150);
    expect(to.className).toContain("border-t-2");
    expect(to.className).not.toContain("border-l-2");
    expect(to.className).not.toContain("border-r-2");
    fireEvent(to, buildDrop());
    expect(renderedOrder()).toEqual(["r1", "r5", "r2", "r3", "r4"]);
  });

  it("dragging a row onto itself is a no-op: no reorder, no IPC, no indicator, no move", () => {
    // TWO COMPETING ANSWERS: a call site that lets a row target itself fires an
    // IPC with an unchanged slice (a pointless write that still bumps every
    // row's stored number) and paints an edge on the row the user is holding.
    // The hook refuses the target — and this pins that the refusal reaches the
    // RENDERED list, not just the hook's own state.
    render(<SpacesList />);
    const self = rowEl("Row 3");
    // THE POSITIVE CONTROL, and the reason it sits here rather than only in the
    // test above: with no drag mounted at all, every assertion below passes on
    // an inert row — `dragOver` returns `true` because NOTHING handled it. This
    // one line is what makes the rest of the test falsifiable.
    expect(self.getAttribute("draggable")).toBe("true");
    layOut(self, 100);
    fireEvent.dragStart(self, { dataTransfer: { setData: vi.fn() } });
    // `true` === nothing prevented === the browser's no-drop cursor, and the
    // window backstop is what swallows the release (spec hazard 2).
    expect(dragOver(self, 130, 50)).toBe(true);
    expect(self.className).not.toContain("border-b-2");
    fireEvent(self, buildDrop());
    expect(reorderSessions).not.toHaveBeenCalled();
    expect(renderedOrder()).toEqual(ROW_IDS);
  });

  it("a row's drop wins without stopping propagation, and a release outside any row is left to the backstop", async () => {
    // Spec hazard 2 at the CALL SITE. `useWindowDropBackstop` listens on
    // `window` and the row's handler fires first during bubbling, so the row
    // wins the drop on its own — but only if it does not take propagation away
    // on the way out, because the backstop is the one thing standing between a
    // stray drop and the webview NAVIGATING to it. (The backstop's own swallow
    // is pinned in `useDragReorder.test.tsx`, which mounts it alongside its
    // probe; `SpacesList.test.tsx` renders the pane alone, so what is provable
    // HERE is the row's half.)
    //
    // TWO COMPETING ANSWERS to "did the row claim the event?": a row that calls
    // `stopPropagation` reorders correctly AND leaves the backstop deaf (the
    // reorder tests stay green, the app navigates away on a stray drop); the
    // correct row prevents and propagates.
    render(<SpacesList />);
    const from = rowEl("Row 5");
    const to = rowEl("Row 2");
    layOut(from, 0);
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    // THE POSITIVE CONTROL: the row has to have CLAIMED the gesture for the
    // release below to mean anything. Without this line the assertions pass on a
    // list with no drag wiring at all — the vacuity this branch has been bitten
    // by four times. (`preventDefault` on `dragover` is what makes `dragOver`
    // return `false`.)
    expect(dragOver(to, 110, 150)).toBe(false);

    // Half one — released ON the row: prevented, reordered, and NOT stopped.
    const onRow = buildDrop();
    const stopped = vi.spyOn(onRow, "stopPropagation");
    fireEvent(to, onRow);
    expect(onRow.defaultPrevented).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(0);
    await waitFor(() => expect(reorderSessions).toHaveBeenCalledTimes(1));

    // Half two — released OUTSIDE every row: the row never claims it, so the
    // event arrives at `window` un-prevented and un-stopped for the backstop to
    // swallow, and no list moves.
    vi.mocked(reorderSessions).mockClear();
    const stray = buildDrop();
    const strayStopped = vi.spyOn(stray, "stopPropagation");
    fireEvent(document.body, stray);
    expect(stray.defaultPrevented).toBe(false);
    expect(strayStopped).toHaveBeenCalledTimes(0);
    expect(reorderSessions).not.toHaveBeenCalled();
  });

  it("a drop on a row writes the store's order map, so the row HOLDS its slot through a re-derivation", () => {
    // The hazard T03 handed T05 and T06: `sessionOrder` is a BOOT SNAPSHOT, so a
    // drag that wrote only the derived array would snap back the moment the view
    // re-derived. Forcing a re-derivation is the only way to tell the two writes
    // apart — TWO COMPETING ANSWERS: writing the map (the row holds) vs writing
    // the array alone (the row returns to `r1…r5`).
    render(<SpacesList />);
    drag("Row 5", "Row 2", 110, 150);
    expect(renderedOrder()).toEqual(["r1", "r5", "r2", "r3", "r4"]);
    // Force a re-derivation: a NEW stored row in ANOTHER Space changes a `views`
    // dependency (so `spaceViewFor` re-runs for every Space and `sessionIds` is
    // rebuilt from the order map) while rendering no row here — the only way to
    // tell a map write from an array-only write apart.
    act(() => {
      useSessions.setState({
        historySessions: [
          ...useSessions.getState().historySessions,
          makeSessionRow({ sessionId: "beta-1", cwd: "/tmp/beta", title: "Other space" }),
        ],
      });
    });
    expect(screen.queryByText("Other space")).toBeNull();
    expect(renderedOrder()).toEqual(["r1", "r5", "r2", "r3", "r4"]);
    expect(useSessions.getState().sessionOrder.r5).toBe(1);
  });

  it("the hover actions carry draggable={false}, so a press on a destructive control starts no drag", () => {
    // Spec §Handle. The row is `draggable=true` and these buttons are its
    // CHILDREN, so an inherited/absent value makes a press on Delete begin a
    // drag of the row instead of acting. TWO COMPETING ANSWERS: `"false"` (the
    // opt-out landed) vs `null` (absent → the browser lets the parent drag).
    useSessions.setState({
      sessions: [makeSessionRow({ sessionId: "r1", cwd: "/tmp/alpha", title: "Row 1" })],
      historySessions: [
        makeSessionRow({ sessionId: "r2", cwd: "/tmp/alpha", title: "Row 2" }),
      ],
      sessionOrder: { r1: 0, r2: 1 },
    });
    render(<SpacesList />);
    const live = rowEl("Row 1");
    const stored = rowEl("Row 2");
    expect(live.getAttribute("draggable")).toBe("true");
    // Stop + Archive on the live row, Archive on the stored one.
    const actions = [
      within(live).getByRole("button", { name: "Stop Row 1" }),
      within(live).getByRole("button", { name: "Archive Row 1" }),
      within(stored).getByRole("button", { name: "Archive Row 2" }),
    ];
    for (const action of actions) {
      expect(action.getAttribute("draggable"), action.getAttribute("aria-label") ?? "").toBe(
        "false",
      );
    }
  });

  it("the Archived rows' Unarchive and Delete carry draggable={false} too", () => {
    // The spec names all FOUR hover actions. The archived rows are not
    // draggable themselves (that section keeps following recency), so a
    // `draggable={false}` here is not inherited from a draggable parent — it is
    // the same explicit opt-out, and the Delete confirm dialog is the one thing
    // in the sidebar that must never be reachable only by accident.
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [
        makeSessionRow({
          sessionId: "a1",
          cwd: "/tmp/alpha",
          archived: true,
          title: "Archived row",
        }),
      ],
      messages: {},
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    const row = rowEl("Archived row");
    // The row is NOT draggable (recency, not Manual order)…
    expect(row.hasAttribute("draggable")).toBe(false);
    // …and its two controls say so explicitly.
    for (const name of ["Unarchive Archived row", "Delete Archived row"]) {
      expect(within(row).getByRole("button", { name }).getAttribute("draggable")).toBe(
        "false",
      );
    }
  });

  it("the collapsed rail's marks stay POSITIONALLY equal to the rows after a drag", () => {
    // The rail's contract is "the Nth mark is the Nth row", and it now has to
    // survive a user-initiated reorder. The fixture gives the three rows three
    // DIFFERENT glyphs, so a mark sequence is a readable order. TWO COMPETING
    // ANSWERS after dragging `Row three` above `Row two`: the rail reads the
    // same array the rows do → [stored, running, waiting]; a rail that kept the
    // old live-then-stored construction (or a pre-drag snapshot) answers
    // [running, waiting, stored].
    useSessions.setState({
      sessions: [
        makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha", title: "Row one" }),
        makeSessionRow({ sessionId: "s2", cwd: "/tmp/alpha", title: "Row two" }),
      ],
      historySessions: [
        makeSessionRow({ sessionId: "h1", cwd: "/tmp/alpha", title: "Row three" }),
      ],
      messages: {},
      inTurn: { s2: true },
      activeSessionId: "s2",
      activeSpacePath: "/tmp/alpha",
      sessionOrder: { s2: 0, s1: 1, h1: 2 },
    });
    usePermissions.setState({
      prompts: { s1: [{ requestId: "r1", toolTitle: "bash", options: [] }] },
    });
    render(<SpacesList />);
    // Rows two, one, three → drag the STORED row (three) above the running one.
    const from = rowEl("Row three");
    const to = rowEl("Row two");
    layOut(from, 0);
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, 110, 150);
    fireEvent(to, buildDrop());
    const rows = screen.getByText("Row three");
    expect(
      rows.compareDocumentPosition(screen.getByText("Row two")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    act(() => {
      setLeftPaneCollapsed(true);
    });
    // The rows stay MOUNTED while collapsed (clipped, not unmounted), so both
    // orders are readable from this one render — no re-render to re-derive them.
    const marks = [
      ...screen.getByTestId("session-rail-marks").querySelectorAll(
        "[data-testid='session-mark']",
      ),
    ];
    expect(marks.map((m) => m.getAttribute("data-dot") ?? "running")).toEqual([
      "stored",
      "running",
      "waiting",
    ]);
  });

  it("a dragged row's relative time keeps updating while its new slot holds", () => {

    // The user-visible promise of ADR 0075, tested AFTER a drag rather than on a
    // pristine list: the row's LABEL is its own per-row subscription and the
    // row's SLOT is the Manual order, and the two must stay independent in both
    // directions. TWO COMPETING ANSWERS: the label updates and the slot holds
    // (correct) vs the newly-active row floating back to the top (the deleted
    // display sort) or the label freezing (a slot-owned label).
    const now = Date.now();
    useSessions.setState({
      sessions: [],
      historySessions: [
        makeSessionRow({ sessionId: "r1", cwd: "/tmp/alpha", title: "Row 1" }),
        makeSessionRow({ sessionId: "r2", cwd: "/tmp/alpha", title: "Row 2" }),
      ],
      archivedSessions: [],
      messages: {
        r1: [makeMessage("user", { text: "first", at: now - 10_000 })],
        r2: [makeMessage("user", { text: "second", at: now - 3_600_000 })],
      },
      inTurn: {},
      activeSessionId: null,
      activeSpacePath: "/tmp/alpha",
      sessionOrder: { r1: 0, r2: 1 },
    });
    render(<SpacesList />);
    expect(within(rowEl("Row 2")).getByText("1h")).toBeTruthy();
    // Drag `Row 2` ABOVE `Row 1` — it now holds slot 0.
    const from = rowEl("Row 2");
    const to = rowEl("Row 1");
    layOut(from, 100);
    layOut(to, 0);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, 10, 150); // top half → before (x 150 would say AFTER)
    fireEvent(to, buildDrop());
    expect(
      screen.getByText("Row 2").compareDocumentPosition(screen.getByText("Row 1")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // A future stamp → `now - at` is negative → the `< 60_000` bucket → "now":
    // a deterministic label change with no fake timers.
    act(() => {
      useSessions.setState({
        messages: {
          ...useSessions.getState().messages,
          r2: [makeMessage("user", { text: "second", at: Date.now() + 9_000_000_000 })],
        },
      });
    });
    expect(within(rowEl("Row 2")).getByText("now")).toBeTruthy();
    expect(
      screen.getByText("Row 2").compareDocumentPosition(screen.getByText("Row 1")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a sidebar row and a standalone SessionListRow wear the SAME drag surface", () => {
    // The row component is shared (the sidebar's rows and the Archived section
    // are one component, drawn twice), so the drag surface must be identical
    // wherever it is worn — a row that gains an extra attribute at ONE call site
    // is the drift the shared-component extraction exists to prevent, and
    // `RowButton`'s header pins attribute ORDER for the same reason.
    //
    // TWO COMPETING ANSWERS for "what does the drag contribute to the element?":
    // exactly the one attribute `draggable` (the hook's other five keys are
    // handlers, which emit nothing) vs a spread that also lands `data-*` /
    // `aria-*` / a second `class`. The set difference below is what catches the
    // second answer at either site.
    const { unmount } = render(<SpacesList />);
    const sidebarRow = rowEl("Row 2");
    const sidebarAttrs = [...sidebarRow.attributes]
      .map((a) => a.name)
      .sort()
      .join(",");
    // Unmount the PANE before rendering the standalone rows: RTL cleans up
    // between TESTS, not between two `render()` calls in one test, so a second
    // mount would leave a second sidebar in the tree and `rowEl` would throw on
    // a multiple match — the failure at least announces itself.
    unmount();

    // The same row, standalone, wearing a hook-shaped spread and one edge.
    const handlers = {
      draggable: true as const,
      onDragStart: () => {},
      onDragEnd: () => {},
      onDragOver: () => {},
      onDragLeave: () => {},
      onDrop: () => {},
    };
    render(
      <div>
        <SessionListRow title="plain" onOpen={() => {}} drag={handlers} />
        <SessionListRow
          title="target"
          onOpen={() => {}}
          drag={handlers}
          dropEdge="before"
        />
      </div>,
    );
    const plainRow = rowEl("plain");
    const targetRow = rowEl("target");
    // Same attribute NAMES as the sidebar's row (same base props: a stored row
    // carries no leading mark either, so the two shells are the same shape).
    expect([...plainRow.attributes].map((a) => a.name).sort().join(",")).toBe(
      sidebarAttrs,
    );
    // And the indicator contributes ONE class token pair to the row's own class,
    // in the same position relative to the base string, at both sites.
    const base = plainRow.className.split(/\s+/);
    const withEdge = targetRow.className.split(/\s+/);
    expect(withEdge.slice(0, base.length)).toEqual(base);
    expect(withEdge.slice(base.length)).toEqual(["border-t-2", "border-brand"]);
  });
});
