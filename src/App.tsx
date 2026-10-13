import { useEffect, useState, useSyncExternalStore } from "react";
import {
  listenInteractiveEvent,
  listenInteractiveRequest,
  listenInteractiveRequestClose,
  listenPermissionRequest,
  listenSessionClosed,
  listenSessionStalled,
  listenSessionTitled,
  listenSessionUpdate,
  listenSubagentClosed,
  listenSubagentSessionStarted,
  listSessions,
  listSpaces,
} from "./lib/tauri";
import { createBatchedSessionUpdate } from "./lib/batchSessionUpdates";
import { discardSessionMessages, useSessions } from "./store/sessions";
import { usePermissions } from "./store/permissions";
import { useInteractive } from "./store/interactive";
import { useSubagents } from "./store/subagents";
import {
  getLeftPaneCollapsed,
  LEFT_PANE_RAIL,
  LEFT_PANE_WIDTH,
  subscribeLeftPane,
} from "./lib/leftPaneState";
import SpacesList from "./components/SpacesList";
import SpaceTabs from "./components/SpaceTabs";
import ChatStream from "./components/ChatStream";
import SidePane from "./components/SidePane";
import WindowControls from "./components/WindowControls";
import SubagentDetailHost from "./components/SubagentDetailHost";
import { SubagentModals } from "./components/SubagentModals";
import SettingsPage from "./components/settings/SettingsPage";
import { useAttentionAlert } from "./hooks/useAttentionAlert";

function App() {
  // Attention alerts (ADR 0038/0039): arm the OS notification when a Session
  // has been paused on the user, disarm on the evidence or on their input.
  // VIEW-INDEPENDENT like the listeners below — mounted with the app, not with
  // the workspace, so a pause still alerts while the Settings page is open (the
  // workspace unmounts there).
  useAttentionAlert();

  // Register the Tauri event listeners once; dispatch into the stores.
  // `listen()` is async, so cleanup must await the pending registrations
  // before unlistening: React StrictMode re-runs the effect in dev, and a
  // stale listener that never gets unregistered doubles every event.
  useEffect(() => {
    const unlistenPromises: Array<Promise<() => void>> = [];
    // Coalesce the `session-update` events into one store update per frame:
    // a local agent at a high thinking level emits ~1000 chunks/sec, and one
    // React render per event would saturate the webview main thread (the UI
    // renders at ~1fps while the GPU sits idle — see `batchSessionUpdates.ts`).
    const batchedSessionUpdate = createBatchedSessionUpdate(
      (items) => useSessions.getState().applySessionUpdates(items),
      (fn) => requestAnimationFrame(fn),
    );
    unlistenPromises.push(
      listenSessionUpdate((payload) =>
        batchedSessionUpdate({
          sessionId: payload.sessionId,
          update: payload.update,
        }),
      ),
    );
    unlistenPromises.push(
      listenSessionClosed((payload) => {
        // Dismiss the session's interactive state (its pending prompts are
        // drained as cancelled server-side; the password is never kept).
        useInteractive.getState().dismissSession(payload.sessionId);
        useSessions
          .getState()
          .handleSessionClosed(payload.sessionId, payload.reason);
        // Defensive for EPHEMERAL (subagent) sessions: their transcript has
        // no stored history to keep, so a close that named one would delete
        // it (`discardSessionMessages` no-ops for MAIN ids, whose
        // `handleSessionClosed` behavior above stays unchanged). It is a
        // guard, not the path: no `session-closed` ever names a CHILD id, so
        // the child's transcript is freed by the `listenSubagentClosed`
        // handler below.
        discardSessionMessages(payload.sessionId);
      }),
    );
    // A Worker crash (ADR 0025): the `session-stalled` event marks the
    // session STALLED in the store (the `SessionStalledBanner`'s data
    // source — the `StalledInfo` shape: `at` + `crashLog`).
    unlistenPromises.push(
      listenSessionStalled((payload) =>
        useSessions
          .getState()
          .markStalled(payload.sessionId, payload.at, payload.crashLog),
      ),
    );
    // A generated session title (the naming pass): the label rides the
    // PUSH, because `listSessions` is fetched ONCE at boot (below) and
    // nothing re-fetches it — a title minted in this run would otherwise
    // never reach the sidebar / side pane.
    unlistenPromises.push(
      listenSessionTitled(({ sessionId, title }) =>
        useSessions.getState().titleSession(sessionId, title),
      ),
    );
    unlistenPromises.push(
      listenPermissionRequest((payload) =>
        usePermissions
          .getState()
          .addPrompt(payload.sessionId, payload.requestId, payload.request),
      ),
    );
    unlistenPromises.push(
      listenInteractiveRequest((payload) =>
        useInteractive.getState().addRequest(payload.sessionId, payload),
      ),
    );
    // A DROPPED `sudo_exec` sub-prompt (a turn cancel skips the flow's
    // exit-path cleanup) closes its modal (the Rust `SudoPromptCleanup`
    // drop guard emits `interactive-request-close` — pre-fix the modal
    // stayed open with no pending response, and a late answer got
    // `Ok(true)` with the send silently failing).
    unlistenPromises.push(
      listenInteractiveRequestClose((payload) =>
        useInteractive
          .getState()
          .removeRequest(payload.sessionId, payload.requestId),
      ),
    );
    unlistenPromises.push(
      listenInteractiveEvent((payload) => {
        const s = useInteractive.getState();
        // Wire names: the bus `COST_UPDATE` maps to `cost_update` (the
        // `archimedes:`-prefix-strip lookup), NOT `cost`.
        if (payload.event === "todos_update") {
          s.applyTodoUpdate(payload.sessionId, payload.payload);
        } else if (payload.event === "todos_clear") {
          // One argument: a clear names a SESSION, and the payload's `source`
          // is not consulted (ADR 0041).
          s.applyTodoClear(payload.sessionId);
        } else if (payload.event === "state") {
          s.applyState(payload.sessionId, payload.payload);
        } else if (payload.event === "cost_update") {
          s.applyCost(payload.sessionId, payload.payload);
        } else if (payload.event === "session") {
          s.applySession(payload.sessionId, payload.payload);
        }
      }),
    );
    // Subagent sessions (Task 4): the `subagent-session-started` /
    // `subagent-closed` events feed the subagents store (the panel's
    // authority for subagent STATUS + the metrics SNAPSHOT — the existing
    // `listenSessionClosed` handler above stays as-is; its interactive-store
    // deletion is exactly why the metrics live in the snapshot).
    unlistenPromises.push(
      listenSubagentSessionStarted((p) =>
        useSubagents.getState().addSession({
          sessionId: p.sessionId,
          parentSessionId: p.parentSessionId,
          agentName: p.agentName,
          task: p.task,
          status: "running",
          model: p.model,
          thinkingLevel: p.thinkingLevel,
        }),
      ),
    );
    unlistenPromises.push(
      listenSubagentClosed((p) => {
        // Discard the transcript BEFORE `markClosed` (order matters):
        // `markClosed` runs `evictOldestClosed`, which can evict this
        // entry synchronously (the oldest of 21+ closed entries by
        // insertion order) — a discard running AFTER would then no-op
        // its `entries[sessionId]` guard. The entry exists from
        // `subagent-session-started` (`dispatch_subagent` emits `started`
        // before it spawns the drive task that reaches `finish_subagent`) and
        // `running` entries are never evicted, so the discard-first order is
        // deterministic (absent an explicit user `dismiss`).
        //
        // Why discard here AT ALL: this is the ONLY frame that ever names
        // the end of a CHILD session, so it is the only thing that can free
        // the transcript the `subagent-session-started` handler's stream
        // filled in. Checked against the Rust (read only): `session-closed`
        // has exactly ONE emitter, `on_session_exited_expected`
        // (`src-tauri/src/agent/session/router.rs`), which returns without a
        // `live` entry, and the only insert into `live` is
        // `establish_worker_session` (`src-tauri/src/agent/session/mod.rs`)
        // on the main-session start / resume paths — a child has no `live`
        // entry, so no close frame ever carries its id (a crash would say
        // `session-stalled`, not a close). A child's teardown is
        // `finish_subagent` (`src-tauri/src/agent/worker/manager.rs`), which
        // emits `subagent-closed` and NOTHING else. So the
        // `listenSessionClosed` handler above cannot be the one that
        // discards here, and nothing else is: `markClosed`'s
        // `evictOldestClosed` drops the `SubagentEntry` alone and never
        // touches `useSessions.messages`, so without this call every child's
        // transcript would sit in the store for the life of the window.
        discardSessionMessages(p.sessionId);
        useSubagents
          .getState()
          .markClosed(p.sessionId, p.status, p.error, p.metrics);
        // The child's todo board goes too — same reasoning as the discard
        // above: this is the only frame that ever names the end of a CHILD
        // session, so nothing else would free the slice (`session-closed`
        // never carries a child id, and `src-tauri/` emits no `todos_clear`
        // frame at all).
        //
        // NARROW on purpose: `applyTodoClear`, NOT `dismissSession` — the
        // latter would also wipe the child's pending gates, and that IS the
        // state ADR 0040's amendment records (paraphrased here, not quoted): a
        // closed child keeps its gate card on screen until its entry is
        // evicted.
        useInteractive.getState().applyTodoClear(p.sessionId);
      }),
    );
    return () => {
      for (const p of unlistenPromises) {
        p.then((unlisten) => unlisten()).catch(() => {});
      }
    };
  }, []);

  // On boot, load the stored sessions AND spaces (the client owns history:
  // every session survives a restart). `listSessions(true)` fetches the
  // FULL list (archived included); the store splits it by the flag, and
  // `setSpaces` auto-selects (Task 5) the recent landing for boot. No
  // listener changes: close reasons flow through the existing
  // `handleSessionClosed`).
  //
  // The content-area view: the workspace (the default) OR the settings
  // page (opened from the `SpacesList`'s gear icon). While settings is
  // open the workspace UNMOUNTS (the ZCode `opacity-0` + `inert` pattern
  // is for keeping the workspace MOUNTED — the stores are the source of
  // truth and re-hydrate on remount, so the simpler unmount is used): a
  // session running in the background keeps streaming into the stores
  // (the listener `useEffect`s above are view-independent), and the
  // `SpacesList` / `ChatStream` / `SidePane` re-read them on remount.
  const [view, setView] = useState<"workspace" | "settings">("workspace");
  // The Subagent sheet needs to know about this transition, and it is told — it
  // is not rewritten. `SubagentDetailHost` lives in the ternary's else-branch, so
  // opening Settings UNMOUNTS the sheet while `useSubagentSelection` keeps its
  // value; `SubagentModals` is a sibling of the whole ternary and reads that
  // selection to decide whether to dodge the sheet, so a selection naming a sheet
  // that is not mounted would detach the card panel by the sheet's own width
  // (`SUBAGENT_SHEET_WIDTH`) and float it across the Settings page. The fix is to
  // hand that overlay the one fact it cannot see for itself — `sheetMounted` on
  // the JSX below — NOT to `select(null)` on the way in: the selection is the
  // SHEET's state (`store/subagentSelection`, written only by `SubagentDetailHost`
  // and the `SubagentDelegatingCard` rows that open the sheet), so clearing it here
  // both reached across a store boundary to fix a different component's geometry
  // and cost the user their open
  // sheet, leaving Back from Settings with the transcript closed. Keeping the
  // selection is also the cheaper answer: the sheet re-mounts with the same
  // transcript it had, and the `hidden`-class outer `div` plus the store-backed
  // rows mean nothing else needs re-syncing.
  // The panes' collapsed flags (the shared `leftPaneState` /
  // `leftPaneState` module — the SAME flag the pane reads, so the pane's own
  // toggle and this segment agree without event guessing. The left logo
  // segment is the sidebar's width, so the tabs start exactly where the centre
  // column begins: it follows the sidebar's collapse state (260px expanded,
  // `LEFT_PANE_RAIL` collapsed) and MUST use the rail, not 0, or the tabs
  // would drift 40px left of the content column's edge while collapsed.
  const sidebarCollapsed = useSyncExternalStore(
    subscribeLeftPane,
    getLeftPaneCollapsed,
  );
  useEffect(() => {
    Promise.all([listSessions(true), listSpaces()])
      .then(([rows, spaces]) => {
        useSessions.getState().setHistorySessions(rows);
        useSessions.getState().setSpaces(spaces);
      })
      .catch((err) =>
        console.error("failed to load stored sessions/spaces", err),
      );
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-xl bg-frame text-foreground">
      {/* Frameless window chrome (the window is `decorations: false` in
          tauri.conf.json, so this bar replaces the native titlebar).
          BROWSER-STYLE: the Space tabs live HERE (the window titlebar
          row — the reference screenshot's tabs-in-menubar look), NOT in
          the center column. The WHOLE bar is the drag region
          (`data-tauri-drag-region="deep"` on the container): Tauri's
          drag-region script honors a BARE attribute only on the element
          a mousedown lands on DIRECTLY — the bar's children (the logo
          segment, the tab spacer) would be dead zones. "deep" extends
          the region to the whole subtree, so the bar's empty areas drag
          the window (double-click maximizes / restores) while the inner
          buttons / tabs (interactive elements without the attribute)
          still block it and stay clickable. The left segment's width
          is the sidebar's width (the tabs start where the center column
          begins; it follows the sidebar's collapse state: 260px expanded,
          0px collapsed — the icon clips away with it). Each pane owns its own
          collapse toggle in its INNER-bottom corner while it is open (see
          `SpacesList` / `SidePane`); the bar carries a pane control ONLY while
          that pane is collapsed, because the collapsed pane clips its own
          toggle away and no keyboard shortcut exists to bring it back. The
          gear stays in the sidebar footer. In the settings view (the
          workspace unmounts) the segment is `flex-1` (full width — the
          old chrome-bar layout; no tabs, no pane controls). */}
      <div
        data-tauri-drag-region="deep"
        className="flex h-10 shrink-0 items-center bg-frame pr-2"
        data-testid="chrome-bar"
      >
        {view === "settings" ? (
          <div className="flex h-full flex-1 items-center pl-3">
            <img
              src="/app-icon-large.png"
              alt="Archimedes"
              className="h-4 w-4 rounded-sm object-contain select-none pointer-events-none"
              draggable={false}
            />
          </div>
        ) : (
          <>
            <div
              style={{ width: sidebarCollapsed ? LEFT_PANE_RAIL : LEFT_PANE_WIDTH }}
              className="flex h-full shrink-0 items-center pl-3"
            >
              <img
                src="/app-icon-large.png"
                alt="Archimedes"
                className="h-4 w-4 rounded-sm object-contain select-none pointer-events-none"
                draggable={false}
              />
            </div>
            {/* Pane controls live at the BOTTOM of their own panes in BOTH states
                (see `SpacesList` / `SidePane`) — a collapsed pane keeps a sliver of
                width so its toggle stays under the cursor, so the chrome bar holds no
                pane control at all. */}
            <SpaceTabs />
          </>
        )}
        <WindowControls />
      </div>
      <div className="flex min-h-0 flex-1" data-testid="content-row">
        {view === "settings" ? (
          // Full width — the `SpacesList` is NOT rendered in the settings
          // view (the `SettingsPage`'s own 268px section sidebar is the
          // left edge).
          <SettingsPage onBack={() => setView("workspace")} />
        ) : (
          <>
            <SpacesList onOpenSettings={() => setView("settings")} />
            {/* The center column: the chat (the Spaces are the chrome
                bar's TABS — the old top row is gone). */}
            <div className="flex min-w-0 flex-1 flex-col">
              <ChatStream />
            </div>
            <SidePane />
            {/* The subagent transcript sheet: the `fixed` right-side panel
                holding the SELECTED subagent's transcript (a child gate is
                never rendered here — `SubagentModals` below and `MessageList`
                own every gate). A `fixed` overlay, so its position in the flex
                row does not affect layout. */}
            <SubagentDetailHost />
          </>
        )}
        {/* The child-gate overlay host: the half of every child's gates that
            the transcript structurally cannot render — every `confirm`/
            `password` `Dialog`, and the `ask`/permission of a child whose
            parent is NOT the active session (the active parent's half renders
            inline in `ChatStream`'s transcript). A SIBLING of the whole
            settings ternary, not a child of `SidePane`/`SubagentDetailHost`:
            those live in the else-branch and render NOTHING while Settings is
            open, which would strand the gates it owns. A `fixed` overlay, so
            its position in this flex row does not affect layout.
            `sheetMounted` is the one fact that split gives it: the sheet above
            unmounts with this ternary while the overlay does not, so the overlay
            is told which view is up instead of inferring it from the sheet's
            selection store (which survives the transition, so the user's open
            transcript survives it too). */}
        <SubagentModals sheetMounted={view === "workspace"} />
      </div>
    </div>
  );
}

export default App;
