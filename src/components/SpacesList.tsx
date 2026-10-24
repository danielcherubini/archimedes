import {
  useCallback,
  useEffect,
  useMemo,
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
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type ModelDto,
  type SessionInfo,
  listModels,
  listTools,
} from "../lib/tauri";
import { basenameOfPath } from "../lib/paths";
import { sessionFieldOf } from "../lib/sessionLookup";
import { titleFor } from "../lib/sessionTitle";
import { relativeTimeFor } from "../lib/sessionTime";
import {
  getLeftPaneCollapsed,
  LEFT_PANE_RAIL,
  LEFT_PANE_WIDTH,
  subscribeLeftPane,
} from "../lib/leftPaneState";
import { openNewSpaceDialog } from "../lib/newSpaceDialogState";
import { archivedInSpace, useSessions, spaceViewFor } from "../store/sessions";
import { useSessionStatus } from "../hooks/useSessionStatus";
import { useSessionStatuses } from "../hooks/useSessionStatus";
import { useSkillCatalog } from "../hooks/useSkillCatalog";
import { useAgentCatalog } from "../hooks/useAgentCatalog";
// The Agents modal's write chain (D2): the optimistic publish, the serialized
// saves, the publish epoch and the rollback-on-failure, with the settings
// document the dialog's render gate reads.
import { useAgentOverridesWrites } from "../hooks/useAgentOverridesWrites";
import SkillsDialog from "./SkillsDialog";
import AgentsDialog from "./AgentsDialog";
import DeleteSessionDialog from "./DeleteSessionDialog";
import SessionRail, { type SessionRailAction } from "./SessionRail";
import { SessionStatusMark } from "./SessionStatusMark";
import { SessionListRow } from "./SessionListRow";
import { RowButton } from "./RowButton";
import { EmptyListLine } from "./EmptyListLine";
import { cn } from "./lib/utils";
import { Kbd } from "./ui/kbd";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

function spaceNameFor(cwd: string, spaces: { path: string }[]): string {
  const match = spaces.find((s) => s.path === cwd);
  return match ? basenameOfPath(match.path) : basenameOfPath(cwd);
}

/**
 * THE SIDEBAR'S FOUR LABELLED COMMAND BUTTONS (Open Space, New Session, Skills,
 * Agents) — one ghost `<Button>` recipe, spelled ONCE because all four drew the
 * identical box.
 *
 * The FIRST argument is what `Button`'s base and the `default` size would add
 * that these four never had, and each entry only names a group the row below
 * does NOT spell (so the row always wins a group it owns — see C7's recipe):
 *  - `border-0` — the base's `border` is a 1px ring; with `h-8` it would make
 *    the row 34px and inset the label by 1px. `border-0` removes the width
 *    outright (the base's `border-transparent` alone keeps 28px→30px).
 *  - `justify-start` — the size centres content; these rows are labelled and
 *    read left-to-right (the `Kbd` sits at the end via its own `flex-1` label).
 *  - `transition-none` — the base fades hover colour over 150 ms; this band
 *    has never had a fade, and it stays as drawn.
 *  - `select-auto` — the base makes the label unselectable.
 *  - `whitespace-normal` — the base's `whitespace-nowrap` is a REAL repaint
 *    here, not a cosmetic one: the original row inherited `white-space: normal`
 *    from its container, so a label long enough for a narrow pane wrapped. The
 *    base would force it onto one line and overflow the 244px column.
 *  - `shrink` — the base's `shrink-0` is `flex-shrink: 0`. The parent is a
 *    `flex flex-col` box, so shrink applies to HEIGHT here, and a short pane
 *    would otherwise stop these four from compressing as they always have.
 *    `shrink` is `flex-shrink: 1`, i.e. the value they had before.
 *  - `[user-select:auto]` — the base's `select-none` makes the label
 *    unselectable. The two spellings are NOT interchangeable and the difference
 *    is which mechanism resolves it (measured against the built sheet and the
 *    real `cn()`): `select-auto` is the SAME tailwind-merge group as
 *    `select-none`, so naming it makes the merge DROP `select-none` — the merge
 *    decides. `[user-select:auto]` is an arbitrary property, a different group,
 *    so BOTH survive the merge and the CASCADE decides; `.select-none` sits at
 *    offset ~45.8k in the built sheet and `[user-select:auto]` is emitted after
 *    it (~45.9k), so this wins. Note `.select-auto` is emitted BEFORE
 *    `.select-none` (~45.7k) — so if the merge ever stopped dropping
 *    `select-none`, the plain `select-auto` spelling would lose the cascade and
 *    the label would go unselectable with nothing failing in jsdom.
 *
 * NO line-height negation is needed, and adding one would be dead code: the
 * base's `text-ui-base/relaxed` carries BOTH the size and `line-height: 1.625`,
 * and the row spells `text-ui-base` — measured, `cn("text-ui-base/relaxed",
 * "text-ui-base")` keeps only `text-ui-base`, i.e. the row's utility deletes
 * the base's whole compound, line-height included. So the row ends up with no
 * `line-height` declared at all and inherits preflight's
 * `html{line-height:1.5}` — exactly what it inherited before. (A
 * `leading-[1.5]` placed before the row is itself deleted by that same
 * `text-ui-base`, which is why it is absent rather than redundant.)
 *
 * NOT in the wall, because the row string spells it and comes LAST, so the row
 * already wins it: `hover:bg-surface-hover` (the ghost arm's `hover:bg-hover`
 * is a DIFFERENT colour in three palettes — zai-dark and Dracula read 5%
 * against surface-hover's 10% — so this is exactly the conflict the recipe
 * exists for, and the row resolves it).
 *
 * The rest of the base is inert HERE, and the reason per token:
 *  - `bg-clip-padding` — no background is painted at rest;
 *  - `outline-none` — `base.css:53-57` already forces
 *    `outline: none !important` on every `:focus`/`:focus-visible`, in every
 *    browser and again under `forced-colors`;
 *  - `disabled:*` / `aria-invalid:*` / `aria-expanded:*` — none of these four
 *    is ever disabled, nothing sets `aria-invalid` on them, and none carries
 *    `aria-expanded` (the `DropdownMenuTrigger` beside them does; these do not),
 *    so the arm's `aria-expanded:bg-hover` has no element to fire on;
 *  - `[&_svg]:pointer-events-none` — the handler is on the button, so the click
 *    is handled either way;
 *  - `[&_svg]:shrink-0` — the icons are fixed `size-4`;
 *  - `[&_svg:not([class*='size-'])]:size-3.5` — every icon here is created with
 *    an explicit `size-4`, so the `:not([class*=size-])` guard excludes all of
 *    them (this is the C2 chrome-bar trap, and it does not bite here);
 *  - `has-data-[icon=inline-*]:pr/pl` — no child carries `data-icon`
 *    (lucide-react v1.47's `createLucideIcon` sets no such attribute, and
 *    `Kbd`'s slot attribute is `data-slot="kbd"`, which that selector does not
 *    match).
 */
const SIDEBAR_COMMAND_BUTTON =
  "border-0 justify-start transition-none whitespace-normal shrink [user-select:auto]";

/**
 * The box all four sidebar command buttons drew, VERBATIM, before C7 routed
 * them through `<Button>`. It is the SECOND argument to `cn()` at every one of
 * the four sites, so it wins every tailwind-merge group it spells against
 * `Button`'s base and the `default` size — that ordering is what makes the swap
 * paint-neutral, and it is why this string is kept whole rather than folded
 * into the constant above. `hover:bg-surface-hover` is one of them: the ghost
 * arm's `hover:bg-hover` is a DIFFERENT colour in three palettes (zai-dark and
 * Dracula read 5% where `--color-surface-hover` reads 10%), so letting the arm
 * win that group would repaint the hover fill.
 */
const PANE_COMMAND_ROW =
  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-ui-base hover:bg-surface-hover";

/**
 * THE HOVER-REVEALED SESSION-ROW ACTIONS — Stop / Archive on a live or stored
 * row, Unarchive / Delete on an archived one. Four affordances, one box, drawn
 * by three different components (`SessionRow` and `ArchivedRow`), so the recipe
 * lives here once.
 *
 * `ROW_HOVER_ACTION` is the negation wall (groups the row does NOT spell, and
 * which `Button`'s base or the `icon-sm` size would otherwise change);
 * `SESSION_ROW_ACTION_ROW` is the row's own class list VERBATIM and comes LAST,
 * so it wins every group it spells. Both go to `cn()` at all four sites.
 *
 * What the wall undoes:
 *  - `border-0` — the base's `border` is a 1px ring; on a `size-6` box that is
 *    a 26px hit target where 24px was measured and pinned by the row's
 *    alignment, and it shifts the glyph 1px.
 *  - `transition-none` — the base fades hover colour over 150 ms. These appear
 *    on row hover ALREADY (`group-hover:flex`); layering a second fade on the
 *    fill would change what a hovering pointer sees.
 *  - `shrink` — the base's `shrink-0` is `flex-shrink: 0`. These four are flex
 *    ITEMS of the row (`RowButton` is a `flex` box), so the base would stop a
 *    long title from squeezing them the way it always could. `shrink` is
 *    `flex-shrink: 1` — the value they had.
 *
 * What the row itself wins by being LAST, and why that matters here:
 *  - `hover:bg-surface-hover` over the ghost arm's `hover:bg-hover` (different
 *    colours in zai-dark and Dracula — 5% vs 10%);
 *  - `hidden` + `group-hover:flex` over the base's `inline-flex` — the
 *    hover-reveal mechanism is the whole design of this affordance and it has
 *    to survive;
 *  - `items-center`, `justify-center`, `rounded-md`, `size-6`.
 *
 * Inert additions, with the reason:
 *  - `text-foreground` and `hover:text-foreground` (the ghost arm) — the row
 *    spells NO colour and inherits one anyway: `App.tsx:360`'s root is
 *    `bg-frame text-foreground`, and nothing between it and this button sets a
 *    colour, so the arm's ink IS the inherited ink. Same computed colour;
 *  - `bg-clip-padding` — `padding-box` is CSS's initial `background-clip`, so
 *    declaring it changes nothing;
 *  - `outline-none` — `base.css:53-57` forces `outline: none !important` on
 *    every `:focus`/`:focus-visible` anyway, in every browser and again under
 *    `forced-colors`;
 *  - `disabled:*` / `aria-invalid:*` / `aria-expanded:*` — none of the four is
 *    ever disabled, and nothing sets `aria-invalid` or `aria-expanded` on it
 *    (the `aria-pressed` pane toggles in `ChromeControls` do; these do not);
 *  - `text-ui-base/relaxed` — 14px/1.625 declared where the button previously
 *    inherited the UA's 16px (this app never sets a root `font-size`; it sizes
 *    text only through `--ui-font-size` and the `text-ui-*` utilities, and
 *    neither this button nor the `RowButton` it sits in spells one). Inert
 *    because there is no text: the only child is an `<svg class="size-4">`, and
 *    `size-4` is `calc(var(--spacing) * 4)` — rem, not em — inside a fixed
 *    `size-6` box. `whitespace-nowrap` and `select-none` have no text to act
 *    on either;
 *  - `[&_svg]:pointer-events-none` — the click handler is on the button, so the
 *    event is handled whether it lands on the button or is retargeted to it;
 *  - `[&_svg]:shrink-0` — the glyph is a fixed `size-4`;
 *  - `[&_svg:not([class*='size-'])]:size-3` — every icon here is created with
 *    an explicit `size-4` (`SquareIcon`, `ArchiveIcon`, `ArchiveXIcon`,
 *    `Trash2Icon`), so the `:not([class*=size-])` guard excludes all of them.
 *    This is the C2 chrome-bar trap, and it does not bite here;
 *  - `has-data-[icon=inline-*]:pr/pl` — no child carries `data-icon`
 *    (lucide-react v1.47's `createLucideIcon` sets no such attribute);
 *  - `group/button` — nothing in the tree reads that group.
 *
 * NOT `RowButton`, and this is the C4 rule, not an oversight: these are real
 * `<button>`s. A second `role="button"` inside the row would resolve every
 * `.closest('[role="button"]')` read in `SpacesList.test.tsx` to the action
 * instead of the row, and `ToolCallCard.test.tsx`'s nesting pin keeps the
 * `button`-in-`button` count at zero — `Button` renders a `<button>`, which is
 * what the row's `div[role=button]` already expects as a child.
 */
const ROW_HOVER_ACTION = "border-0 transition-none shrink";
const SESSION_ROW_ACTION_ROW =
  "hidden size-6 items-center justify-center rounded-md group-hover:flex hover:bg-surface-hover";

/** The rail's ids while NO **Space** is selected. A module-level constant rather
 *  than an inline `?? []`, so the array's IDENTITY is stable across renders in
 *  that case — see `railIds`. */
const NO_SESSION_IDS: string[] = [];


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
  const sessionRecency = useSessions((s) => s.sessionRecency);
  // The boot order map (ADR 0075): the ONLY thing that lets a LIVE row keep its
  // slot. Read here because `spaceViewFor` needs it as an argument — the pane
  // does not otherwise care about position, and T04 renders `sessionIds`
  // straight through.
  const sessionOrder = useSessions((s) => s.sessionOrder);
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
  // dialog takes rows as props. The settings document and the `agentOverrides`
  // write path come from `useAgentOverridesWrites` below — this mount is still the
  // only place that owns a write path, the hook is where that path now lives.
  const [agentsOpen, setAgentsOpen] = useState(false);

  // The `spaces` arrive in the MANUAL order (`list_spaces` reads the stored
  // order column), and `views = spaces.map(spaceViewFor)` INHERITS it — so the
  // tab strip and the sidebar's group order cannot disagree (spec §4). Nothing
  // here sorts, and no database column name belongs in this file.
  const views = useMemo(
    () =>
      spaces.map((s) =>
        // `{ recency }` only, on purpose: subscribing this pane to the whole
        // `messages` map would re-render the entire list on every streamed token
        // (the hazard this call site has always avoided, and still does — a ROW
        // subscribes to its own transcript, the LIST subscribes to none). The
        // boot recency map is the same SQL expression, so the close-reason
        // banner's Landing Session is decided on the same number, just read at
        // boot.
        spaceViewFor(s, sessions, historySessions, closeReasons, archivedSessions, {
          recency: sessionRecency,
        }, sessionOrder),
      ),
    [spaces, sessions, historySessions, closeReasons, archivedSessions, sessionRecency, sessionOrder],
  );
  // The ACTIVE SPACE's view — the ROW LIST's source (`sessionIds`, the rows
  // themselves and every row's Space name), NOT a new-session input any more.
  // `⌘N` used to branch on it (`undefined` → the
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
  // NO ordering subscription here, on purpose (ADR 0075): the pane used to
  // subscribe to each row's last message stamp — as a primitive key, so
  // streaming would not re-sort it — purely so it could re-rank the rows for
  // display. The order now comes from the store (`sessionIds`) already settled,
  // so the pane reads NOTHING about activity for position. A ROW still
  // subscribes to its own transcript for its time label; that is per-row and
  // does not move a slot.
  // The rail's ids are the ROWS' ids — the same array, not a second
  // construction of the same order (ADR 0075; the rail's contract is "the Nth
  // mark is the Nth row", and two derivations of one order is two things that
  // can drift). No `useMemo`: this is a field read, and the module-level empty
  // array keeps the input identity stable while no Space is selected.
  const railIds = activeView?.sessionIds ?? NO_SESSION_IDS;
  // The rail's statuses, derived by the SAME rule the rows use (one
  // subscription for the whole list — see `useSessionStatuses`). Read
  // unconditionally: the rail only paints while collapsed, but the ids are the
  // active view's either way and a hook cannot be conditional.
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
  // The settings document used to be read here (`useSettings((s) => s.settings)`);
  // it now comes back from `useAgentOverridesWrites` below, which reads the same
  // store through the same selector — the dialog's render gate and its write path
  // are one owner.
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

  // The Agents modal's ONE write path for `agentOverrides` — D2 moved the chain
  // (optimistic publish, serialized saves, the publish epoch, the rollback) into
  // `useAgentOverridesWrites`, because the chain is the modal's contract and not
  // this pane's: it is pinned property-by-property in
  // `hooks/useAgentOverridesWrites.test.ts`, and `SpacesList.test.tsx` (with the
  // two characterisation pins at the end of its Agents block) is the proof the
  // move preserved the behaviour. The hook also owns the settings document this
  // pane reads for the dialog's render gate — same store, same selector, one
  // fewer place that knows where the document comes from.
  //
  // What is NOT in the hook and stays named here: nothing. The epoch capture
  // moved with the chain rather than staying at a call site, because the link
  // that reads it moved too — splitting the two would put the counter and its
  // consumer in different files for no gain.
  const { settings, rolledBackWrites, patchAgentOverrides } =
    useAgentOverridesWrites();

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
        className={cn("flex min-h-0 flex-1 flex-col", collapsed && "invisible")}
      >
      <div className="flex flex-col gap-2 p-3">
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={handleOpenSpace}
          className={cn(SIDEBAR_COMMAND_BUTTON, PANE_COMMAND_ROW)}
        >
          <FolderOpenIcon className="size-4" />
          <span className="flex-1 text-left">Open Space</span>
          <Kbd className="text-foreground-subtlest">⌘O</Kbd>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={handleNewSession}
          className={cn(SIDEBAR_COMMAND_BUTTON, PANE_COMMAND_ROW)}
        >
          <MessageCirclePlusIcon className="size-4" />
          <span className="flex-1 text-left">New Session</span>
          <Kbd className="text-foreground-subtlest">⌘N</Kbd>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={() => setSkillsOpen(true)}
          className={cn(SIDEBAR_COMMAND_BUTTON, PANE_COMMAND_ROW)}
        >
          <SparklesIcon className="size-4" />
          <span className="flex-1 text-left">Skills</span>
        </Button>
        {/* The Agents modal (the ONE Agent surface — Settings has no Agents
            section). No `Kbd`, matching `Skills`: neither is a chord. `BotIcon`
            moved here from the deleted Settings nav entry. */}
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={() => setAgentsOpen(true)}
          className={cn(SIDEBAR_COMMAND_BUTTON, PANE_COMMAND_ROW)}
        >
          <BotIcon className="size-4" />
          <span className="flex-1 text-left">Agents</span>
        </Button>
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
          <EmptyListLine>No spaces yet. Open a folder to get started.</EmptyListLine>
        )}
        {/* The ACTIVE space's sessions (the Spaces are the top TABS —
            the sidebar is sessions-only: no group headers, no folder
            icons, no `+`, no trust shield, no collapse chevrons — the
            list just scrolls). The rows render the MANUAL order: ONE
            sequence spanning live and stored (`activeView.sessionIds`),
            with no group headers — a row's live-ness stays visible as its
            `SessionStatusMark`, never as its position. The row's time is
            still its last message, and it is now deliberately DECOUPLED
            from its slot (pinned by "updates a row's relative time while
            its POSITION stays frozen"). */}
        {activeView && (
          <div className="flex flex-col gap-0.5">
            {activeView.sessionIds.map((id) => (
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
          list it replaces (the ACTIVE space's sessions, in the SAME order —
          the marks and the rows read ONE array, `activeView.sessionIds`, which
          is why `railIds` is a field read and not a second derivation: two
          constructions of that order is two things that can drift, and a rail
          whose Nth mark is not the Nth row is worse than no rail).
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
          // The mount owns the save, so it is the only place that can say "that write
          // did not land". The dialog hands its stored-pin suppression back on that
          // fact — a rolled-back edit explains nothing about the fetch-time column.
          rolledBackWrites={rolledBackWrites}
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
 * relative time of last activity — ALWAYS the time. Hover swaps it for the
 * row's actions: EVERY row swaps, live or stored. A live row offers Stop then
 * Archive (`inTurn` → cancel the turn, else close the Session), a stored row
 * offers Archive alone (reversible — no confirm). The live row used to have no
 * hover action at all: the Pause button was deleted and nothing replaced it, so
 * a running Session could not be stopped or put away without opening it first.
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
  // design — its parent holds `sessionIds`, the id sequence, never the
  // rows), so no `SessionInfo` is threaded through `SpaceView` for it. The
  // selector returns a PRIMITIVE via the ONE three-list walk
  // (`lib/sessionLookup.ts` — live / history / archived, live first): zustand
  // v5 re-runs a selector that yields a fresh OBJECT on every snapshot read, so
  // `{ … }` here would re-render the row forever.
  const storedTitle = useSessions(
    (s) => sessionFieldOf(s, sessionId, "title") ?? null,
  );
  // The row's mark (spinner / `?` / ring) comes from the SAME rule the
  // collapsed rail and the tab use — see `useSessionStatus`.
  const status = useSessionStatus(sessionId);
  // The SAME field `stopSession` reads at click time — so tooltip and action can
  // never disagree about WHICH field they mean. A flip between the last render
  // and the click is the render/click gap `stopSession` accepts on purpose
  // ("paint and click are not the same tick"), not drift this row could hide.
  const inTurn = useSessions((s) => !!s.inTurn[sessionId]);
  const stopSession = useSessions((s) => s.stopSession);
  const time = relativeTimeFor(messages);
  const title = titleFor(messages, spaceName, storedTitle);

  // Stop first: it is the action that pertains to a session that is RUNNING, so the
  // row reads left-to-right as "stop what's running, then put it away". The Archived
  // row keeps its destructive control OUTERMOST (Unarchive then Delete); this row
  // deliberately does not copy that — Archive is not destructive (ADR 0016:
  // reversible, and it never destroys a transcript).
  //
  // The actions are plain `<button>`s, NOT `RowButton`: a `role="button"` inside
  // the row would resolve every `.closest('[role="button"]')` read in
  // `SpacesList.test.tsx` to the button instead of the row, and would turn each
  // `rowOf(…).getByRole("button", …)` into a multiple-match throw.
  const actions = (
    <>
      {isLive && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={inTurn ? "Stop this turn" : "Stop this session"}
          aria-label={`Stop ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            void stopSession(sessionId).catch((err) => {
              console.error("Failed to stop session:", err);
            });
          }}
          className={cn(ROW_HOVER_ACTION, SESSION_ROW_ACTION_ROW)}
        >
          <SquareIcon className="size-4" />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="Archive"
        aria-label={`Archive ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          void archiveSession(sessionId).catch((err) => {
            console.error("Failed to archive session:", err);
          });
        }}
        className={cn(ROW_HOVER_ACTION, SESSION_ROW_ACTION_ROW)}
      >
        <ArchiveIcon className="size-4" />
      </Button>
    </>
  );

  // The state glyph, in the slot the spinner already owned: a session that
  // is idle now wears a RING rather than nothing, which is the cue the
  // collapsed rail has always had and the expanded list has never shown.
  // `dotSize={8}` halves the RING alone: the three states are three different
  // amounts of ink, and the ring is the only one that reads as a solid chunk of
  // paint, so at a shared 16px the idle state outshouted the working state
  // above it — inverting their importance. The spinner and the `?` are outlines
  // whose weight is what makes them readable, and they keep the full slot. No
  // `testId`: the tests reach the mark through the STATE it paints
  // (`[data-dot="…"]`) — the hook that asserts what the user sees rather than
  // which node carried it. The mark owns its own ink (`text-foreground` on the
  // active row, `text-foreground-subtlest` otherwise) — see
  // `SessionListRow`'s note on why the row must not pass one.
  return (
    <SessionListRow
      title={title}
      active={active}
      time={time}
      onOpen={() => onOpen(sessionId)}
      leading={
        <SessionStatusMark status={status} active={active} size={16} dotSize={8} />
      }
      actions={actions}
    />
  );
}

/**
 * The **active Space's** Archived section: the archived rows whose `cwd` is the
 * selected Space, rendered AFTER that Space's groups and scrolling with the
 * list. COLLAPSED by default; the header (icon + "Archived" + count + chevron)
 * toggles it. The count is the SAME array the rows render, so it is the Space's
 * count and never the app-wide total.
 *
 * The ORDER is explicit recency, and the two filters below are `archivedInSpace`'s
 * rather than this component's — one call, so the badge, the rows and the sort
 * cannot disagree. This section is the list ADR 0075 calls the trap: it used to
 * inherit its order from the query's input order and get recency for free, and
 * once that query returned the Manual order it presented a manual arrangement
 * under a heading that means recency while passing every test that did not assert
 * the order.
 *
 * Two filters, both load-bearing (applied by the store function, whose own doc
 * says why):
 * - the sticky live ids are view-filtered out — a resumed archived session
 *   renders in its Space group (live), not here (CONTEXT.md "Archived session");
 * - rows of another Space are excluded — the section is the SELECTED Space's, so
 *   a sibling tab's archived rows appear when that tab is selected, never while
 *   this one is. A row whose Space has no open tab at all is **Detached** and is
 *   listed in Settings → Detached sessions; there is no fallback listing here.
 *
 * With no Space selected (`activeSpacePath === null`) `cwd === null` matches
 * nothing, so the "No archived sessions." empty state renders while archived rows
 * exist. That is honest: none of them belong to a Space the sidebar is showing.
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
  const activeSpacePath = useSessions((s) => s.activeSpacePath);
  // The recency the section sorts by (ADR 0075). `{ recency }` only, never
  // `{ recency, messages }`: subscribing this section to the transcripts would
  // re-render it on every streamed token, and the boot map is the same SQL
  // expression the row's label reads (T03's D3, inherited here).
  const sessionRecency = useSessions((s) => s.sessionRecency);
  // ONE call, so the badge and the rows cannot disagree, and so the sort is the
  // STORE's — said out loud — rather than an order inherited from a query that
  // since ADR 0075 returns the Manual order. The defect this line closes: the
  // section used to `archived.filter(…)` in input order and inherit recency for
  // free, and after T01's ORDER BY swap that input order became the Manual
  // order — a manual arrangement under a heading that means recency, passing
  // every test that did not assert the order (this is the one that does).
  const visible = archivedInSpace(activeSpacePath, archived, sessions, {
    recency: sessionRecency,
  });
  return (
    <div className="px-2.5 py-1">
      <RowButton
        onClick={() => setOpen(!open)}
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
      </RowButton>
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
 * spinner), the title, and the relative time (empty slot when the
 * transcript was not loaded this boot). NO `· {spaceName}` suffix: the
 * section is scoped to the active Space, so a row here can never belong to
 * another Space and the cue would only repeat what the header already says.
 * (`spaceName` still feeds `titleFor` as the last-resort label when the
 * session has neither a generated title nor a loaded transcript.)
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
  // Unarchive first, Delete OUTERMOST: Delete is the only destructive action on
  // this row (confirm dialog), so it sits furthest from the content. The live
  // row deliberately does NOT copy this rule — Archive there is reversible and
  // never destroys a transcript (ADR 0016), so it can sit outside Stop.
  //
  // NO `leading` prop: an archived Session is NEVER live, so the leading slot is
  // `SessionListRow`'s empty 16px spacer — the same width the status mark
  // occupies, which is what keeps these rows aligned with the ones above.
  return (
    <SessionListRow
      title={title}
      active={active}
      time={time}
      onOpen={() => onOpen(session.sessionId)}
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Unarchive"
            aria-label={`Unarchive ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              void unarchiveSession(session.sessionId).catch((err) => {
                console.error("Failed to unarchive session:", err);
              });
            }}
            className={cn(ROW_HOVER_ACTION, SESSION_ROW_ACTION_ROW)}
          >
            <ArchiveXIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Delete"
            aria-label={`Delete ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(session);
            }}
            className={cn(ROW_HOVER_ACTION, SESSION_ROW_ACTION_ROW)}
          >
            <Trash2Icon className="size-4" />
          </Button>
        </>
      }
    />
  );
}
