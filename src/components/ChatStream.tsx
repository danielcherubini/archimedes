import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  cancelSession,
  readClipboardImage,
  readFileBytes,
  sendPrompt,
  compactSession,
} from "../lib/tauri";
import { basenameOfPath } from "../lib/paths";
import { describeIpcError } from "../lib/ipcError";
import { fuzzyMatch } from "../lib/fuzzy";
import { composerCommands, parseComposerCommand } from "../lib/composerCommands";
import {
  activeMentionToken,
  dirPartOfOutsideQuery,
  expandMentions,
  isOutsideSpaceQuery,
  type ComposerPrefix,
} from "../lib/skills";
import { groupConsecutiveFileWrites } from "../lib/toolGroups";
import {
  addImageAttachments,
  agentSupportsImages,
  draftIsMarkerOnly,
  imageMarker,
  insertAtCaret,
  MAX_CHAT_ATTACHMENTS,
  readAttachmentAsBase64,
  releaseAttachment,
  renumberImageMarkers,
  shiftImageMarkers,
  type ChatComposerAttachment,
} from "../lib/chatAttachments";
import { inferAttachmentMimeType, shouldPreferSpreadsheetClipboardText } from "../lib/chatAttachmentMetadata";
import { useSessions } from "../store/sessions";
import { usePermissions } from "../store/permissions";
import { useInteractive } from "../store/interactive";
import { useSettings } from "../store/settings";
import { useHasPendingRequest } from "../hooks/useHasPendingRequest";
import { useActiveSpaceCwd } from "../hooks/useActiveSpaceCwd";
import { useChildGates, isInlineChildGate } from "../hooks/useChildGates";
import { useSpinQuip } from "../hooks/useSpinQuip";
import { useMentionCatalogs, useCompletionDir } from "../hooks/useMentionCatalogs";
import { normalizeVariant } from "../lib/braille-loader";
import SessionStalledBanner from "./SessionStalledBanner";
import MessageList from "./chat/MessageList";
import ComposerRow from "./chat/ComposerRow";
import ComposerModals, { WorkingIndicator } from "./chat/ComposerModals";
import type { MentionRow } from "./chat/ComposerMentions";

/**
 * The cap on the picker's RENDERED rows (`filtered`) for the `?` File
 * completion ONLY, independent of the backend's walk cap
 * (`MAX_PICKER_ENTRIES` in `src-tauri/src/commands/files.rs`). The `?` branch
 * filters with `fuzzyMatch` — a loose SUBSEQUENCE match — so a short query
 * like `?e` can match nearly the whole listing (up to the walk cap), and
 * thousands of `<button>`s re-rendered per keystroke is a real perf gap.
 * Applied INSIDE the rows memo (never in the render), so `activeIndex`, the
 * `% filtered.length` arrow-wrap and the DOM all see ONE bounded list — a
 * render-time cap would let the highlight land on a row that is not displayed.
 *
 * WHY TEN, and WHY `?` ONLY. Capping a path query costs little: its catalog is
 * the ENTIRE Space listing, and two more typed characters collapse a thousand
 * matches into a handful (`sort_by_file_name` keeps the survivor set
 * deterministic), while 10 single-line rows are ≈308px at the default 14px UI
 * font (`--ui-font-size`) — a normal dropdown. The three Mentions
 * (`$` / `@` / `#`) are deliberately UNCAPPED, and NOT by omission: because
 * the cap is a slice INSIDE the rows memo, a sliced row is a row no keyboard
 * user can ever reach, and their catalogs are small and user-owned rather than
 * the whole filesystem. What bounds that uncapped case is GEOMETRY, not a count
 * — the picker box clamps its own height (a font-size-relative `max-height`)
 * and scrolls the active row into view — which is exactly why a count cap here
 * is about KEYS and PERF and never about height. See the Mention branch of the
 * rows memo for the same reasoning at the point of the missing slice.
 */
const MAX_PICKER_ROWS = 10;

export default function ChatStream() {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  // Selectors must return stable references (no fresh `[]` fallbacks inside
  // the selector) or Zustand re-renders forever.
  const messages =
    useSessions((s) =>
      s.activeSessionId ? s.messages[s.activeSessionId] : undefined,
    ) ?? [];
  const liveSession = useSessions((s) =>
    s.activeSessionId
      ? s.sessions.find((x) => x.sessionId === s.activeSessionId)
      : undefined,
  );
  // Searches BOTH stored lists: a session living ONLY in
  // `archivedSessions` (opened from the Archived section) must still resolve
  // here — otherwise it renders no banner, a disabled composer ("This session
  // is closed"), and an unreachable `send()` auto-resume. One selector
  // returning a `??` of two finds (stable-reference rule preserved).
  const historySession = useSessions((s) =>
    s.activeSessionId
      ? (s.historySessions.find((x) => x.sessionId === s.activeSessionId) ??
          s.archivedSessions.find(
            (x) => x.sessionId === s.activeSessionId,
          ))
      : undefined,
  );
  const inTurn = useSessions((s) => (s.activeSessionId ? !!s.inTurn[s.activeSessionId] : false));
  const stopReason = useSessions((s) => (s.activeSessionId ? s.stopReasons[s.activeSessionId] : undefined));
  const prompts =
    usePermissions((s) =>
      activeSessionId ? s.prompts[activeSessionId] : undefined,
    ) ?? [];
  // Interactive surfaces for the ACTIVE session (B3): the store is keyed by the
  // ACP session id, which matches `activeSessionId`.
  const interactiveRequests =
    useInteractive((s) =>
      activeSessionId ? s.requests[activeSessionId] : undefined,
    ) ?? [];
  const askRequests = interactiveRequests.filter((r) => r.method === "ask");
  const confirmRequests = interactiveRequests.filter((r) => r.method === "confirm");
  const passwordRequests = interactiveRequests.filter(
    (r) => r.method === "password",
  );
  // An `ask` request is ANCHORED when a `tool-call` message with its
  // `toolCallId` is in the stream (correlated by `(source, toolCallId)` —
  // only a `main` ask can anchor; the desktop has no ACP `tool_call` frame
  // for child tool calls). Anchored requests render IN PLACE of the
  // `ToolCallCard`; the rest stack in the stream (arrival order).
  const anchoredAskRequestIds = new Set<string>();
  for (const r of askRequests) {
    if (
      r.source === "main" &&
      r.toolCallId &&
      messages.some((m) => m.kind === "tool-call" && m.id === r.toolCallId)
    ) {
      anchoredAskRequestIds.add(r.requestId);
    }
  }
  const stackedAskRequests = askRequests.filter(
    (r) => !anchoredAskRequestIds.has(r.requestId),
  );
  const addUserMessage = useSessions((s) => s.addUserMessage);
  // A Client-authored transcript line — the `/compact` no-op's only feedback
  // (ADR 0044). Pulled the same way every other store action is pulled here.
  const addSystemLine = useSessions((s) => s.addSystemLine);
  const beginTurn = useSessions((s) => s.beginTurn);
  const turnCompleted = useSessions((s) => s.turnCompleted);
  const resumeSession = useSessions((s) => s.resumeSession);

  // The interactive agent state for the active session. `inTurn` is the
  // ground truth for "a turn is in flight" (set by `beginTurn`, cleared
  // by `turnCompleted`) — a STALE `idle` from the previous turn must
  // not unlock the composer or hide the working indicator, so `inTurn`
  // wins alongside `working` (the store does not reset `agentState` on
  // `turnCompleted` — a store follow-up; an agent that hasn't
  // pushed yet is covered the same way: its turn IS in flight).
  const agentState = useInteractive((s) =>
    activeSessionId ? s.agentState[activeSessionId] : undefined,
  );
  const workingOrInTurn = agentState === "working" || inTurn;
  // The active session's in-flight compaction reason (ADR 0045) — the
  // `compaction_update` frame the harness emits around a compaction, and the
  // ONLY signal for one: an idle compaction (the `/compact` command) emits no
  // `turn_start` / `agent_settled`, so `inTurn` stays false and `agentState`
  // stays idle. Indexed on `s.activeSessionId` INSIDE the selector (the outer
  // `activeSessionId` is `string | null`, which TS2538 rejects as an index).
  const compacting = useSessions((s) =>
    s.activeSessionId ? s.compacting[s.activeSessionId] : undefined,
  );
  // The working-indicator spinner style (the settings' `spinnerStyle` — a
  // `braille-loader` variant name): `null` / absent = the `typing` default.
  // A hand-edited settings file may carry an unknown name: `normalizeVariant`
  // falls back to the loader's `breathe` default (never an invalid variant).
  const spinnerStyle = normalizeVariant(
    useSettings((s) => s.settings?.spinnerStyle ?? "typing"),
  );
  /**
   * (ADR 0031's follow-up) Whether the `#` trigger names an MCP server. The
   * fail-safe default is OFF — `settings` is `null` until the first load
   * lands, and `#` is the prefix that collides with pasted developer text
   * (`#include`, `#123`), so an unknown state must behave like "off", never
   * like "on".
   *
   * THE GATE IS THE CATALOG, NOT A FLAG PARAMETER. Both the picker and the
   * send-path expansion are ALREADY catalog-gated (a token expands only if the
   * catalog has that exact name — the load-bearing invariant of ADR 0031), so
   * feeding the mention code an EMPTY MCP catalog switches `#` off completely
   * with NO new code path: `expandMentions` finds no match and returns the
   * text BYTE-IDENTICAL (its verbatim invariant), and `filtered` yields no
   * rows, so the picker renders nothing and every keyboard branch (gated on
   * `filtered.length > 0`) stays inert — Enter still sends, no keys are
   * swallowed. The `$` / `@` catalogs are untouched.
   *
   * The DISPLAY side is deliberately NOT gated: `MessageBubble` splits the
   * persisted text with `splitMentionBlocks`, so a message sent while the
   * trigger was ON keeps rendering its `<mcp>` chip after the toggle goes OFF
   * (the record is unchanged, and the content-based `mergeDedupeKey` resume
   * merge stays byte-stable).
   *
   * The `useMentionCatalogs` FETCH below is NOT gated either — it is a cheap
   * config read, and gating it would make a live toggle require a remount
   * before the rows appear.
   */
  const mcpMentionsEnabled = useSettings(
    (s) => s.settings?.mcpMentionsEnabled ?? false,
  );
  // A `blocked` agent is mid-turn AWAITING a request response
  // (`inTurn` is true) — the SEND must stay disabled for the whole wait
  // (pre-branch, `main`'s composer locked on `inTurn`): the harness is
  // one-turn-at-a-time (a prompt while a turn is in flight is REJECTED,
  // not queued — `send_prompt`'s atomic `pending_turn` claim), so sending
  // concurrently would fail + clobber the turn bookkeeping. The TEXTAREA
  // is always editable (you can draft while the agent works — `send()`'
  // `composerLocked` guard no-ops Enter, the draft is kept for when the
  // turn ends). (`agentState === "blocked"` also covers a blocked state
  // without an in-flight turn, where `inTurn` alone would not lock.)
  // A compaction locks for the same reason: the harness is one-turn-at-a-time
  // and a prompt racing the rewrite would be rejected (or reorder history).
  const composerLocked =
    workingOrInTurn || agentState === "blocked" || compacting !== undefined;
  // Called UNCONDITIONALLY at the top of the component body (the hook
  // contains `useState`/`useEffect` — invoking it inside the `working`
  // branch would be a conditional hook call and crash React when the
  // state flips).
  const quip = useSpinQuip(workingOrInTurn);
  // The session's config options, its context usage and the derived percentage /
  // ramp used to be computed HERE and threaded down as props, because the
  // composer's bottom row hosted the model / thinking selectors and the context
  // bar. That row is gone: the three lines live at the bottom of the side pane
  // (`SessionConfigBlock.tsx`), which runs the SHARED derivations
  // (`lib/sessionConfig.ts`) inside its own selectors. `isLive` below stays — the
  // composer still needs it for the auto-resume path.

  // Whether the user owes an answer — the ACTIVE session's own prompts/pauses,
  // or ANY child's gate anywhere in the app — and here it drives the "Send a
  // prompt to start" hint's suppression (see `hasPendingRequest` below). It is
  // the SAME hook the `SidePane` and `SpacesList` toggles read for their
  // `bg-warning` dots, so the cue in the transcript and the dots cannot drift
  // (one derivation, many consumers).
  // The subagent half is app-wide ON PURPOSE: every NON-active parent's gates
  // are on screen in the `SubagentModals` overlay, so the cue means "you owe
  // something, somewhere" and never lies. Which Session owes it is the inline
  // card's and the parent row's status' business, not this dot's, and an
  // unrendered gate would strand the child INDEFINITELY anyway (ADR 0055: a
  // child parked on a gate is an Active Subagent and no clock bounds it)
  // — so counting wide is both honest and safe. Called UNCONDITIONALLY,
  // BEFORE the `!activeSessionId` early return below: it reads stores via
  // `useSyncExternalStore` (zustand), so
  // calling it only on the full-frame path would change the hook count when the
  // active session appears/disappears and crash React ("Rendered more hooks than
  // during the previous render" → white page). Pinned by the ChatStream test that
  // goes no-session → active-session WITH a pending child gate.
  const hasPendingRequest = useHasPendingRequest();
  // The gates this Session's CHILDREN are holding on the user (the inline half
  // of the render-site partition): they render INLINE at the bottom of THIS
  // transcript, because the parent — the session on screen — is who the child
  // is waiting for. `SubagentModals`
  // renders the complementary half (a child whose parent is NOT active, plus
  // every child's `confirm`/`password` `Dialog`s), so exactly one site draws
  // any one gate. Called UNCONDITIONALLY, BEFORE the `!activeSessionId` early
  // return, for the same reason as the hook above: it reads three stores via
  // `useSyncExternalStore`, so a hook count that depends on the active session
  // crashing React when one appears. `null` → `[]` (no session, no transcript).
  const childGates = useChildGates(activeSessionId);
  // The gates of that list that actually draw a row IN THIS TRANSCRIPT (the
  // same predicate `MessageList` filters its rows with — one definition, so the
  // count and the render cannot drift). `confirm`/`password` are overlay
  // `Dialog`s, so they are NOT rows here: the auto-scroll dep below counts THIS,
  // never `childGates.length`, or a child's sudo prompt would yank the
  // transcript to the bottom for a row that never appeared.
  const inlineChildGates = childGates.filter(isInlineChildGate);

  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Image attachments staged in the composer (CONTEXT.md: Attachment).
  // ALL of the attachment hooks live HERE, before the `!activeSessionId`
  // early return below — a hook called only on the full-frame path would
  // change the hook count when the active session appears/disappears and
  // crash React (the same bug the `useHasPendingRequest` comment
  // above warns about).
  const [attachments, setAttachments] = useState<ChatComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  /** Attachments handed to a send that has not settled yet, keyed by session id.
   * They are OUT of `attachments` (so their thumbnails leave the composer
   * immediately) but NOT released — a failed send puts them back. */
  const heldForSendRef = useRef<Map<string, ChatComposerAttachment[]>>(new Map());
  // Re-sync every render: the handlers read the CURRENT list from the ref
  // (a render closure would be stale for fast successive events — e.g.
  // pasting 8 files then a 9th in separate dispatches without a re-render
  // in between). Also read by the unmount-cleanup effect below (the effect
  // intentionally runs once, so the ref is the only live view it has).
  attachmentsRef.current = attachments;
  // Task 5's double-send guard (a hook — must live here, not in `send`):
  // `beginTurn` runs AFTER an `await` (the base64 read), so the composer is
  // not locked until then and a second Enter/click during the read would
  // otherwise double-send. Keyed by session ID (a `Set`) so an in-flight
  // turn in session A never blocks sending in session B (concurrent sessions).
  const sendingSessionsRef = useRef<Set<string>>(new Set());
  // Re-sync every render (the same pattern as `attachmentsRef` above): `send()`
  // is async and reads the attachment via a FileReader `await` BEFORE
  // `beginTurn`, so the composer is unlocked during the read. If the session
  // switches during the read, the closure's `activeSessionId` is stale — this
  // ref is the LIVE value `send()` checks after the read and aborts on a
  // mismatch (no send, no draft wipe, no turn).
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  // The LIVE draft, re-synced every render (the same pattern as `attachmentsRef`
  // above): `send()` captures `draft` at click time and the composer is not
  // locked until `beginTurn`, so the user can edit the draft during the
  // `resume()`/FileReader awaits. The ref is the live value `send()` checks
  // after the read and aborts on a mismatch (no stale send, no draft wipe).
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Capability gate (FAIL-CLOSED): the feature is inert unless the agent
  // advertises `promptCapabilities.image === true`.
  const imageCapable = agentSupportsImages(
    liveSession?.capabilities ?? historySession?.capabilities,
  );
  // Unmount cleanup: revoke the staged object URLs exactly once, on
  // unmount ONLY — revoking on every state change would leak/break live
  // previews (a revoked URL can no longer render the `img`). The held-for-send
  // map is walked too: an unmount while a turn is in flight leaves those
  // attachments in NO state the composer can reach again, so this is their
  // last chance to be released.
  useEffect(
    () => () => {
      attachmentsRef.current.forEach(releaseAttachment);
      heldForSendRef.current.forEach((held) => held.forEach(releaseAttachment));
    },
    [],
  );
  // Esc stops inference: while a turn is in flight, Escape sends
  // `session/cancel` (the agent resolves the open prompt with
  // `stopReason: "cancelled"`, which completes `sendPrompt` and unlocks the
  // composer). The textarea is DISABLED during a turn (the composer is
  // locked), so the listener is global — and active only while `inTurn`,
  // so Esc never hijacks a keypress outside a turn. A compaction joins the
  // gate (Esc cancels a runaway `/compact`), which is why `compacting` is in
  // the DEPS too: without it the listener is never attached at idle and Esc
  // does nothing while compacting.
  //
  // KNOWN COSMETIC CONSEQUENCE (deliberate, not fixed here): `ComposerRow`
  // closes the `?`/`@`/`#` picker on Esc WITHOUT stopping propagation, so now
  // that the window listener can be attached while compacting, one Esc both
  // dismisses an open picker AND cancels the compaction. That is the
  // pre-existing shape during a turn — the fix belongs to the composer's key
  // handling, not to this gate.
  useEffect(() => {
    if ((!inTurn && compacting === undefined) || !activeSessionId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void cancelSession(activeSessionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inTurn, activeSessionId, compacting]);
  // Session-change guard: `ChatStream` is one long-lived component (no
  // `key`), so `attachments` would otherwise survive a switch to another
  // session — images staged in session A (image-capable) could be sent to
  // session B even if B's agent doesn't advertise `promptCapabilities.image`
  // (breaking the fail-closed guarantee). Clear + release on switch.
  const prevSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    if (prevSessionIdRef.current === activeSessionId) return;
    // Capture the session being LEFT BEFORE the overwrite below: at the
    // release point the ref would otherwise hold the session being ENTERED,
    // so the held-for-send lookup would miss — and the failure path's `delete`
    // drops that entry without releasing it, making the leak permanent.
    const left = prevSessionIdRef.current;
    prevSessionIdRef.current = activeSessionId;
    attachmentsRef.current.forEach(releaseAttachment);
    attachmentsRef.current = [];
    setAttachments([]);
    // A turn still in flight in the session we just left: its held
    // attachments can never be restored there (this effect already cleared the
    // composer) and can never be restored here, so release them now. `left`
    // can be `null` (no session → session), and nothing is ever held under a
    // `null` key, so the guard is both the type narrowing and the truth.
    if (left !== null) {
      const held = heldForSendRef.current.get(left);
      if (held) {
        held.forEach(releaseAttachment);
        heldForSendRef.current.delete(left);
      }
    }
  }, [activeSessionId]);
  // Window-level drop backstop: with `dragDropEnabled: false` (tauri.conf.json)
  // the webview receives native file drops — and the webview DEFAULT for a
  // file drop is to NAVIGATE to the file (replacing the app). A file dropped
  // anywhere OUTSIDE the composer must be swallowed: `preventDefault` on
  // every `dragover` makes the whole page a valid drop target, and this
  // backstop (the composer's own `onDrop` fires first during bubbling) stops
  // the navigation. (This also means NO composer-level `onDragOver` is
  // needed — the window listener covers the composer's dragovers too.)
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // Auto-grow the composer textarea: reset to `auto`, then the
  // border-box height — `scrollHeight` is the CONTENT height, but
  // `height` (border-box) must also cover the border (`offsetHeight -
  // clientHeight` is the border thickness); without it a ~2px deficit
  // leaves a scrollbar flicker near `max-h-32`. Re-applied on window
  // resize (a stale height would otherwise linger until the next
  // keystroke).
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const apply = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [draft]);

  // --- The four-prefix picker (`$` skills / `#` MCP servers / `@` agents —
  // the three Mentions — plus `?` File completion, ADR 0033) + the send-path
  // expansion (which the `?` prefix never enters). ---
  // ALL of the hooks below live in the UNCONDITIONAL top block (before the
  // `!activeSessionId` early return further down) — placing any of them after
  // the early return would change the hook count across the session/no-session
  // transition and crash React (the same bug the `useHasPendingRequest`
  // comment above warns about). Plain (non-hook) functions like `selectMention`
  // are placement-flexible (the file's own comment says so for the attachment
  // handlers) and live with the other handlers below.
  // The Space path is the active session's `cwd` (CONTEXT.md: a Session's
  // `cwd` IS the Space's folder) — the derivation now lives in
  // `useActiveSpaceCwd` (live first, then stored, BOTH stored lists), shared
  // with `App`'s `SpaceCwdProvider` so the composer's Space and the Space a
  // relative External-open resolves against cannot disagree. Called ABOVE the
  // `!activeSessionId` early return with every other hook (see the hook-count
  // note below). `useMentionCatalogs` caches per Space, so the composer and
  // the left pane share ONE skills fetch (same key — the skills row reuses
  // `useSkillCatalog` verbatim).
  const spacePath = useActiveSpaceCwd();
  // The MCP catalog FETCH is deliberately NOT gated on `mcpMentionsEnabled`
  // (a cheap config read; gating it would make a live toggle need a remount).
  const { skills, agents, mcpServers, files } = useMentionCatalogs(spacePath);
  // The `$`/`#`/`@`/`?`-trigger picker state (the active token (incl. its
  // prefix) + the highlighted row). The three Mention prefixes expand into a
  // block on send; `?` is File completion and expands nothing (ADR 0033).
  const [picker, setPicker] = useState<{
    prefix: ComposerPrefix;
    query: string;
    index: number;
  } | null>(null);
  // --- Out-of-Space Directory completion (ADR 0035) -----------------------
  // A `?` token whose remainder begins `/`, `~/` or a Windows drive root is NOT
  // a Space query: the picker switches from the cached Space **Listing** to
  // **Directory completion** for the ONE directory the token names. The mode is
  // derived from the token's remainder (`picker.query` IS that remainder — the
  // grammar already decided it, and `activeMentionToken` deliberately returns no
  // mode field), so there is exactly ONE source of truth for "which token is
  // under the caret".
  const activeRemainder = picker?.prefix === "?" ? picker.query : "";
  const outside = isOutsideSpaceQuery(activeRemainder);
  // The remainder up to and INCLUDING its last `/` — the DIRECTORY part
  // (`~/.config/ht` → `~/.config/`, `~/notes` → `~/`, `/etc/pas` → `/etc/`,
  // `C:/Users/you/pro` → `C:/Users/you/`). Every outside remainder has ≥1 `/`
  // (the root alternation in `FILE_ABSOLUTE_TOKEN_RE` requires one), so
  // `lastIndexOf` never misses. This value is the catalog's CACHE KEY, which is
  // why it is the directory and NOT the whole remainder: typing inside one
  // directory then changes only the SEGMENT, so the key is stable and exactly
  // ONE directory read happens per directory — the property the one-directory
  // peek is budgeted on. Pinned in `ChatStream.test.tsx` at THIS derivation (a
  // hook-level caching test cannot prove it: with `dirPrefix` as an argument the
  // hook only shows "same input, same output"), and mutation-checked — passing
  // `token.remainder` here reddens that test. `null` when not outside, which
  // maps to the hook's `__global__` key and the command's `None` arm (no
  // filesystem access at all).
  //
  // THE LAST `/` OF THE WHOLE REMAINDER — SPACES INCLUDED. A directory row
  // inserts its absolute path VERBATIM, so clicking `Application Support` leaves
  // a token naming `/home/u/Library/Application Support/`; cutting at the first
  // SPACE would make its `dirPrefix` `/home/u/Library/`, which reads the wrong
  // directory, renders rows that match nothing, and makes a spaced directory
  // UNDESCENDABLE — the exact case ADR 0035 admits spaces for. `dirPartOfOutsideQuery`
  // states the trade in full, including the cost accepted here: a draft whose
  // trailing PROSE contains a `/` (`?~/notes/ see src/x`) issues one real read
  // for a directory that cannot exist. It returns empty, renders nothing, and —
  // since `560f610` — briefly marks the listing pending, which holds Enter for
  // that one round trip and then sends as before. That is the cheaper loss; it
  // is still a loss, and no frontend rule can tell the two apart (they are the
  // same string shape — a space, then text containing a `/`), so only a
  // filesystem probe could.
  const dirPrefix = outside ? dirPartOfOutsideQuery(activeRemainder) : null;
  // The token's non-directory tail — what the rows are filtered by. The MIRROR
  // of the line above: the same `lastIndexOf("/")`, the other side of it, over
  // the same WHOLE remainder. The absorbed prose therefore lands INSIDE the
  // segment and `fuzzyMatch` is a subsequence test over it, so the directory's
  // contents decide (ADR 0035's accepted cost, pinned and explained in
  // `skills.ts`). Truncating the segment as well would silently rewrite that
  // accepted behaviour.
  const segment = outside
    ? activeRemainder.slice(activeRemainder.lastIndexOf("/") + 1)
    : "";
  // `.dir` DESTRUCTURES with a name: it is the payload (the module-level empty
  // constant while empty) and it is the `pickerRows` dep below, so it keeps the
  // identity the memo is graded on. `.pending` is the in-flight DESCENT signal —
  // see `useCompletionDir` for the contract and `ComposerRow` for the one key it
  // holds.
  const { dir: completion, pending: completionPending } =
    useCompletionDir(dirPrefix);
  // The catalog rows matching the active token. The three Mention prefixes
  // filter case-insensitively on a NAME SUBSTRING (v1: name only, not
  // description); `?` filters with `fuzzyMatch` — a SUBSEQUENCE match —
  // because a path query is path-SHAPED (`src/comp/Form` must reach
  // `src/components/Formula.tsx`). `picker?.query ?? ""` yields
  // the full list while the picker is null (harmless — the picker UI is gated
  // on `open && (filtered.length > 0 || note)` in `ComposerMentions`, and
  // `open` is the `picker` state, so a null picker renders nothing either
  // way). NULL-SAFE: the `picker` state is
  // `{…} | null` and this `useMemo` lives in the unconditional top block, so a
  // bare `picker.query` would be a TS18047 compile error under `strict: true`
  // (and a `picker!` "fix" would crash at render whenever the picker is
  // closed, i.e. nearly every render).
  // Returns the bounded rows AND the UNBOUNDED match count (the "too many
  // matches" note needs to know the cap actually trimmed something).
  const pickerRows = useMemo(() => {
    // ONE picker, filtered to the ACTIVE prefix's catalog only (a `$`/`#`/`@`
    // never mixes in one open list): map the matching catalog to `MentionRow`
    // (skills/agents carry `description`, the MCP servers carry their one-line
    // `summary`, and every `?` row — of either shape — carries NO description,
    // so it renders on one line). A Space `?` row puts the Space-RELATIVE path
    // in `name`; an OUT-OF-SPACE row puts the ABSOLUTE path in `name` (that is
    // what gets inserted) and the abbreviated `~/…` in `label` (ADR 0035).
    const prefix = picker?.prefix ?? "$";
    // STALE-TOKEN GUARD — what it actually protects (the hazards are easy to
    // overstate). The `picker` state is only recomputed in the textarea's
    // `onChange`/`onKeyDown`, so it can outlive the token it was derived from.
    // The case that matters: `send()` clears the draft but NEVER clears
    // `picker`, so on the pre-`?` code the picker VISUALLY RESURRECTED over an
    // emptied composer (and a catalog that landed afterwards — an in-flight
    // `listSpaceFiles`, ADR 0033's degradation path — re-fed it rows). The
    // Send button never passes through the keydown recompute at ALL, so this
    // guard is the only thing standing between a cleared draft and a picker
    // rendered on screen. THE LAYERING: this memo guard owns RENDERING (no
    // rows, no note); the keydown recompute in `ComposerRow` owns KEYS — it
    // re-derives the token from the caret on EVERY keydown and, with the token
    // gone, closes the picker AND sends on Enter, so Enter never "inserts" on a
    // cleared draft even without this guard. Deliberately NOT handled by
    // `setPicker(null)` in `send()`: that would be redundant (this guard is
    // strictly more general — any stale token, not just the send path), and the
    // `draft` dep below is free (the memo already re-derives per keystroke via
    // `picker`). The test itself is cheap and sound: `<prefix><query>` is by
    // construction a literal substring of the draft while the token is intact,
    // so its absence means the state is stale. DOM- and caret-free on purpose:
    // a ref read inside a `useMemo` is invisible to the dep graph.
    if (picker && !draft.includes(`${picker.prefix}${picker.query}`)) {
      return { rows: [], matched: 0, live: false };
    }
    // The `#` gate: with the trigger off, the MCP catalog is EMPTY, so `#`
    // yields no rows → the picker renders nothing and the keyboard branches
    // (gated on `filtered.length > 0`) never intercept a key — Enter still
    // sends. `mcpMentionsEnabled` is a DEP below, so flipping the setting
    // re-derives the rows LIVE (no remount, and the catalog FETCH is not
    // gated — see the `mcpMentionsEnabled` note above).
    const mcpCatalog = mcpMentionsEnabled ? mcpServers : [];
    const query = picker?.query ?? "";
    // `?` is File completion (ADR 0033) — the ONE non-Mention prefix, listed
    // FIRST so it never falls through to the skills catalog. The `key` carries
    // the trigger (`?` + path) because a path and a skill name could otherwise
    // collide; `description` is EMPTY, so a `?` row renders on ONE line
    // (`ComposerMentions` renders the secondary line only when it is `""`-free
    // text). It used to be `basenameOfPath(p)` — the basename is already the
    // TAIL of the path in the primary line, so that second line repeated what
    // the row just said and made every row ~50% taller for nothing.
    if (prefix === "?") {
      // THE ORDER OF THE TWO ARMS BELOW IS LOAD-BEARING FOR THE BEHAVIOUR, not a
      // style choice, and the reason is an ASYMMETRY between them: the Listing arm
      // is guarded by `!outside`, the out-of-Space arm is the unguarded
      // fall-through. Put the completion arm first and it swallows EVERY `?`
      // token, so a relative `?README` stops offering Space Listing rows.
      // MUTATION-CHECKED: neutering this guard reddens a GROUP of tests in
      // `ChatStream.test.tsx`, headed by "a relative `?query` still offers the
      // Space Listing rows and NEVER reads a directory" and including the
      // cap/note group around it. NO COUNT IS WRITTEN HERE ON PURPOSE: this note
      // said FOURTEEN, the group has since grown, and a number in a comment is a
      // countdown timer. If this ever wants reordering, the completion arm needs
      // its own `outside` guard first — do not just move it.
      //
      // There used to be a SECOND, purely textual reason for this order, and it is
      // GONE: a pin in `src/lib/skills.test.ts` read this file as TEXT, located a
      // filter predicate by scanning forward from this branch's gate, and ran it
      // through `new Function`. A swap broke that pin with `ReferenceError: segment
      // is not defined` while `ChatStream.test.tsx` reported the BEHAVIOUR as fine,
      // which was the misleading part — it made a real behavioural constraint look
      // like a test artifact. `86afd0d` deleted that pin outright (a rename of an
      // unrelated local made the whole file fail to LOAD, and every mutation it
      // caught was also caught by a component test) and replaced it with a test that
      // drives the real picker. So the order here now rests on the behaviour alone.
      //
      // IN the Space: the cached Listing, unchanged (ADR 0033). `name` is the
      // Space-RELATIVE path — what a Space file is addressed as — and
      // `selectMention` inserts it verbatim.
      if (!outside) {
        const fileRows: MentionRow[] = files.entries
          .map((p) => ({
            key: `?${p}`,
            prefix: "?" as const,
            name: p,
            description: "",
          }))
          .filter((r) => fuzzyMatch(query, r.name));
        const matched = fileRows.length;
        // The cap lives HERE, on the `?` branch alone: this is the one catalog
        // whose filter is a loose subsequence over an unbounded listing.
        return { rows: fileRows.slice(0, MAX_PICKER_ROWS), matched, live: true };
      }
      // OUT OF THE SPACE (ADR 0035): the rows are ONE directory's entries, not
      // the Space Listing. Filter the DTO entries FIRST and on each entry's OWN
      // `name`, then map — filtering the absolute `insert` instead is a real
      // bug, not a style point: a path is a strict SUPERSET of its own basename,
      // so path-filtering offers rows basename-filtering would drop (measured:
      // query `eu` offers `htop`, whose path `/home/u/.config/htop` contains
      // `e`…`u`, while its name does not). MUTATION-CHECKED — filtering
      // `e.insert` reddens "the outside rows are filtered on the entry's OWN
      // name" in `ChatStream.test.tsx`.
      //
      // The backend already returns directories first, and the sort below is
      // re-stated here rather than trusted: this is the branch that decides what
      // the DESCENT looks like, and a stable `sort` of an already-correct order
      // costs nothing (V8's sort is stable, so each group keeps the walker's
      // name order).
      const hits = completion.entries.filter((e) =>
        fuzzyMatch(segment, e.name),
      );
      const ordered = [...hits].sort(
        (a, b) => Number(b.isDir) - Number(a.isDir),
      );
      const rows: MentionRow[] = ordered.slice(0, MAX_PICKER_ROWS).map((e) => ({
        // `key`/`name` are the ABSOLUTE path — `selectMention` inserts
        // `row.name`, and nothing in this app expands a tilde (ADR 0035); the
        // row SHOWS `display`. No `?` prefix on the key: an absolute path
        // cannot collide with a skill/agent/server name, and within one
        // directory an insert is unique.
        key: e.insert,
        prefix: "?" as const,
        name: e.insert,
        label: e.display,
        isDir: e.isDir,
        description: "",
      }));
      // `matched` is the UNBOUNDED count, exactly as the Listing arm
      // returns it, because `pickerNote`'s "too many matches" arm reads it:
      // an outside branch that omitted it would silently kill that note.
      // MUTATION-CHECKED — returning the BOUNDED `rows.length` here reddens
      // exactly one test, "an outside completion caps at 10 rows and says the
      // too-many-matches note".
      return { rows, matched: hits.length, live: true };
    }
    // `/` is a **Composer command** (ADR 0044) — the fourth prefix on this
    // picker and the third semantics: a command row is CONSUMED on send, it
    // expands nothing and reaches no Agent. The arm MUST come before the
    // `prefix === "#" ? …` chain below, whose fall-through is `skills.map(…)`: a
    // `/` token that reached it would list every skill (an empty `/` query
    // matches every name). And the rows are built HERE rather than inside that
    // chain, because the chain ends in a shared case-INSENSITIVE name-SUBSTRING
    // filter — routing commands through it would silently replace the EXACT,
    // case-sensitive `startsWith` the grammar uses with a fuzzy match, and
    // `/COMP` would offer a row the dispatcher then refuses to run.
    // `startsWith` on the RAW `query` is therefore the one filter a command row
    // gets — NOT `activeRemainder`, which is `""` for any non-`?` prefix and
    // would list every command whatever the user typed.
    if (prefix === "/") {
      const rows: MentionRow[] = composerCommands
        .filter((c) => c.name.startsWith(query))
        .map((c) => ({
          // The `/` ON THE KEY keeps a command from colliding with a skill of
          // the same name (a `?` row does the same thing for the same reason).
          // `description` is required by `MentionRow`, and a command has one.
          key: `/${c.name}`,
          prefix: "/" as const,
          name: c.name,
          description: c.description,
        }));
      // Selection needs NO new code: `selectMention`'s final branch already
      // inserts `${row.prefix}${row.name.toLowerCase()} ` — `/compact ` — and
      // `setPicker(null)` ends the token, so the next Enter is a send. Pinned by
      // a test rather than implemented twice.
      return { rows, matched: rows.length, live: true };
    }
    const rows: MentionRow[] =
      prefix === "#"
        ? mcpCatalog.map((s) => ({
            key: s.name,
            prefix: "#",
            name: s.name,
            description: s.summary,
          }))
        : prefix === "@"
          ? agents.map((a) => ({
              key: a.name,
              prefix: "@",
              name: a.name,
              description: a.description,
            }))
          : skills.map((s) => ({
              key: s.name,
              prefix,
              name: s.name,
              description: s.description,
            }));
    const matchedRows = rows.filter((r) =>
      r.name.toLowerCase().includes(query.toLowerCase()),
    );
    // NO render cap here — deliberately, and NOT an oversight. The cap exists
    // for `?`'s unbounded SUBSEQUENCE filter over a whole-Space listing whose
    // rows are cheap to narrow by typing a couple more characters; the Mention
    // catalogs are name-SUBSTRING filters over the (small, user-owned) skills /
    // agents / MCP catalogs, and this branch keeps the shipped status quo
    // BYTE-IDENTICAL to before File completion. Capping it here would make
    // every row past the cap unreachable forever with no explanation — the cap
    // is a slice INSIDE this memo, so a sliced row is a row no keyboard user
    // can ever reach — a silent behavior change to a surface this feature
    // promised not to touch. It would also need its own note (the note below is
    // `?`-only), so the Mention side is UNCAPPED rather than silently capped; if
    // we ever want a cap there, it deserves its own change with its own note and
    // tests. What bounds the uncapped case is GEOMETRY, not a count: the picker
    // box clamps its own height (a font-size-relative `max-height`) and scrolls,
    // so a long list is a scrollbar instead of a column running off the top of
    // the window.
    return { rows: matchedRows, matched: matchedRows.length, live: true };
    // `files` is a DEP for the same reason `agents`/`mcpServers` are: a Space
    // switch (or a late first listing) must re-derive the rows LIVE, with no
    // extra keystroke. `completion` is a dep for the identical reason on the
    // other side of the branch: a directory listing that LANDS (the first fetch
    // for a directory, or the descent into the next one) has no further
    // keystroke to wait for, so without it the outside picker would look dead
    // rather than wrong — MUTATION-CHECKED, dropping it from these deps reddens
    // exactly the two tests that watch a descent come live on its own (the
    // DIRECTORY-row descent and the Windows drive-root one). And `label` is not
    // decoration: rendering `name` instead of `label ?? name` in
    // `ComposerMentions` reddens a large part of the ADR 0035 group, so "SHOW the
    // abbreviated form, INSERT the absolute one" is a tested contract on both
    // sides. NO COUNT IS WRITTEN HERE ON PURPOSE — it said seven, and the group has
    // grown since. `outside`/`segment`/`dirPrefix` are NOT deps: they are pure
    // functions of `picker`, which is one.
  }, [skills, agents, mcpServers, files, completion, mcpMentionsEnabled, picker, draft]);
  const filtered = pickerRows.rows;
  // The picker's one explanation line (never a row — see `ComposerMentions`).
  // Only ever for `?`: the only catalog that is bounded twice over (the walk
  // cap, then the render cap) — the Mention branch is uncapped and note-free.
  // PRECEDENCE: "too many matches" SHADOWS "listing capped" when both hold
  // (both true: the walk hit its cap AND the query still matched more than we
  // render), because the render cap is what the user is hitting right now and
  // "keep typing" is actionable for it; the walk cap is invisible below it.
  // WHY THE TWO ARMS' ADVICE DIFFERS: the render cap trims ROWS but every
  // match is still IN the listing, so narrowing genuinely reveals it — hence
  // "keep typing". The walk cap trims the LISTING itself, and the walk is
  // DETERMINISTIC, so the surviving 5,000 entries are always the SAME set:
  // a truncated-away file is therefore unreachable no matter what you type
  // (and this arm renders ALONE only when the query already matched
  // ≤ MAX_PICKER_ROWS, i.e. when the list is already narrow). So it states
  // the LIMITATION instead of giving advice that cannot help. WHICH 5,000
  // survive is the walk's OWN order, NOT the alphabetically-first 5,000
  // paths: `sort_by_file_name` sorts per DIRECTORY during the depth-first
  // walk, so a nested `src/a.rs` precedes a root-level `t.txt`
  // (`src-tauri/src/commands/files.rs`, pinned there by
  // `collect_files_sorts_display_order_across_directories`). Global
  // alphabetical order is what a FLAT directory degenerates to, and nothing
  // more — the determinism is the property the reasoning above needs, the
  // shape of the order is not.
  const pickerNote =
    picker?.prefix === "?" && pickerRows.live
      ? pickerRows.matched > MAX_PICKER_ROWS
        ? `Too many matches — keep typing to narrow the list`
        : // The cap note reads the truncation of the listing that is ACTUALLY on
          // screen: the directory being completed when the token is outside, the
          // Space Listing otherwise. `files.truncated || completion.truncated`
          // would report the Space's cap while the user completes somewhere else
          // entirely — a true statement about a listing they are not looking at.
          // MUTATION-CHECKED: that `||` reddens "the cap note for an outside
          // completion reads the DIRECTORY's truncation, not the Space's".
          (outside ? completion.truncated : files.truncated)
          ? `File listing capped — some files may be missing`
          : undefined
      : undefined;
  // The highlighted row index, DERIVED (not clamped in place): the raw
  // `picker.index` can go stale (a Space switch refetches `skills` while the
  // picker is open with a non-zero `index`), and `filtered[staleIndex]` would
  // be `undefined` → a `selectMention(undefined)` crash on Enter (the rows are
  // `MentionRow`s). `Math.max(0, …)` is belt-and-braces: the KEYBOARD branch
  // that consumes this index is gated on `filtered.length > 0`, so
  // `filtered.length - 1` is ≥ 0 there (the picker's RENDER gate is wider —
  // `rows || note` — but a note-only picker has no row to highlight).
  const activeIndex = picker
    ? Math.min(picker.index, Math.max(0, filtered.length - 1))
    : 0;
  // The `archimedes:insert-skill` listener (Task 4's left-pane rows dispatch
  // it): insert `$name ` at the caret and re-focus. Read through refs (the
  // `draftRef` mirror already exists) so the effect runs once and always sees
  // the LIVE draft (a render closure would be stale for fast events).
  useEffect(() => {
    const onInsertSkill = (e: Event) => {
      // Close the mention picker: the insert comes from OUTSIDE the
      // picker (a SkillsDialog row — the v1.1 flow), so a picker open at
      // insert time is stale (it would linger rendered until the next
      // keydown, and a token active at the caret would be spliced INTO).
      // The dialog inserts a `$`-prefixed SKILL token, so the picker this
      // closes is the skills one (`$` is the skill prefix).
      setPicker(null);
      const text = (e as CustomEvent<string>).detail;
      if (typeof text !== "string") return;
      const el = composerRef.current;
      const draft = draftRef.current; // the LIVE value (the ref mirror above)
      if (!el) {
        setDraft(draft + text);
        return;
      }
      const start = el.selectionStart ?? draft.length;
      const end = el.selectionEnd ?? start;
      const next = draft.slice(0, start) + text + draft.slice(end);
      setDraft(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + text.length;
        el.setSelectionRange(pos, pos);
      });
    };
    window.addEventListener("archimedes:insert-skill", onInsertSkill);
    return () => window.removeEventListener("archimedes:insert-skill", onInsertSkill);
  }, []);

  // A stored (non-live) session: its transcript is read-only unless the
  // agent negotiated `loadSession`, in which case it can be resumed.
  const isLive = !!liveSession;
  const isHistoryOnly = !isLive && historySession !== undefined;
  const canResume =
    isHistoryOnly && historySession?.capabilities.loadSession === true;
  // The composer's SEND is enabled for a live session OR a RESUMABLE
  // stored session (a non-resumable stored session can't receive a prompt
  // — no agent process to deliver to, and the harness's `send_prompt`
  // rejects an unknown session): a resumable stored session auto-resumes
  // on send. The TEXTAREA is always editable regardless (the draft is
  // kept — it just can't be SENT while `composerEnabled` is false).
  const composerEnabled = isLive || canResume;

  // The session's `SpaceView` moved to `SpaceTabs` (the top tab bar — the old
  // header row is gone: the session title lives in the side pane now, and the
  // `Live` conversation selector is replaced by the tabs); the `New Session in
  // this Space` action went to the sidebar's `Sessions` header, not the tab
  // bar. Auto-scroll to the bottom as new content streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [
    messages,
    prompts.length,
    stackedAskRequests.length,
    // A child's inline gate is at the BOTTOM of this transcript, so an
    // un-scrolled view would hide the very card the user must answer (the same
    // reason the two counts above are deps). The INLINE count, not the full gate
    // list — see `inlineChildGates` above.
    inlineChildGates.length,
  ]);

  if (!activeSessionId) {
    return (
      <main className="m-1 flex min-w-0 min-h-0 flex-1 items-center justify-center rounded-xl bg-chat">
        <p className="text-ui-base text-foreground-subtle">
          No active session — open a Space from the tabs above
        </p>
      </main>
    );
  }

  // `hasImages`: a staged attachment AND the capability — the last line of
  // the fail-closed defense. Staged attachments are already cleared on
  // session switch (Task 4), but a same-session capability regression must
  // not ship images to an agent that can't take them. With it, an
  // image-ONLY send while `!imageCapable` is blocked (an empty prompt +
  // unsent images is meaningless), while a text-only send simply doesn't
  // attach images.
  // `let`: re-derived after `resume()` below — the FRESH agent's
  // capabilities (not the saved ones) decide whether images ship.
  let hasImages = attachments.length > 0 && imageCapable;

  const send = async () => {
    const targetSessionId = activeSessionId;
    if (!targetSessionId) return;
    const rawText = draft.trim();
    // A marker is draft TEXT, so "the user pasted a screenshot and typed
    // nothing" is no longer `rawText === ""` — it reads `[image #1]`. Without
    // `draftIsMarkerOnly`, an image-only send on a session whose capability has
    // regressed would ship the SENTENCE "here is [image #1]" to an agent that
    // receives no image at all, which is worse than the empty prompt this guard
    // exists to block. Real prose is unaffected (still sent text-only).
    if (
      (!hasImages && (rawText === "" || draftIsMarkerOnly(rawText))) ||
      composerLocked
    )
      return;
    if (sendingSessionsRef.current.has(targetSessionId)) return; // guard: see the ref's comment above
    sendingSessionsRef.current.add(targetSessionId);
    try {
      setError(null);
      // ── A **Composer command** is consumed HERE and goes no further (ADR
      // 0044): no `addUserMessage`, no `beginTurn`, no `sendPrompt`, no
      // `turnCompleted`. ADR 0031's byte-identity contract is deliberately
      // narrower than "nothing in the draft is rewritten" — it governs text that
      // IS SENT, and this sends nothing.
      //
      // TWO PLACEMENT RULES, both load-bearing:
      //  • INSIDE the `try`, not before it. `send()` ends in a
      //    `finally { sendingSessionsRef.current.delete(targetSessionId) }`, so an early `return` above
      //    the `try` would leave the session stuck in the set and silently break EVERY
      //    later send — the composer would look alive and never fire.
      //  • BEFORE the `if (!isLive)` auto-resume block below. A command that
      //    fell through it would RESUME a stored session purely to compact it —
      //    the exact flow ADR 0044 rejects — and would then make
      //    `compact_session` report the session LIVE, so the non-live answer
      //    below could never happen. The order is the feature.
      // Because it also precedes the FileReader block, staged attachments are
      // left staged and unsent: a Composer command is not a prompt.
      const command = parseComposerCommand(rawText);
      if (command) {
        setDraft("");
        if (command.name === "compact") {
          // `args` are the user's extra summary instructions; an argument-less
          // `/compact` is `null`, NOT `""` (see `compactSession`). `false` is the
          // not-live answer, not an error, and this line is its only feedback —
          // a silent no-op would look like a dead button.
          const live = await compactSession(
            targetSessionId,
            command.args || null,
          );
          if (!live) {
            addSystemLine(
              targetSessionId,
              "Nothing to compact — this session is not open.",
            );
          }
        }
        return;
      }
      // Auto-resume a stored (non-live) session before sending. A non-resumable
      // stored session can't be sent to; a failed resume aborts (error already set).
      if (!isLive) {
        if (!canResume) return;
        if (!(await resume())) return;
        // The resume reconnected to a FRESH agent: the SAVED capabilities
        // that gated `hasImages` above are stale. Re-derive from the live
        // session's capabilities (the store's `resumeSession` just upserted
        // the resume result): if the fresh agent doesn't advertise
        // `promptCapabilities.image`, proceed text-only (the same
        // fail-closed treatment — an image-ONLY send is blocked, a text
        // send simply doesn't attach the staged images); if it DOES
        // advertise images, include them.
        const fresh = useSessions
          .getState()
          .sessions.find((x) => x.sessionId === targetSessionId);
        hasImages =
          attachments.length > 0 && agentSupportsImages(fresh?.capabilities);
        // A marker is draft TEXT, so `rawText === ""` alone no longer describes
        // "the user attached a screenshot and typed nothing" — the draft now
        // reads `[image #1]`. Without this, a staged image plus a fresh agent
        // that cannot take images would send the sentence "look at [image #1]"
        // to a model that receives NO image, which is worse than the empty
        // prompt this guard exists to block. So "nothing but markers" counts as
        // no prose: the same fail-closed posture, unchanged for real text.
        if (!hasImages && (rawText === "" || draftIsMarkerOnly(rawText))) return;
      }
      let images:
        | { id: string; name: string; mimeType: string; sizeBytes: number; data: string }[]
        | undefined;
      if (hasImages) {
        try {
          const read = await Promise.all(
            attachments.map(async (att) => ({
              id: att.id,
              name: att.filename,
              mimeType: att.mimeType,
              sizeBytes: att.sizeBytes,
              data: await readAttachmentAsBase64(att),
            })),
          );
          // Reconcile against the LIVE list: the composer isn't locked until
          // beginTurn, so a thumbnail removed during the read must not be sent.
          const liveIds = new Set(attachmentsRef.current.map((a) => a.id));
          images = read.filter((i) => liveIds.has(i.id));
        } catch {
          if (activeSessionIdRef.current === targetSessionId) {
            setError("Failed to read an attached image");
          }
          return; // attachments stay staged; `sendingSessionsRef` resets in `finally`
        }
      }
      // Session switched during the read (the composer isn't locked until
      // beginTurn): the closure's `activeSessionId` is stale — abort without
      // sending, without wiping the draft, without completing a turn.
      if (activeSessionIdRef.current !== targetSessionId) return;
      // Draft edited during the read (the composer isn't locked until
      // `beginTurn`): sending the stale text and wiping the new draft is a
      // silent data loss — abort without sending, without wiping the draft,
      // without completing a turn (the user simply sends again). The guard
      // compares the RAW text (expansion is re-derived from the FRESH draft
      // below, so comparing expanded texts would be wrong).
      if (draftRef.current.trim() !== rawText) return;
      // EXPANSION: expand `$` / `@` / `#` mentions into their block forms
      // BEFORE both `addUserMessage` and `sendPrompt` (the REFINEMENT — the
      // live bubble, the persisted record, and the agent's input must all
      // carry the SAME text, so the content-based dedupe key in
      // `mergeDedupeKey` matches across a resume reload). Declared HERE
      // (immediately after the stale-draft guard, BEFORE the images-empty
      // block below which still references `text`) — the placement is
      // load-bearing (a TDZ trap: a later declaration would make the
      // unchanged `if (!text)` a "used before its declaration" error;
      // semantically it's safe — expansion maps `""`→`""`, so `!text` is
      // identical to `!rawText`).
      // The `#` gate (see the `mcpMentionsEnabled` note above): an EMPTY MCP
      // catalog means a `#` token matches nothing, so the text stays
      // BYTE-IDENTICAL — the existing verbatim path, not a special case.
      //
      // THE MASK, and why it is not cosmetic: `[image #3]` IS a `#` mention
      // token — `MCP_MENTION_RE` is `/(^|\s)#([a-z0-9]+(?:-[a-z0-9]+)*)/g`, the
      // `#` has its leading space and a digit is in the class. It survives today
      // only because no catalog entry happens to be named `3`, and that is not a
      // guarantee: the Rust picker predicate `is_mentionable_name` accepts
      // digits (its own tests use `"0"` as a positive case), so an MCP server
      // literally named `3` would get an `<mcp name="3">` block appended to a
      // prompt the user never asked for. So the markers are lifted out BEFORE
      // the expansion and put back byte-exact AFTER it: `expandMentions` sees no
      // `#` token from a marker at all, and the marker text is stashed rather
      // than re-derived, so the round trip is exact.
      //
      // THE SENTINEL IS PASTABLE, and that is what the collision guard below is
      // for. `\uE000` is a Private Use Area codepoint: no keyboard produces it —
      // TRUE — but a PASTE carries arbitrary codepoints, and pasted logs, data
      // dumps and mojibake are exactly where PUA characters live. So the mask is
      // NOT structurally un-obtainable and the round trip is not automatically a
      // bijection: a draft can arrive at the un-mask holding a sentinel that no
      // marker put there. What makes the design safe is the guard, not the
      // choice of codepoint.
      const marks: string[] = [];
      const masked = rawText.replace(/\[image #(\d+)\]/g, (marker) => {
        marks.push(marker);
        return "\uE000";
      });
      // A PASTED sentinel sitting in a draft that also has a marker: the un-mask
      // cannot tell the user's stray byte from one of our placeholders, so the
      // round trip could hand a marker's text to the wrong position. Such a
      // draft is pathological (nothing the composer produces writes a PUA
      // character), and the two ways out are not equal: sending the user's own
      // text UNEXPANDED costs one send its `<mcp>` / `<skill>` blocks, while
      // continuing would CORRUPT the prompt the model reads. Degrading is the
      // safe side, so that is what this does.
      //
      // A sentinel in a draft with NO marker needs no guard: nothing was masked,
      // so nothing can be mis-restored — the bounded replacer below just lets the
      // user's byte pass through, and expansion runs normally.
      let text: string;
      if (marks.length > 0 && rawText.includes("\uE000")) {
        text = rawText;
      } else {
        const expanded = expandMentions(masked, {
          skills,
          agents,
          mcpServers: mcpMentionsEnabled ? mcpServers : [],
        });
        let markIndex = 0;
        // BOUNDED on purpose, and it is not defensive noise: an unbounded
        // `marks[markIndex++]` returns `undefined` once the stashes run out, and
        // `String.prototype.replace` STRINGIFIES what a replacer returns — so a
        // pasted sentinel would ship the literal word "undefined" to the model in
        // place of the user's character. Returning the sentinel itself keeps the
        // text byte-identical to what the user had.
        text = expanded.replace(
          /\uE000/g,
          () => (markIndex < marks.length ? marks[markIndex++] : "\uE000"),
        );
      }
      // Every staged image was removed during the read (the composer isn't
      // locked until `beginTurn`, so a thumbnail can be removed during the
      // read): with no text there's nothing meaningful left to send; with
      // text, normalize to `undefined` so the 2-arg `sendPrompt` path is taken
      // (an empty `[]` is truthy and would take the 3-arg path, sending an
      // empty images array).
      if (images !== undefined && images.length === 0) {
        if (!text) return;
        images = undefined;
      }
      // `sentIds` is derived from what was ACTUALLY sent (the reconciled
      // `images`), not the stale closure list: on success, release/clear ONLY
      // these. Anything staged after the read — e.g. a drop during the
      // FileReader `await`, or attachments staged in ANOTHER session while
      // this turn was running — must survive.
      const sentIds = new Set(images?.map((i) => i.id) ?? []);
      // `ImageRef` has no `id` field — strip it before use.
      const imageRefs = images?.map(({ id, ...ref }) => ref); // ImageRef[] | undefined
      setDraft("");
      addUserMessage(targetSessionId, text, imageRefs); // EXPANDED
      // The staged `File`/object-URL pair has NO remaining job once the
      // base64 copies are on the user message: hold exactly the sent
      // attachments OUT of `attachments` so their thumbnails leave the
      // composer NOW instead of sitting there for the whole turn. They are
      // held, not released — the `catch` below puts them back on a failed
      // send, and the success path releases them when the turn settles.
      // `activeSessionIdRef` guard: a send whose session was switched away
      // during the read never touches the (now other session's) composer state.
      if (sentIds.size > 0 && activeSessionIdRef.current === targetSessionId) {
        const held = attachmentsRef.current.filter((a) => sentIds.has(a.id));
        heldForSendRef.current.set(targetSessionId, held);
        const staged = attachmentsRef.current.filter((a) => !sentIds.has(a.id));
        attachmentsRef.current = staged;
        setAttachments(staged);
      }
      beginTurn(targetSessionId);
      // Pass the third arg ONLY when there are images: a text-only send (and
      // an all-images-removed send, normalized above) calls
      // `sendPrompt(id, text)` — the pre-existing 2-arg call the existing tests
      // assert (`toHaveBeenCalledWith("s1", "hello")`; vitest compares arg
      // arrays by length, so an explicit `undefined` third arg would break it).
      const stopReason = imageRefs
        ? await sendPrompt(targetSessionId, text, imageRefs) // EXPANDED
        : await sendPrompt(targetSessionId, text); // EXPANDED
      // Success: the turn settled, so the held attachments have no job left —
      // release them for good and drop the map entry. Released from the HELD
      // list (they left `attachments` at send), NOT by re-filtering the staged
      // list by `sentIds`. The state is untouched here: the composer is
      // already clean, so only the `activeSessionIdRef`-guarded map entry has
      // to go (the held objects are released either way — a revoked URL is not
      // session-scoped).
      const held = heldForSendRef.current.get(targetSessionId);
      if (held) {
        held.forEach(releaseAttachment);
        heldForSendRef.current.delete(targetSessionId);
      }
      turnCompleted(targetSessionId, stopReason);
    } catch (err) {
      turnCompleted(targetSessionId, "end_turn");
      // Tauri IPC rejections are strings OR plain objects (`{kind, message}`) —
      // `src/lib/ipcError.ts` is the one renderer for both shapes.
      const msg = describeIpcError(err);
      if (activeSessionIdRef.current === targetSessionId) {
        setError(msg);
      }
      // Attachments deliberately survive a failed send (a re-pasted image is
      // costly, a re-typed draft is not). The thumbnails now leave the
      // composer AT send (see `heldForSendRef`), so this is where they come
      // back: the held list is merged in FRONT of whatever is staged now (the
      // user can stage during a turn), de-duplicated by `id` so a re-staged
      // item is not doubled. The RESTORED ones' object URLs are NOT revoked —
      // that is what makes the restored thumbnail render again (only the
      // overflow the cap forces out below is released).
      //
      // This block MUST stay in the same synchronous block as `setError`
      // above: the existing test waits on the error line, and it only passes
      // because both state updates land in one React 19 batch — an `await`
      // between them lets the test observe the pre-restore DOM (flaky).
      const held = heldForSendRef.current.get(targetSessionId);
      if (held && held.length > 0 && activeSessionIdRef.current === targetSessionId) {
        const live = attachmentsRef.current;
        const ids = new Set(live.map((a) => a.id));
        const fitting = held.filter((a) => !ids.has(a.id));
        // ── The restore respects MAX_CHAT_ATTACHMENTS ──────────────────────
        // The cap is enforced inside `addImageAttachments`, i.e. only at
        // STAGING time, and this path writes `attachments` directly — so
        // without a ceiling here a failed send can rebuild a list the cap
        // would never have admitted (send 8, paste a 9th during the turn,
        // fail: 9 staged). Nothing in the UI catches that, and the NEXT send
        // is then rejected server-side for a state this component built.
        // Dropping the overflow mirrors `addImageAttachments`'s silent cap
        // rejection at staging time: the same limit, the same non-error
        // treatment (the user sees a full strip, not an error line).
        const room = Math.max(0, MAX_CHAT_ATTACHMENTS - live.length);
        const back = fitting.slice(0, room);
        // The overflow's object URL has no owner left once it is dropped — no
        // state holds it, so no remove / session-switch / unmount path can
        // ever revoke it. Release it here or it leaks for the process lifetime.
        fitting.slice(room).forEach(releaseAttachment);
        const merged = [...back, ...live];
        attachmentsRef.current = merged;
        setAttachments(merged);
        // ── The draft's marker numbers move WITH the pictures ──────────────
        // The numbers are POSITIONAL (they count THIS message's attachments in
        // list order), and this restore inserts `back` IN FRONT of everything
        // staged during the turn. Anything staged mid-turn was numbered against
        // the SHORTER list — stage A, send (A held, list empty), paste B and
        // `stageFiles` numbers B `#1` — so after the merge slot 1 is A and the
        // draft's `#1` names the wrong picture: the next prompt asks about a
        // screenshot the user never meant. Shifting by the number ACTUALLY
        // restored (not the number that left the composer — the cap can make
        // those differ) is what keeps the marker→image mapping the whole
        // marker feature exists to guarantee.
        //
        // The live draft (`draftRef`, not the `send()` closure — the composer
        // stays editable across the awaits) is the text being rewritten, and
        // the write lands in this SAME synchronous block for the batching
        // reason above.
        if (back.length > 0) {
          setDraft(shiftImageMarkers(draftRef.current, back.length));
        }
      }
      heldForSendRef.current.delete(targetSessionId);
      // The text the user had typed when they pressed Send is still lost on
      // failure (`setDraft("")` ran at send, pre-existing behaviour): what
      // survives is whatever was typed AFTER that, and the shift above keeps
      // ITS markers honest about the restored list.
    } finally {
      sendingSessionsRef.current.delete(targetSessionId);
    }
  };

  const resume = async (): Promise<boolean> => {
    if (!activeSessionId || resuming) return false;
    setResuming(true);
    setError(null);
    try {
      await resumeSession(activeSessionId);
    } catch (err) {
      setError(describeIpcError(err));
      return false;
    } finally {
      setResuming(false);
    }
    return true;
  };

  // The conversation selector + the session title + the space chip moved
  // out of the header: the Spaces are the TOP TABS (`SpaceTabs` — one
  // tab per space, the active one selected) and the session title lives
  // in the side pane (its top section).

  // The most recent turn (the messages after the last `user` message) and
  // its standalone `diff` messages — the SINGLE SOURCE OF TRUTH for the
  // file summary card: `applySessionUpdate`/`rowToMessages` emit BOTH a
  // `tool-call.diff = diffs[0]` AND standalone `diff` messages for the
  // same extracted diffs, so the `tool-call.diff` refs are deliberately
  // NOT used (summing both would count every file twice).
  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === "user") return i;
    }
    return -1;
  })();
  const turnDiffs =
    lastUserIndex === -1
      ? []
      : messages
          .slice(lastUserIndex + 1)
          .flatMap((m) =>
            m.kind === "diff" ? [{ path: m.path, patch: m.patch }] : [],
          );

    // `hasPendingRequest` (computed ABOVE, next to the other unconditional cue
  // hooks) is what suppresses the hint below. It is the SAME hook the `SidePane`
  // and `SpacesList` toggles read for their `bg-warning` dots — the cue for the
  // COLLAPSED-PANE case, where the pane's content is clipped away by the
  // `SIDE_PANE_RAIL` sliver + `overflow: hidden` and only the toggle's dot is
  // left to say "something needs you" — so the hint and the dots can only ever
  // agree; a hand-rolled copy of the hook's terms in THIS file (what this
  // comment's previous version described) was how they could not.
  // The "Send a prompt to start" hint is hidden when a pending request
  // (permission prompt or interactive `ask`/`confirm`/`password` — the cards
  // render in the stream regardless of the transcript's length) or a
  // working/blocked line is present — otherwise the card would be
  // swallowed by the hint.

  // --- Image-attachment handlers (plain functions, NOT hooks — their
  // placement is flexible; kept with the other handlers). ---
  const stageFiles = (files: File[]) => {
    // Read the CURRENT list from the ref — a render closure would be stale
    // for fast successive events (e.g. pasting 8 files then a 9th in
    // separate dispatches without a re-render in between).
    const stagedBefore = attachmentsRef.current;
    const { attachments: next, rejected } = addImageAttachments(
      stagedBefore,
      files,
    );
    if (next !== stagedBefore) {
      attachmentsRef.current = next;
      setAttachments(next);
      // ── The `[image #N]` markers, for EVERY staging path ────────────────
      // `stageFiles` is the single funnel for all four of them (paste with
      // file items, the WebKitGTK empty-paste clipboard fallback, drag-and-drop
      // and the `+` picker), so one insert here covers all four. Doing it in
      // the callers instead would number a mixed batch `#1, #3` and the number
      // would stop matching the strip.
      // `N` counts the attachments of THIS message (1-based, in staging
      // order) — see `imageMarker` for why a session-wide number would be
      // unresolvable by the model.
      // The count comes from the RETURNED list, never from `files.length`:
      // `addImageAttachments` can reject mid-batch (`continue` on a bad MIME
      // / an oversize file, `break` on the cap), so looping the input would
      // emit a marker for a rejected file and the numbers would then name the
      // wrong picture.
      // ONE string for the WHOLE batch, inserted ONCE (ascending `#k #k+1 …`):
      // inserting one at a time at the same caret would emit `#3 #2 #1` and
      // invert the marker→image mapping on every multi-file paste.
      const markers = next
        .slice(stagedBefore.length)
        .map((_, i) => imageMarker(stagedBefore.length + 1 + i))
        .join(" ");
      // CARET ONLY WHEN THE TEXTAREA ACTUALLY HAS FOCUS. `selectionStart` is
      // `0` for a textarea that has never been focused, and two of these four
      // paths (a drop, and the `+` picker — the native dialog holds focus)
      // routinely run that way, so the naive read would drop every marker at
      // the START of the user's sentence. This is a deliberate divergence from
      // the `selectionStart ?? draft.length` idiom in `handleDrop`'s backstop
      // and `selectMention`, which is safe there only because both are
      // reachable solely after typing (so the field is focused).
      // `draftRef` — not the render closure — for the same reason
      // `attachmentsRef` exists: a 9th paste in a fast sequence would
      // otherwise revert the draft to a stale value and drop the earlier
      // markers.
      const el = composerRef.current;
      const len = draftRef.current.length;
      const caret =
        el && document.activeElement === el ? (el.selectionStart ?? len) : len;
      const inserted = insertAtCaret(draftRef.current, caret, markers);
      setDraft(inserted.text);
      // Restore focus + caret after the controlled `setDraft` (which would
      // otherwise drop both) — the same block `selectMention` uses.
      const pos = inserted.caret;
      requestAnimationFrame(() => {
        const area = composerRef.current;
        if (!area) return;
        area.focus();
        area.setSelectionRange(pos, pos);
      });
    }
    // A successful stage also CLEARS a stale rejection line (null when
    // nothing was rejected) — otherwise a rejection stays visible after the
    // user successfully stages a different image.
    setError(rejected.length > 0 ? rejected.join("; ") : null);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!imageCapable) return; // fall through: default text paste
    // Pasted images live in `clipboardData.items` (a `ClipboardItem` pulled via
    // `getAsFile()`); `clipboardData.files` is EMPTY in real webviews
    // (WebKit/WebKitGTK, WebView2/Chromium), so derive the file list from
    // `items` instead — keep only `kind === "file"` items, drop null results.
    const files: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    const text = e.clipboardData.getData("text/plain");
    const html = e.clipboardData.getData("text/html");
    // A spreadsheet paste carries TSV (or Excel HTML) alongside the
    // synthetic image — the TEXT wins, so the default paste is untouched.
    if (
      files.length > 0 &&
      !shouldPreferSpreadsheetClipboardText(text, html)
    ) {
      e.preventDefault();
      e.stopPropagation();
      stageFiles(files);
      return;
    }
    // WebKitGTK quirk: a pasted image produces a `paste` event with NO file
    // items and NO text (the DataTransfer is empty — verified on
    // webkit2gtk-4.1 2.52.5 on Wayland; the image IS inserted into a
    // contenteditable, just not exposed on the event). When the event has
    // no content at all, the likely cause is a clipboard image WebKit can't
    // surface — read it from the system clipboard (Rust/arboard) instead.
    // A text-only paste is a text paste: `getData("text/plain")` is
    // non-empty, so the fallback is skipped (no stale image staged).
    if (files.length === 0 && !text) {
      // The read can straddle a session switch (it is a slow IPC round
      // trip): capture the active session at PASTE time and abort if it
      // changed — without the guard, `stageFiles` would target the NEW
      // active session (staging session A's pasted image in session B's
      // composer; the same cross-session leak `send()`'s
      // `activeSessionIdRef` guard prevents for sends).
      const pastedInSession = activeSessionIdRef.current;
      void readClipboardImage()
        .then((bytes) => {
          if (!bytes) return; // no image on the clipboard — nothing to stage
          if (activeSessionIdRef.current !== pastedInSession) return; // switched
          const file = new File([new Uint8Array(bytes)], "screenshot.png", {
            type: "image/png",
          });
          stageFiles([file]);
        })
        .catch(() => {
          // Silent: clipboard access failed (or no image) — an empty-clipboard
          // paste is not an error condition.
        });
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    if (composerLocked || !imageCapable) return;
    e.preventDefault();
    stageFiles(Array.from(e.dataTransfer.files));
  };

  // The `+` button (the native file picker): the dialog returns PATHS (a
  // webview `File` is not available for a picked file — no `fs` plugin),
  // so the bytes are read via `read_file_bytes` (the Rust command — the
  // image-extension allowlist + the 10 MiB cap re-validated server-side),
  // rebuilt into `File`s (the MIME inferred from the extension), and
  // staged through the SAME `stageFiles` path as a paste / drop (the
  // capability gate + the attachment caps apply identically).
  const handleAttachClick = async () => {
    if (!composerEnabled || composerLocked || !imageCapable) return;
    let raw: string | string[] | null;
    try {
      raw = await openFileDialog({
        multiple: true,
        // The image allowlist (the SAME set as the backend command — the
        // dialog filters, the command re-validates, `stageFiles` re-validates
        // the MIME a third time).
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "gif", "webp"],
          },
        ],
      });
    } catch {
      return; // the dialog is unavailable (e.g. a non-Tauri context)
    }
    if (raw == null) return; // cancelled
    const paths = Array.isArray(raw) ? raw : [raw];
    const files: File[] = [];
    let readError: string | null = null;
    for (const path of paths) {
      try {
        const bytes = await readFileBytes(path);
        if (!bytes || bytes.length === 0) continue; // not an image (the backend allowlist)
        files.push(
          new File([new Uint8Array(bytes)], basenameOfPath(path), {
            type: inferAttachmentMimeType(path),
          }),
        );
      } catch (e) {
        // A read failure (e.g. the file over the 10 MiB cap — the command
        // rejects): keep the readable selections staged, surface the error
        // only when NOTHING was staged.
        readError = describeIpcError(e);
      }
    }
    if (files.length > 0) {
      stageFiles(files);
    } else if (readError) {
      setError(readError);
    }
  };

  const removeAttachment = (id: string) => {
    // Revoke OUTSIDE the state updater (updaters must be pure — StrictMode
    // runs them twice; a double revoke is harmless but the wrong pattern).
    const target = attachmentsRef.current.find((a) => a.id === id);
    if (target) releaseAttachment(target);
    // The 1-based position IN THE LIST BEING SHOWN, computed BEFORE the
    // filter (after it, the index would be the survivor's). This is the `N`
    // the draft's marker uses, so removing a thumbnail takes its marker with
    // it and shifts every marker above it down — the numbers keep naming the
    // right picture. `draftRef` (not the closure) for the same reason
    // `attachmentsRef` is read here: the composer is not locked, so a
    // same-tick draft edit must not be reverted by this rewrite.
    const position = attachmentsRef.current.findIndex((a) => a.id === id) + 1;
    setDraft(renumberImageMarkers(draftRef.current, position));
    const next = attachmentsRef.current.filter((a) => a.id !== id);
    attachmentsRef.current = next;
    setAttachments(next);
  };

  // Select a row from the `$`/`#`/`@`/`?`-trigger picker: replace the active
  // token (the prefixed span at the caret — the shared `activeMentionToken`
  // helper) with `<prefix><name> ` (LOWER-cased — the Mention case policy: a
  // picker-selected mention ALWAYS expands on send, and the mention regex is
  // lowercase-only; the expansion keeps the catalog name verbatim in the
  // block's `name` attribute). The `requestAnimationFrame`
  // re-focus + caret-set is REQUIRED: `setDraft` re-renders the controlled
  // textarea, which would otherwise drop focus/caret.
  const selectMention = (row: MentionRow) => {
    if (!picker) return;
    const el = composerRef.current;
    const caret = el?.selectionStart ?? draft.length;
    const token = activeMentionToken(draft, caret);
    if (!token) return;
    // The insertion policy splits on the prefix (ADR 0033), and the `?` branch
    // splits once more on whether the row is a DIRECTORY (ADR 0035):
    //
    //  • a `?` FILE row inserts the PATH ALONE — the trigger is CONSUMED (the
    //    splice below already removed it) and the case is PRESERVED (`?REA` →
    //    `README.md`) because the insertion is VERBATIM: no lowercasing rule
    //    applies to a path, so the Mention lowercase-only rule does not apply.
    //    Out of the Space that verbatim path is ABSOLUTE, which is the whole
    //    point — nothing in this app expands a tilde, so the row shows `~/…` and
    //    inserts `/home/u/…` (the row's `name`, not its `label`).
    //  • a `?` DIRECTORY row is NOT an answer, so it keeps the `?` and appends
    //    `/` with NO trailing space. Consuming the sigil there would END the
    //    token and strand the user after one level of descent.
    //  • the three Mention prefixes are untouched: the lowercased token.
    const keepToken = row.prefix === "?" && row.isDir === true;
    const inserted = keepToken
      ? `?${row.name}/`
      : row.prefix === "?"
        ? `${row.name} `
        : `${row.prefix}${row.name.toLowerCase()} `;
    const next = draft.slice(0, token.start) + inserted + draft.slice(caret);
    setDraft(next);
    if (keepToken) {
      // Keep the picker LIVE on the directory just entered. The caret restore in
      // the `requestAnimationFrame` below cannot do this: the picker state is
      // only recomputed by the textarea's own `onChange`/`onKeyDown`, and a
      // programmatic caret set fires neither. So the SAME handler recomputes the
      // token at the NEW caret (`token.start + inserted.length`) — the caret's
      // final position — with the same helper `onChange` uses, so the two can
      // never disagree about what the token is. It runs against `next` (the
      // string just computed), NOT against state, which is why the ORDER of
      // `setDraft`/`setPicker` does not matter here: React 19 batches both into
      // ONE commit, and neither reads the other's value. It is also why no
      // `requestAnimationFrame`/flush is needed to see the reopened picker — the
      // rows for the new directory arrive on their own fetch, and the render gate
      // (`rows || note`) simply shows nothing until they do.
      const pos = token.start + inserted.length;
      const nextToken = activeMentionToken(next, pos);
      setPicker(
        nextToken
          ? { prefix: nextToken.prefix, query: nextToken.remainder, index: 0 }
          : null,
      );
    } else {
      setPicker(null);
    }
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      const pos = token.start + inserted.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // The transcript is grouped ONCE per render (not inside the map): a
  // maximal run of consecutive `write`/`edit` tool calls folds into a
  // single `Changes` card; everything else renders as before.
  const units = groupConsecutiveFileWrites(messages);

  return (
    // THE CENTER COLUMN IS THREE ISLANDS, NOT ONE (the composer used to live
    // INSIDE the `main`). Chrome (`#191a21`) frames each island, and the gap
    // between islands IS the separation: two surfaces of the SAME fill read as
    // distinct when they are SIBLINGS with chrome between them, and read as ONE
    // surface when one is nested in the other. That distinction is why the
    // composer is a sibling here — as a child of a `bg-chat` main it
    // would have had to be a different colour to be visible at all, and as a
    // sibling it wears its own page-plane fill (`#21222c`) while the transcript
    // beside it is `#282a36`, and the two still read as distinct islands.
    // `rounded-xl` + `m-1` match the transcript and the side
    // pane exactly, so the three islands are one visual family.
    //
    // The `min-h-0` on the `main` is still LOAD-BEARING (the classic flexbox
    // `min-height: auto` trap): it is a `flex-1` item of the center column (a
    // `flex-col`) with `overflow: visible`, so its automatic minimum size is the
    // CONTENT's height — without `min-h-0` a long transcript grows the `main`
    // past the column and the inner `overflow-y-auto` div (owned by
    // `MessageList`, NOT the composer) never scrolls. Moving the composer out
    // does not relax this: the transcript is still the tall child.
    <>
      <main className="m-1 flex min-w-0 min-h-0 flex-1 flex-col rounded-xl bg-chat">
      {/* The old header row (session title + space chip + `Live`
          conversation selector + `...` menu + side-pane toggle) is gone:
          the Spaces are the top TABS (`SpaceTabs`, above this component —
          the `...` menu + the toggle live on that row) and the session
          title lives in the side pane (its top section). */}
      {/* The stalled-session banner (a Worker crash — the `session-stalled`
          event set the store's `stalled` entry): above the transcript, below
          the (removed) header. `null` when the session is not stalled. */}
      {activeSessionId && <SessionStalledBanner sessionId={activeSessionId} />}
      <MessageList
        scrollRef={scrollRef}
        units={units}
        messageCount={messages.length}
        activeSessionId={activeSessionId}
        inTurn={inTurn}
        askRequests={askRequests}
        prompts={prompts}
        stackedAskRequests={stackedAskRequests}
        childGates={childGates}
        hasPendingRequest={hasPendingRequest}
        workingOrInTurn={workingOrInTurn}
        agentState={agentState}
        turnDiffs={turnDiffs}
        stopReason={stopReason}
      />

      {error && (
        <p className="mb-2 px-3 text-ui-sm text-destructive">
          {error}
        </p>
      )}
      <WorkingIndicator
        agentState={agentState}
        workingOrInTurn={workingOrInTurn}
        compacting={compacting}
        spinnerStyle={spinnerStyle}
        quip={quip}
      />
      </main>
      {/* The composer island (see the column comment): a SIBLING of the
          transcript, not its child. It stays LAST in DOM order, so tab order
          and the "composer is at the bottom" reading order are unchanged. */}
      <ComposerRow
        composerRef={composerRef}
        draft={draft}
        setDraft={setDraft}
        picker={picker}
        setPicker={setPicker}
        filtered={filtered}
        note={pickerNote}
        activeIndex={activeIndex}
        completionPending={completionPending}
        selectMention={selectMention}
        attachments={attachments}
        removeAttachment={removeAttachment}
        handlePaste={handlePaste}
        handleDrop={handleDrop}
        handleAttachClick={handleAttachClick}
        send={send}
        composerEnabled={composerEnabled}
        composerLocked={composerLocked}
        imageCapable={imageCapable}
        hasImages={hasImages}
      />
      {/* Interactive modals (rendered at the `ChatStream` root — `fixed`
          overlays, NOT inside the scroll region). */}
      <ComposerModals
        activeSessionId={activeSessionId}
        confirmRequests={confirmRequests}
        passwordRequests={passwordRequests}
      />
    </>
  );
}
