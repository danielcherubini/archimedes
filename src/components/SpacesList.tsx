import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArchiveIcon,
  ArchiveXIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  MessageCirclePlusIcon,
  MoreHorizontalIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type AppSettings,
  type AgentOverrides,
  type ModelDto,
  type SessionInfo,
  getSettings,
  listModels,
  listTools,
  saveSettings,
} from "../lib/tauri";
import { basenameOfPath } from "../lib/paths";
import {
  activityFromKey,
  activityKeyOf,
  sortByActivity,
} from "../lib/sessionActivity";
import { titleFor } from "../lib/sessionTitle";
import {
  getLeftPaneCollapsed,
  LEFT_PANE_RAIL,
  LEFT_PANE_WIDTH,
  subscribeLeftPane,
} from "../lib/leftPaneState";
import { openNewSpaceDialog } from "../lib/newSpaceDialogState";
import {
  useSessions,
  spaceViewFor,
  type Message,
} from "../store/sessions";
import { useSessionStatus } from "../hooks/useSessionStatus";
import { useSessionStatuses } from "../hooks/useSessionStatus";
import { useSkillCatalog } from "../hooks/useSkillCatalog";
import {
  clearAgentCatalogCache,
  useAgentCatalog,
} from "../hooks/useAgentCatalog";
import { useSettings } from "../store/settings";
import SkillsDialog from "./SkillsDialog";
import AgentsDialog from "./AgentsDialog";
import DeleteSessionDialog from "./DeleteSessionDialog";
import SessionRail, { type SessionRailAction } from "./SessionRail";
import { SessionStatusMark } from "./SessionStatusMark";
import { Kbd } from "./ui/kbd";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/**
 * The relative time of a session's last activity, derived ONLY from the
 * latest message's `at` when the transcript is loaded this boot
 * (`useSessions.messages[sessionId]`): `<60s` → `now`, `<60m` → `Nm`,
 * else `Nh`. `SessionInfo` has NO `createdAt` field (the store's ordering
 * note says so explicitly), so a stored session not opened this boot has
 * no loaded messages → `null` (the row renders an empty slot).
 */
function relativeTimeFor(
  messages: Message[] | undefined,
  now: number = Date.now(),
): string | null {
  const latest = messages?.[messages.length - 1];
  if (!latest) return null;
  const diff = now - latest.at;
  if (diff < 60_000) return "now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m`;
  return `${Math.floor(diff / (60 * 60_000))}h`;
}

function spaceNameFor(cwd: string, spaces: { path: string }[]): string {
  const match = spaces.find((s) => s.path === cwd);
  return match ? basenameOfPath(match.path) : basenameOfPath(cwd);
}

/**
 * ONE link of the `agentOverrides` write chain (see `patchAgentOverrides` in the
 * component): read the document, replace the map, write it back.
 *
 * It SWALLOWS its own failure — log, then RE-FETCH into the store — and that is
 * load-bearing for the chain: a rejection would leave the held promise rejected,
 * and every write chained after it would resolve to that same stale rejection
 * without ever reaching the file. The chain stays alive because this does not
 * throw.
 *
 * The re-fetch on failure is also what rolls back the optimistic publish: the
 * store ends up holding the FILE's map, not the one that never landed.
 */
async function writeAgentOverrides(next: AgentOverrides): Promise<void> {
  try {
    const fresh = await getSettings();
    const freshDocument: AppSettings = { ...fresh, agentOverrides: next };
    await saveSettings(freshDocument);
    useSettings.getState().setSettings(freshDocument);
    // (F6 of the review round) The catalog this modal's `runs` columns came from
    // was resolved against the map that was just REPLACED, so drop it: the next
    // fetch goes back to Rust instead of serving the settled promise the edit
    // invalidated. Clearing the WHOLE cache (not just this Space's key) is the
    // honest scope — the override map is global, so an edit changes the answer for
    // every Space's rows, not just the one on screen.
    clearAgentCatalogCache();
  } catch (err) {
    console.error("Failed to save agent overrides:", err);
    void useSettings.getState().loadSettings();
  }
}

export default function SpacesList() {
  // No `onOpenSettings` prop any more: the Settings gear moved to the chrome
  // bar's control cluster (`ChromeControls`), so this pane holds no route to
  // the settings page. The pane used to own that door — and the collapse toggle
  // beside it — which is why the prop existed.
  const spaces = useSessions((s) => s.spaces);
  const sessions = useSessions((s) => s.sessions);
  const historySessions = useSessions((s) => s.historySessions);
  const archivedSessions = useSessions((s) => s.archivedSessions);
  const closeReasons = useSessions((s) => s.closeReasons);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const activeSpacePath = useSessions((s) => s.activeSpacePath);
  const openSession = useSessions((s) => s.openSession);
  const deleteSession = useSessions((s) => s.deleteSession);
  // THE new-session command (Task 2's store action). This pane no longer decides
  // what "no Space selected" means — the command does, and it routes that case to
  // the Open Space dialog itself. That is why every new-session surface below
  // (the labelled button, the rail icon, the `…` menu item, and the root ⌘N
  // chord) is now the same one call and cannot drift apart.
  const startSessionInActiveSpace = useSessions(
    (s) => s.startSessionInActiveSpace,
  );
  // The Skills modal (the left pane has NO skill list — ZCode parity: the
  // skills UI is a searchable modal, opened from the third button in the
  // row). The catalog fetch lives in `useSkillCatalog` below (the modal
  // receives the rows as props — same hook key as the composer → one
  // shared fetch).
  const [skillsOpen, setSkillsOpen] = useState(false);
  // The Agents modal (ADR 0066 / ADR 0068) — the ONE Agent surface, mounted
  // beside Skills with the SAME shape: the fetch lives in `useAgentCatalog`, the
  // dialog takes rows as props. The settings document is read here too, because
  // the dialog edits `agentOverrides` and the mount is the only place that owns a
  // write path.
  const [agentsOpen, setAgentsOpen] = useState(false);

  // Keep the `spaces` list order (`lastOpenedAt` desc from `list_spaces`):
  // groups follow the server's recent-first order.
  const views = useMemo(
    () =>
      spaces.map((s) =>
        spaceViewFor(s, sessions, historySessions, closeReasons, archivedSessions),
      ),
    [spaces, sessions, historySessions, closeReasons, archivedSessions],
  );
  // The ACTIVE SPACE's view — the ROW LIST's source (`viewIds`, `liveIds` /
  // `storedIds`, the rows themselves and every row's Space name), NOT a
  // new-session input any more. `⌘N` used to branch on it (`undefined` → the
  // Open Space dialog); the store's `startSessionInActiveSpace` owns that
  // routing now, so this is pure derivation for the list.
  // `undefined` while no Space is selected (no Spaces yet, or the last one was
  // removed) — which is also why the list renders nothing.
  const activeView = views.find((v) => v.path === activeSpacePath);
  // Why the last new-session attempt failed (`null` when it did not fail) — the
  // actions-menu trigger's `title`, so a dead menu item says why. It replaced the
  // deleted `useStartNewConversation` hook's local `error` state: the command
  // lives in the store now, so its failure has to be readable from the store too.
  const newSessionError = useSessions((s) => s.newSessionError);
  // The active space's sessions in the list's own order (live then stored) —
  // the ids whose activity and status are read below, so the subscription and
  // the rail are derived from the SAME membership the rows render.
  const viewIds = useMemo(
    () =>
      activeView
        ? [...activeView.liveSessionIds, ...activeView.storedSessionIds]
        : [],
    [activeView],
  );
  // LAST ACTIVITY per session, subscribed as ONE primitive key (see
  // `activityKeyOf`): the session's own relative time is already
  // `messages[id]`'s last stamp, and the ORDER now reads the same field — so
  // a row's time and its position in the list can never disagree. The key (and
  // not the `messages` map) is what keeps a streaming turn from re-sorting the
  // list on every token: growing a message replaces the array without moving
  // its stamp.
  const activityKey = useSessions((s) => activityKeyOf(viewIds, s.messages));
  const activity = useMemo(() => activityFromKey(activityKey), [activityKey]);
  // Most recently active first, WITHIN each group. The two groups need
  // OPPOSITE rules for "no evidence" (a session with no transcript loaded this
  // boot), and getting that wrong is exactly the annoyance being fixed:
  //
  // - LIVE, `unknowns: "first"` (the default): no transcript means the session
  //   was JUST started (`addSession` gives it an empty array) — the newest
  //   activity there.
  // - STORED, `unknowns: "last"`: no transcript means it has not been opened
  //   since boot, i.e. nothing says it is recent, so it must not outrank a
  //   session we can PROVE was used. `Db::list_sessions` already returns this
  //   group most-recently-active-first, so the unknowns keep that order among
  //   themselves; the sort's only real work here is a session that CLOSED this
  //   boot — `handleSessionClosed` appends it to the tail of the array, which
  //   would otherwise file the most recently used session at the BOTTOM.
  const liveIds = useMemo(
    () => sortByActivity(activeView?.liveSessionIds ?? [], activity),
    [activeView, activity],
  );
  const storedIds = useMemo(
    () => sortByActivity(activeView?.storedSessionIds ?? [], activity, "last"),
    [activeView, activity],
  );
  // The rail's statuses, derived by the SAME rule the rows use (one
  // subscription for the whole list — see `useSessionStatuses`). Read
  // unconditionally: the rail only paints while collapsed, but the ids are the
  // active view's either way and a hook cannot be conditional. ORDER IS THE
  // RAIL'S CONTRACT (the Nth mark is the Nth row), so it takes the ORDERED
  // lists, never the membership list above.
  const railIds = useMemo(
    () => [...liveIds, ...storedIds],
    [liveIds, storedIds],
  );
  const statuses = useSessionStatuses(railIds);

  // The active space's path for the skill catalog (a Session's `cwd` IS
  // the Space's folder — CONTEXT.md): the SELECTED space (the tab), or
  // `null` when none is selected (the catalog degrades to user-level
  // skills — the hook's `null` handling).
  const skills = useSkillCatalog(activeSpacePath);
  // The Agent definitions the ACTIVE Space can see (`cwd: null` → the user-level
  // set). The override map the modal edits is GLOBAL and identical from every
  // Space — the Space decides only which definitions get LISTED.
  const agentRows = useAgentCatalog(activeSpacePath);
  // The settings document, from the app-wide store (`useSettings` is already read
  // by non-Settings components — `MessageBubble`, `SessionConfigSelect`,
  // `ChatStream` — so this is not new plumbing, though this pane did not read it
  // until the Agents modal mounted here).
  const settings = useSettings((s) => s.settings);
  // The Agents modal's two catalogs, fetched ONCE on mount into local state —
  // the `SettingsPage.tsx` pattern, deliberately with no cache of its own (a
  // second module-level cache for two lists the modal reads on open would be
  // staleness for free).
  const [models, setModels] = useState<ModelDto[]>([]);
  const [toolNames, setToolNames] = useState<string[]>([]);
  useEffect(() => {
    listModels()
      .then(setModels)
      .catch(() => {});
    listTools()
      .then(setToolNames)
      .catch(() => {});
  }, []);

  /**
   * The ONE write path for `agentOverrides` (ADR 0066's store) — a
   * READ-MODIFY-WRITE, never composed from the store.
   *
   * The re-read is load-bearing, not paranoia: the store's copy is seeded at
   * boot and by the Settings page, but the Rust side writes `settings.json` on
   * its own — `agent/session/mod.rs:1678` persists a remembered thinking level
   * through `load_settings` + mutate + `write_settings` — so a modal opened at an
   * arbitrary moment can be holding a stale document, and composing from the store
   * would silently clobber a concurrent change. EVERY Rust writer does
   * load-mutate-write; this has to match or the desktop becomes the one writer
   * that can lose someone else's field.
   *
   * On failure, log and RE-FETCH into the store: a save that did not land means
   * the file and the UI disagree, and the file is right (and the optimistic
   * publish below is rolled back — the store ends up holding the FILE's map, not
   * the one that was never written).
   *
   * Note what is replaced and what is preserved: the OTHER fields come from the
   * re-read document, and `agentOverrides` is the map the dialog handed over
   * wholesale (it edited that map, so it is the newer answer). That is safe for
   * exactly one reason — this modal is the ONLY writer of the map in the app, so
   * no concurrent Rust write can be sitting inside it. If a second writer ever
   * appears for this field, this line becomes a merge, not a replace.
   *
   * …and the modal is now a SECOND writer of its own field, which is why the two
   * halves below exist. A rapid pair of edits (pick a model, then pick a thinking
   * level — one ~300ms gesture) issues two `onPatch` calls, and the second one is
   * built from the map the dialog was RENDERED with: the store only caught up
   * after `getSettings` → `saveSettings` resolved, so the second map has never
   * seen the first edit's field, and handing over a whole map means the second
   * write deletes the first pick from `settings.json` with no feedback. Neither
   * half of the fix alone closes that:
   *
   * - PUBLISH the incoming map into the store immediately (the store's own
   *   `setSettings` is documented as the settings UI's optimistic write, and the
   *   success path writes this same map anyway). The dialog re-renders off it, so
   *   the next edit is composed on the pending map instead of on a snapshot that
   *   predates it — the maps stay cumulative.
   * - SERIALIZE the saves on a promise held in a ref, so "the last write wins"
   *   means the LAST map the user produced and not whichever `saveSettings`
   *   happened to resolve first.
   *
   * The chain never carries a rejection: `writeAgentOverrides` swallows its own
   * error (log + re-seed), so a failed link cannot strand every write after it.
   *
   * What is deliberately NOT done here is a field-level merge of the incoming map
   * with the re-read one. The map carries no intent: an absent field is BOTH "the
   * user just cleared it" and "nobody ever set it", so merging would resurrect a
   * field the user just unticked (ADR 0067 — absence is the only meaning of
   * "does not speak").
   */
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const patchAgentOverrides = useCallback((next: AgentOverrides) => {
    const current = useSettings.getState().settings;
    // Publish first (before the awaits), so the dialog's next render — and thus
    // its next edit — sees this one.
    if (current !== null) {
      useSettings.getState().setSettings({ ...current, agentOverrides: next });
    }
    writeChainRef.current = writeChainRef.current.then(() =>
      writeAgentOverrides(next),
    );
    return writeChainRef.current;
  }, []);

  // The session awaiting delete confirmation (the ONLY destructive
  // action in the sidebar — archive/unarchive are reversible and have
  // no confirm). `null` = no dialog. (The selector is unconditional and
  // returns stable references — `undefined` or the transcript array —
  // so Zustand does not re-render in a loop.)
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);
  const deleteTargetMessages = useSessions(
    (s) => (deleteTarget ? s.messages[deleteTarget.sessionId] : undefined),
  );
  const deleteTargetTitle = deleteTarget
    ? titleFor(
        deleteTargetMessages,
        spaceNameFor(deleteTarget.cwd, spaces),
        // The target IS a `SessionInfo`, so its title is already in hand —
        // the SAME label the row the user clicked shows.
        deleteTarget.title,
      )
    : "";

  // The shared collapsed flag (the module seeds it from localStorage at
  // import). This component only READS it, for the frame's width — the
  // `LEFT_PANE_RAIL` sliver while collapsed, NOT 0. The WRITE lives in the
  // chrome bar's `ChromeControls`: the pane's collapse toggle moved to the top
  // of the window next to the window controls, so this pane no longer owns a
  // control that changes its own width.
  const collapsed = useSyncExternalStore(
    subscribeLeftPane,
    getLeftPaneCollapsed,
  );

  // Both handlers are STABLE: `openNewSpaceDialog` is a zero-arg module function
  // (so it is assignable to `SessionRailAction.onClick` and to a button's
  // `MouseEventHandler`, which `setNewSpaceDialogOpen` — arity 1 — is not), and
  // `startSessionInActiveSpace` is a store action, stable across renders. That
  // replaces the old pair, where `useStartNewConversation` returned a FRESH
  // object every render and so re-subscribed the pane's keydown listener on every
  // render; the listener is gone (it lives at `App` root now) and so is the churn.
  const handleOpenSpace = openNewSpaceDialog;
  const handleNewSession = useCallback(
    () => void startSessionInActiveSpace(),
    [startSessionInActiveSpace],
  );

  // The collapsed rail's command strip. These are the SAME handlers the open
  // pane's labelled buttons call — one closure each, referenced from both, so
  // the two renderings of a command cannot drift apart. The icons are the open
  // buttons' icons verbatim (the rail is the same control at the same size, not
  // a new control), and the labels are carried as `aria-label` + `title`
  // because a 40px column has no room for text.
  //
  // Four commands, all at the HEAD, because they are the pane's own buttons.
  // `Settings` used to ride here as a second strip at the rail's BOTTOM — the
  // gear lived in the footer while open, so the rail kept it at the same height
  // on collapse. The gear now lives in the chrome bar for both states, so the
  // tail strip is gone and with it the rail's `mt-auto` tail block.
  const railActions: SessionRailAction[] = [
    {
      id: "open",
      label: "Open Space",
      icon: <FolderOpenIcon className="size-4" />,
      onClick: handleOpenSpace,
    },
    {
      id: "new",
      label: "New Session",
      icon: <MessageCirclePlusIcon className="size-4" />,
      onClick: handleNewSession,
    },
    {
      id: "skills",
      label: "Skills",
      icon: <SparklesIcon className="size-4" />,
      onClick: () => setSkillsOpen(true),
    },
    {
      id: "agents",
      label: "Agents",
      icon: <BotIcon className="size-4" />,
      onClick: () => setAgentsOpen(true),
    },
  ];

  // The ⌘N / ⌘O chord lives in `useAppShortcuts`, mounted at `App` root — NOT
  // here. It sat in this component while, and this pane is inside the
  // `view === "settings"` ternary's else-branch, so the Settings page unmounted
  // the listener and both chords stopped existing there. `App.test.tsx` pins the
  // chord from that view, and `useAppShortcuts.test.ts` owns the guard cases.

  return (
    // Collapse = `LEFT_PANE_RAIL` + `overflow: hidden` (a SLIVER, not 0 — the
    // content stays mounted, clipped; the `fixed` dialogs escape clipping).
    // The sliver exists so the collapsed rail has somewhere to draw: the
    // session marks and the four command icons (`SessionRail`). The pane's
    // collapse toggle is NOT here any more — it lives in the chrome bar's
    // `ChromeControls` beside the window controls, in both states — which is
    // also why the footer row this pane used to end with is gone.
    <aside
      style={{ width: collapsed ? LEFT_PANE_RAIL : LEFT_PANE_WIDTH }}
      className="relative flex shrink-0 flex-col overflow-hidden bg-frame"
    >
      {/* THE CONTENT REGION — the action buttons, the `Sessions` header and the
          list. `invisible` WHILE COLLAPSED is load-bearing, and it fixes two
          defects at once. The collapse is width + `overflow: hidden` with the
          content kept MOUNTED (the `fixed` dialogs escape clipping, and the
          list's local state — the Archived section's open flag, the scroll
          position — survives), so clipping alone let the content paint INTO the
          40px sliver: the buttons wrapped to one word per line
          ("O / Sp / Se / Sk"), the `Sessions` header became "Sess", and the
          scroller grew a SCROLLBAR in a 40px column. `visibility: hidden` takes
          the text AND ITS SCROLLBAR out of the paint while leaving the layout
          untouched — `hidden` would unlayout it. It is applied to the WRAPPER,
          not the scroller, because the buttons and the header are siblings of
          the scroller and bled just the same. The session marks below are what
          shows instead. */}
      <div
        className={`flex min-h-0 flex-1 flex-col ${collapsed ? "invisible" : ""}`}
      >
      <div className="flex flex-col gap-2 p-3">
        <button
          type="button"
          onClick={handleOpenSpace}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-ui-base hover:bg-surface-hover"
        >
          <FolderOpenIcon className="size-4" />
          <span className="flex-1 text-left">Open Space</span>
          <Kbd className="text-foreground-subtlest">⌘O</Kbd>
        </button>
        <button
          type="button"
          onClick={handleNewSession}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-ui-base hover:bg-surface-hover"
        >
          <MessageCirclePlusIcon className="size-4" />
          <span className="flex-1 text-left">New Session</span>
          <Kbd className="text-foreground-subtlest">⌘N</Kbd>
        </button>
        <button
          type="button"
          onClick={() => setSkillsOpen(true)}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-ui-base hover:bg-surface-hover"
        >
          <SparklesIcon className="size-4" />
          <span className="flex-1 text-left">Skills</span>
        </button>
        {/* The Agents modal (the ONE Agent surface — Settings has no Agents
            section). No `Kbd`, matching `Skills`: neither is a chord. `BotIcon`
            moved here from the deleted Settings nav entry. */}
        <button
          type="button"
          onClick={() => setAgentsOpen(true)}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-ui-base hover:bg-surface-hover"
        >
          <BotIcon className="size-4" />
          <span className="flex-1 text-left">Agents</span>
        </button>
      </div>
      {/* The Sessions header: the label + the `...` menu (the old tab
          bar's `...` menu moved here — right-aligned, next to the word
          `Sessions`). */}
      <div className="flex items-center justify-between px-2.5 py-2">
        <span className="text-ui-base text-foreground-subtlest">Sessions</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Session actions"
              title={newSessionError ?? undefined}
            >
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {/* The SAME command as the `New Session` button and the ⌘N chord now.
                It used to call the (deleted) hook directly, which no-oped with no
                Space selected — so this item was the one new-session surface with
                no dialog fallback: with no Space it looked alive and did nothing.
                Routing it through the store action gives it the fallback too. */}
            <DropdownMenuItem
              onSelect={() => void startSessionInActiveSpace()}
            >
              New Session in this Space
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* The list scroller (inside the content region above, which is what
          hides it while collapsed — see the note there). */}
      <div className="flex-1 overflow-y-auto">
        {views.length === 0 && (
          <p className="p-3 text-ui-sm text-foreground-subtlest">
            No spaces yet. Open a folder to get started.
          </p>
        )}
        {/* The ACTIVE space's sessions (the Spaces are the top TABS —
            the sidebar is sessions-only: no group headers, no folder
            icons, no `+`, no trust shield, no collapse chevrons — the
            list just scrolls). Live sessions first, then stored; within each
            group, MOST RECENTLY ACTIVE FIRST (`sortByActivity` — the same last
            message the row's time prints, so the order and the label agree). */}
        {activeView && (
          <div className="flex flex-col gap-0.5">
            {liveIds.map((id) => (
              <SessionRow
                key={id}
                sessionId={id}
                spaceName={activeView.title !== "" ? activeView.title : activeView.path}
                active={activeSessionId === id}
                onOpen={openSession}
              />
            ))}
            {storedIds.map((id) => (
              <SessionRow
                key={id}
                sessionId={id}
                spaceName={activeView.title !== "" ? activeView.title : activeView.path}
                active={activeSessionId === id}
                onOpen={openSession}
              />
            ))}
          </div>
        )}
        <ArchivedSection
          activeSessionId={activeSessionId}
          onOpen={openSession}
          onDelete={setDeleteTarget}
        />
      </div>
      {/* CLOSES the content region here, and that boundary is not cosmetic:
          `visibility: hidden` INHERITS into `fixed` descendants, so the dialogs
          below must sit OUTSIDE it or collapsing the pane would open a dialog
          and see nothing. The footer's toggle is outside for the same class of
          reason — it is the one control the sliver exists to keep. */}
      </div>
      {/* The collapsed rail's session overview: marks only, because a 40px
          sliver can hold the SHAPE of a list and nothing else. It mirrors the
          list it replaces (the ACTIVE space's sessions, in the list's own
          order — live first, then stored, which is why the ids come from the
          SAME `railIds` memo the statuses are derived from: two constructions
          of that order is two things that can drift, and a rail whose Nth mark
          is not the Nth row is worse than no rail).
          Rendered only while collapsed. No mark for the Space itself: the tabs
          are the space list, and the active one is lit directly above this
          column (the strip's `pl-1` aligns them). */}
      {collapsed && (
        <SessionRail
          rows={railIds.map((id) => ({
            key: id,
            status: statuses[id] ?? ("stored" as const),
            active: id === activeSessionId,
          }))}
          actions={railActions}
        />
      )}
      {/* NO Open Space dialog here: the render site is `App` root (the else-branch
          of the view ternary unmounts this pane while Settings is open, so a dialog
          owned here was raiseable-but-invisible on that page). The Skills and
          delete-confirm dialogs STAY — they are this pane's own, and raising them
          from the Settings page is not a thing. */}
      {skillsOpen && (
        <SkillsDialog skills={skills} onClose={() => setSkillsOpen(false)} />
      )}
      {/* The Agents modal — OUTSIDE the content region for the same reason the
          comment above names: that region is `visibility: hidden` while the pane
          is collapsed, and visibility inherits into `fixed` descendants, so an
          inside-mount would open the modal invisibly from the rail icon.
          `settings &&` is why the button stays clickable while the dialog waits:
          with no settings document there is nothing correct to edit (the modal
          reads `agentOverrides` off it), and `null` here means the boot load has
          not landed or failed. */}
      {agentsOpen && settings && (
        <AgentsDialog
          rows={agentRows}
          noSpaceOpen={activeSpacePath === null}
          settings={settings}
          models={models}
          tools={toolNames}
          onPatch={(next) => void patchAgentOverrides(next)}
          onClose={() => setAgentsOpen(false)}
        />
      )}
      {deleteTarget && (
        <DeleteSessionDialog
          title={deleteTargetTitle}
          onConfirm={() => {
            // The store's `deleteSession` removes the id from ALL lists
            // (live / stored / archived + messages + activeSessionId). The
            // dialog closes on success AND on failure (a stuck-open dialog
            // is worse); a failure is logged (no unhandled rejection).
            deleteSession(deleteTarget.sessionId)
              .then(() => setDeleteTarget(null))
              .catch((err) => {
                console.error("Failed to delete session:", err);
                setDeleteTarget(null);
              });
          }}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </aside>
  );
}

/**
 * One session row: the leading `SessionStatusMark` (spinner = in a turn,
 * `?` = a pending permission / `ask` / sudo password or a child holding one,
 * filled ring = live and idle, dim ring = stored — the SAME glyph set the
 * collapsed rail and the tab draw), the title with a gradient-fade mask
 * (applied to the text ITSELF — background-agnostic, so it works over
 * `bg-frame` / `bg-selected` / `bg-surface-hover` alike; the text is NOT
 * `truncate`-ellipsized, it overflows under the fade), and the right slot: the
 * relative time of last activity — ALWAYS the time. Hover swaps it for an
 * Archive button (stored sessions, reversible — no confirm; live rows have no
 * hover action — the pause concept is gone).
 *
 * THE TRAILING "Waiting" PILL IS GONE, and the `?` in the leading slot is why.
 * The pill and the rail's dot were the same fact drawn twice in two shapes,
 * and the pill's price was the time: while a session waited you could not see
 * how long ago it had been active. One attention glyph in the slot the spinner
 * already occupies (where the eye already looks for "what is this session
 * doing") says it in both sidebar states and leaves the time alone.
 */
function SessionRow({
  sessionId,
  spaceName,
  active,
  onOpen,
}: {
  sessionId: string;
  spaceName: string;
  active: boolean;
  onOpen: (sessionId: string) => void;
}) {
  const messages = useSessions((s) => s.messages[sessionId]);
  const isLive = useSessions((s) => s.sessions.some((x) => x.sessionId === sessionId));
  const archiveSession = useSessions((s) => s.archiveSession);
  // The row's generated title, read by id: `SessionRow` is given an id (by
  // design — its parent holds `liveSessionIds` / `storedSessionIds`, never the
  // rows), so no `SessionInfo` is threaded through `SpaceView` for it. The
  // selector returns a PRIMITIVE over the three-list walk (a `sessions` /
  // history / archived row): zustand v5 re-runs a selector that yields a
  // fresh OBJECT on every snapshot read, so `{ … }` here would re-render the
  // row forever — and it is the SAME walk the `cwd` lookups use.
  const storedTitle = useSessions((s) => {
    const titleOf = (rows: SessionInfo[]) =>
      rows.find((x) => x.sessionId === sessionId)?.title;
    return (
      titleOf(s.sessions) ??
      titleOf(s.historySessions) ??
      titleOf(s.archivedSessions) ??
      null
    );
  });
  // The row's mark (spinner / `?` / ring) comes from the SAME rule the
  // collapsed rail and the tab use — see `useSessionStatus`.
  const status = useSessionStatus(sessionId);
  const time = relativeTimeFor(messages);
  const title = titleFor(messages, spaceName, storedTitle);

  const rightSlot =
    time !== null ? (
      <span className="text-ui-sm text-foreground-subtle">{time}</span>
    ) : (
      // Empty slot — keeps alignment when there is no loaded transcript.
      <span className="size-4" />
    );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(sessionId)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(sessionId);
      }}
      className={`group flex cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1 py-1 ${
        active ? "bg-selected" : "hover:bg-surface-hover"
      }`}
    >
      {/* The state glyph, in the slot the spinner already owned: a session that
          is idle now wears a RING rather than nothing, which is the cue the
          collapsed rail has always had and the expanded list has never shown.
          16px = the slot's old `size-4`, so the title's indent is unchanged and
          these rows still line up with `ArchivedSessionRow`, whose leading slot
          is the same 16px. `dotSize={8}` halves the RING alone: the three
          states are three different amounts of ink, and the ring is the only
          one that reads as a solid chunk of paint, so at a shared 16px the
          idle state outshouted the working state above it — inverting their
          importance. The spinner and the `?` are outlines whose weight is what
          makes them readable, and they keep the full slot. No `testId`: the
          tests reach the mark through the STATE it paints (`[data-dot="…"]`) —
          the hook that asserts what the user sees rather than which node
          carried it. NO ink class either: the mark owns the ink
          (`text-foreground` on the active row, `text-foreground-subtlest`
          otherwise), and passing one from the row would fight it — which of two
          same-specificity utility classes wins is a CSS source-order fact this
          row cannot control. */}
      <SessionStatusMark status={status} active={active} size={16} dotSize={8} />
      <span
        className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ui-base text-foreground"
        style={{
          maskImage:
            "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
          WebkitMaskImage:
            "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
        }}
      >
        {title}
      </span>
      {isLive ? (
        // Live row: NO hover action (the pause concept is gone — the
        // session is never paused from the UI). The time slot is
        // always shown.
        rightSlot
      ) : (
        // Stored row: the time slot swaps for an Archive hover
        // button (archive is reversible, so it needs no confirm). The
        // slot still renders when NOT hovering.
        <>
          <span className="group-hover:hidden">{rightSlot}</span>
          <button
            type="button"
            title="Archive"
            aria-label={`Archive ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              void archiveSession(sessionId).catch((err) => {
                console.error("Failed to archive session:", err);
              });
            }}
            className="hidden size-6 items-center justify-center rounded-md group-hover:flex hover:bg-surface-hover"
          >
            <ArchiveIcon className="size-4" />
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The flat, cross-space Archived section (ZCode's
 * `WorkspaceArchivedTasksFlatSection` model adapted to Archimedes' row
 * style): rendered AFTER the Space groups, scrolling with the list.
 * COLLAPSED by default; the header (icon + "Archived" + count + chevron)
 * toggles it. The sticky live ids are view-filtered out — a resumed
 * archived session renders in its Space group (live), not here.
 */
function ArchivedSection({
  activeSessionId,
  onOpen,
  onDelete,
}: {
  activeSessionId: string | null;
  onOpen: (sessionId: string) => void;
  onDelete: (session: SessionInfo) => void;
}) {
  const [open, setOpen] = useState(false);
  const archived = useSessions((s) => s.archivedSessions);
  const sessions = useSessions((s) => s.sessions);
  const visible = archived.filter(
    (s) => !sessions.some((l) => l.sessionId === s.sessionId),
  );
  return (
    <div className="px-2.5 py-1">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "Enter") setOpen(!open);
        }}
        className="group flex cursor-pointer items-center gap-1 rounded-lg px-1 hover:bg-surface-hover"
      >
        <ArchiveIcon className="size-4 shrink-0 text-foreground-subtlest" />
        <span className="flex-1 truncate text-ui-base text-foreground-subtlest group-hover:text-foreground-subtle">
          Archived
        </span>
        <span className="text-ui-sm text-foreground-subtlest">
          {visible.length}
        </span>
        {open ? (
          <ChevronDownIcon className="size-4 shrink-0 text-foreground-subtlest" />
        ) : (
          <ChevronRightIcon className="size-4 shrink-0 text-foreground-subtlest" />
        )}
      </div>
      {open && (
        <div className="mt-1 flex flex-col gap-0.5">
          {visible.length === 0 ? (
            <p className="px-1 py-1 text-ui-sm text-foreground-subtlest">
              No archived sessions.
            </p>
          ) : (
            visible.map((session) => (
              <ArchivedSessionRow
                key={session.sessionId}
                session={session}
                active={activeSessionId === session.sessionId}
                onOpen={onOpen}
                onDelete={onDelete}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One archived-session row (the `SessionRow` visual pattern): 16px
 * leading slot (empty — archived sessions are NEVER live, so no
 * spinner), the title + a subtle `· {spaceName}` suffix ONLY when the title
 * is message-derived OR generated (skipped when the title IS the space name
 * — avoid "alpha · alpha"; a GENERATED title is never the space name, so the
 * cue still shows, which is exactly what this section needs most: it is
 * cross-space, so the Space is the one thing the row cannot omit), and the
 * relative time (empty slot when the transcript was not loaded this boot).
 * Hover: Unarchive (`ArchiveX`, reversible — no confirm) + Delete (`Trash2`,
 * the only destructive action — confirm dialog). Click opens the transcript
 * (identical to a stored row — the first send resumes it).
 */
function ArchivedSessionRow({
  session,
  active,
  onOpen,
  onDelete,
}: {
  session: SessionInfo;
  active: boolean;
  onOpen: (sessionId: string) => void;
  onDelete: (session: SessionInfo) => void;
}) {
  const messages = useSessions((s) => s.messages[session.sessionId]);
  const spaces = useSessions((s) => s.spaces);
  const unarchiveSession = useSessions((s) => s.unarchiveSession);
  const spaceName = spaceNameFor(session.cwd, spaces);
  const title = titleFor(messages, spaceName, session.title);
  const time = relativeTimeFor(messages);
  const showSuffix = title !== spaceName;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(session.sessionId)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(session.sessionId);
      }}
      className={`group flex cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1 py-1 ${
        active ? "bg-selected" : "hover:bg-surface-hover"
      }`}
    >
      <span className="size-4 shrink-0" />
      <span
        className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ui-base text-foreground"
        style={{
          maskImage:
            "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
          WebkitMaskImage:
            "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
        }}
      >
        {title}
        {showSuffix && (
          <span className="text-foreground-subtlest"> · {spaceName}</span>
        )}
      </span>
      <span className="group-hover:hidden">
        {time !== null ? (
          <span className="text-ui-sm text-foreground-subtle">{time}</span>
        ) : (
          // Empty slot — keeps alignment when there is no loaded transcript.
          <span className="size-4" />
        )}
      </span>
      <button
        type="button"
        title="Unarchive"
        aria-label={`Unarchive ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          void unarchiveSession(session.sessionId).catch((err) => {
            console.error("Failed to unarchive session:", err);
          });
        }}
        className="hidden size-6 items-center justify-center rounded-md group-hover:flex hover:bg-surface-hover"
      >
        <ArchiveXIcon className="size-4" />
      </button>
      <button
        type="button"
        title="Delete"
        aria-label={`Delete ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(session);
        }}
        className="hidden size-6 items-center justify-center rounded-md group-hover:flex hover:bg-surface-hover"
      >
        <Trash2Icon className="size-4" />
      </button>
    </div>
  );
}
