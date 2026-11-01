import {
  useEffect,
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
  type StopReason,
} from "../lib/tauri";
import { basenameOfPath } from "../lib/paths";
import { describeIpcError } from "../lib/ipcError";
import { parseComposerCommand } from "../lib/composerCommands";
import {
  dirPartOfOutsideQuery,
  expandMentions,
  isOutsideSpaceQuery,
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
  type ImageRef,
} from "../lib/chatAttachments";
import { inferAttachmentMimeType, shouldPreferSpreadsheetClipboardText } from "../lib/chatAttachmentMetadata";
import { useSessions } from "../store/sessions";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { usePermissions } from "../store/permissions";
import { useInteractive } from "../store/interactive";
import { useSettings } from "../store/settings";
import { useHasPendingRequest } from "../hooks/useHasPendingRequest";
import { useSessionIdleEdge } from "../hooks/useSessionIdleEdge";
import { useChatSessionDerivations } from "../hooks/useChatSessionDerivations";
import { useActiveSpaceCwd } from "../hooks/useActiveSpaceCwd";
import { useChildGates } from "../hooks/useChildGates";
import { useSpinQuip } from "../hooks/useSpinQuip";
import { useMentionCatalogs, useCompletionDir } from "../hooks/useMentionCatalogs";
import { useMentionPicker, type MentionPickerState } from "../hooks/useMentionPicker";
import { useAutoGrowComposer } from "../hooks/useAutoGrowComposer";
import { useWindowDropBackstop } from "../hooks/useWindowDropBackstop";
import { normalizeVariant } from "../lib/braille-loader";
import SessionStalledBanner from "./SessionStalledBanner";
import MessageList from "./chat/MessageList";
import ComposerRow from "./chat/ComposerRow";
import ComposerModals from "./chat/ComposerModals";
import QueueRows from "./chat/QueueRows";
import { IpcErrorLine } from "./IpcErrorLine";


/** The reconciled attachment payload `sendText` takes (id-bearing, unlike the
 * `ImageRef` that goes on the wire). Exported because Task 5's Flush builds one. */
export type SendTextImages = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  data: string;
}[];

export default function ChatStream() {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  // Selectors must return stable references (no fresh `[]` fallbacks inside
  // the selector) or Zustand re-renders forever.
  const messages =
    useSessions((s) =>
      s.activeSessionId ? s.messages[s.activeSessionId] : undefined,
    ) ?? [];
  const inTurn = useSessions((s) => (s.activeSessionId ? !!s.inTurn[s.activeSessionId] : false));
  const stopReason = useSessions((s) => (s.activeSessionId ? s.stopReasons[s.activeSessionId] : undefined));
  const prompts =
    usePermissions((s) =>
      activeSessionId ? s.prompts[activeSessionId] : undefined,
    ) ?? [];
  // The session-state and capability derivations (issue #135 §3) — the ask /
  // confirm / password split, the anchored-vs-stacked partition, live /
  // history-only / resumable, the composer's send gate, the image capability,
  // and the current turn's diffs. The pure logic lives in
  // `lib/chatSessionDerivations.ts`; this is a HOOK (it reads the stores), so it
  // sits in this UNCONDITIONAL block — a hook below the `!activeSessionId` early
  // return is a conditional hook call and white-screens the app with
  // "Rendered more hooks than during the previous render".
  const {
    askRequests,
    confirmRequests,
    passwordRequests,
    stackedAskRequests,
    isLive,
    canResume,
    composerEnabled,
    turnDiffs,
    imageCapable,
  } = useChatSessionDerivations();
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
  // ONLY signal for the COMPOSER LOCK: an idle compaction (the `/compact`
  // command) emits no `turn_start` / `agent_settled`, so `inTurn` stays false and
  // `agentState` stays idle. (A compaction also leaves a card in the transcript —
  // ADR 0077 — but that is durable history, not a live busy flag: it settles and
  // never unlocks anything.) Indexed on `s.activeSessionId` INSIDE the selector
  // (the outer `activeSessionId` is `string | null`, which TS2538 rejects as an
  // index).
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
  // The empty-session film's setting (`emptyStateAnimation`): `"off"` /
  // `"static"` / `"animated"`, with `null` meaning the app default
  // (`"animated"`) — `EmptyStateFilm` resolves that, so the raw value is what
  // travels. Read HERE rather than inside `MessageList` for the same reason
  // `spinnerStyle` is: the transcript component subscribes to no store, so the
  // film (and the scene chunk behind it) is only ever constructed by a caller
  // that actually asked for it. `?? null` — not `?? "off"`: an unloaded settings
  // document must not be reported as an explicit "the user turned it off".
  const emptyStateAnimation = useSettings(
    (s) => s.settings?.emptyStateAnimation ?? null,
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
  // (`lib/sessionConfig.ts`) inside its own selectors. `isLive` comes from
  // `useChatSessionDerivations` (above) — the composer still needs it for the
  // auto-resume path.

  // Whether the user owes an answer — the ACTIVE session's own prompts/pauses,
  // or ANY child's gate anywhere in the app — and here it drives the "Send a
  // prompt to start" hint's suppression (see `hasPendingRequest` below). It is
  // the SAME hook the chrome bar's pane toggles read for their `bg-warning`
  // dots (`ChromeControls`), so the cue in the transcript and the dots cannot
  // drift (one derivation, many consumers).
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

  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
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
  // Window-level drop backstop + the composer's auto-grow. Both moved out to
  // their own hooks (Phase D / Task D4) — they are the two effects in this
  // component with ZERO coupling to its state: the backstop reads nothing at
  // all, and auto-grow reads only `composerRef` and `draft`, which stay owned
  // here. Both are hooks, so both stay in this unconditional top block, ABOVE
  // the `!activeSessionId` early return (see the hook-count note below).
  useWindowDropBackstop();
  useAutoGrowComposer(composerRef, draft);

  // --- The four-prefix picker (`$` skills / `#` MCP servers / `@` agents —
  // the three Mentions — plus `?` File completion, ADR 0033) + the send-path
  // expansion (which the `?` prefix never enters). ---
  // ALL of the hooks below live in the UNCONDITIONAL top block (before the
  // `!activeSessionId` early return further down) — placing any of them after
  // the early return would change the hook count across the session/no-session
  // transition and crash React (the same bug the `useHasPendingRequest`
  // comment above warns about). `useMentionPicker` is ONE such call and holds
  // every hook of the picker's (the rows memo, the insert-skill effect), so the
  // rule applies to its INSIDES too — nothing inside it may be conditioned on a
  // session. Plain (non-hook) functions like the attachment handlers are
  // placement-flexible and live with the other handlers below.
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
  // Declared HERE rather than inside `useMentionPicker` below, and the reason is
  // a CYCLE with only one honest way out: `dirPrefix` — the completion catalog's
  // CACHE KEY — is a pure function of `picker`, the completion payload is a
  // function of `dirPrefix`, and the rows memo is a function of the payload. If
  // the `useState` lived in the hook, the caller would need a value the hook
  // returns in order to build an argument the hook takes. The alternatives are
  // worse: reading the payload through a ref inside the memo would hide it from
  // the dep graph (and `completion` in those deps is mutation-checked — dropping
  // it reddens the two descent-goes-live tests), and moving `dirPrefix` into the
  // hook is the pin `ChatStream.test.tsx` forbids at component level. So the
  // cell is declared here, passed in, and handed back out — the same shape as
  // `draft`/`setDraft`, and still exactly ONE state cell.
  const [picker, setPicker] = useState<MentionPickerState | null>(null);
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
  // `.dir` DESTRUCTURES with a name: it is the payload (the module-level empty
  // constant while empty) and it is the rows memo's dep inside
  // `useMentionPicker`, so it keeps the identity that memo is graded on.
  // `.pending` is the in-flight DESCENT signal — see `useCompletionDir` for the
  // contract and `ComposerRow` for the one key it holds. It stays HERE (with the
  // fetch) rather than being threaded back out of the picker hook: it belongs to
  // this call, and the picker hook never sees it.
  const { dir: completion, pending: completionPending } =
    useCompletionDir(dirPrefix);
  // --- The picker's derivation half, in `useMentionPicker` -----------------
  // The rows memo (four prefixes, three filters, the `?` render cap and its
  // notes), the stale-token guard, the derived `activeIndex`, the
  // `archimedes:insert-skill` listener and `selectMention` — moved VERBATIM
  // (Phase D / Task D4). What the arguments are, is exactly what the moved code
  // read: the four catalogs + the completion payload + the `#` gate, and the
  // three composer cells it may write (`draft` via the caller's setter, the
  // picker cell, the textarea through the ref). `draft` and the picker cell are
  // passed IN rather than owned here for the reasons recorded at their
  // declarations above. The `?` row filter's `segment` (the non-directory tail
  // of the remainder) is re-derived inside the hook — three lines, a pure
  // function of `picker` — because it is a ROW concern, while `dirPrefix` above
  // is a CACHE-KEY concern and stays here where its pin can see it.
  const { filtered, note: pickerNote, activeIndex, selectMention } =
    useMentionPicker({
      draft,
      setDraft,
      draftRef,
      composerRef,
      picker,
      setPicker,
      skills,
      agents,
      mcpServers,
      files,
      completion,
      mcpMentionsEnabled,
    });

  // The live / history-only / resumable derivations and the composer's send gate
  // moved to `useChatSessionDerivations` (issue #135 §3) — `isLive`, `canResume`
  // and `composerEnabled` are destructured from it in the unconditional block
  // above. `isHistoryOnly` had no consumer left in this component.

  const history = useSessions((s) => activeSessionId ? s.history[activeSessionId] : undefined);
  const loadOlder = useSessions((s) => s.loadOlderHistory);
  const hasMore = history?.hasMore ?? false;
  const loadingMore = history?.loadingMore ?? false;
  const generation = history?.generation ?? 0;

  // ── The **Flush** trigger (part 1 of two — part 2 is the ref assignment below
  // `flushHead`) ──────────────────────────────────────────────────────────────
  // BEFORE the `!activeSessionId` early return: a hook after it is a
  // conditional hook call. `composerLocked` is in scope above, and the Flush's
  // real body lives below next to `sendText`, reached through this ref.
  const flushRef = useRef<() => void>(() => {});
  // `key` is the identity `composerLocked` describes: `composerLocked` is
  // derived from the ACTIVE Session's `inTurn` / `agentState` / `compacting`, so
  // a tab switch can move it `true → false` in one render, and without the key
  // the hook would read that as a fall and **Flush** the ARRIVED-AT Session's
  // head — from `activeSessionIdRef.current`, already re-synced, with no user
  // gesture, and against the new Session's not-yet-resolved **Space** catalogs.
  // `""` for the no-session frame: stable, and idle-on-both-sides can never be a
  // fall either.
  useSessionIdleEdge({
    busy: composerLocked,
    key: activeSessionId ?? "",
    onIdle: () => flushRef.current(),
  });

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

  /** The shared send tail: expand → normalise → the user row → beginTurn →
   * sendPrompt. `rawText` is the RAW draft and `images` is the CALLER's already
   * reconciled attachment list (id-bearing); the caller owns composer STATE, so
   * this never calls `setDraft` / `setAttachments` and never calls `turnCompleted`.
   *
   * `onCommitted(sentIds)` fires immediately BEFORE `addUserMessage` — that is
   * where `send()`'s `setDraft("")` and its held-attachment move sit today, and
   * `sentIds` is what the move filters on.
   *
   * Resolves `null` for "NOTHING was dispatched — bail silently, do NOT settle":
   * it can only come from the every-attachment-removed-with-no-text arm below,
   * which runs BEFORE `addUserMessage`, so on that path no user row exists,
   * `onCommitted` never fired, `beginTurn` never ran and there is no turn to
   * settle. `null` therefore means the caller's draft was NEVER wiped — which is
   * exactly what today's `return` at `:1074` guarantees, and the reason the draft
   * wipe had to move inside this function. */
  const sendText = async (
    sessionId: string,
    rawText: string,
    images: SendTextImages | undefined,
    onCommitted: (sentIds: Set<string>) => void,
  ): Promise<StopReason | null> => {
    // EXPANSION: expand `$` / `@` / `#` mentions into their block forms
    // BEFORE both `addUserMessage` and `sendPrompt` (the REFINEMENT — the
    // live bubble, the persisted record, and the agent's input must all
    // carry the SAME text, so the content-based dedupe key in
    // `mergeDedupeKey` matches across a resume reload). Declared HERE
    // (immediately after the caller's stale-draft guard, BEFORE the images-empty
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
      // THE ONLY ROUTE TO `null` — and it is narrower than it looks. Simply
      // removing a thumbnail during the read does NOT reach it: `removeAttachment`
      // renumbers the draft, which drops the `[image #N]` marker text, so the
      // CALLER's stale-draft guard (`draftRef.current.trim() !== rawText`)
      // aborts first — `ChatStream.test.tsx:2368-2377` documents exactly that
      // (its own comment: "the STALE-DRAFT GUARD ... fires before the
      // images-empty block below, which no longer sees an empty text to
      // reject"). To land here a send must arrive with the reconcile yielding
      // `images === []` AND `text === ""`: stage attachments, delete the
      // `[image #N]` marker text BY HAND so the draft is already empty when the
      // read lands (the stale-draft guard then passes, because empty == empty),
      // and remove every thumbnail during the `FileReader` await.
      //
      // Returning `null` here — and NOT calling `onCommitted` first — is what
      // keeps the user's draft intact: nothing was dispatched, no user row
      // exists, `beginTurn` never ran, so there is no turn to settle and the
      // composer must not be wiped.
      if (!text) return null;
      images = undefined;
    }
    // `sentIds` is derived from what was ACTUALLY sent (the reconciled
    // `images`), not the stale closure list: on success, release/clear ONLY
    // these. Anything staged after the read — e.g. a drop during the
    // FileReader `await`, or attachments staged in ANOTHER session while
    // this turn was running — must survive.
    const sentIds = new Set(images?.map((i) => i.id) ?? []);
    // `ImageRef` has no `id` field — built field-by-field rather than by
    // discarding `id` in a destructure, because `noUnusedLocals` is ON and an
    // underscore does NOT exempt a destructured binding from being "unused".
    const imageRefs: ImageRef[] | undefined = images?.map((i) => ({
      name: i.name,
      mimeType: i.mimeType,
      sizeBytes: i.sizeBytes,
      data: i.data,
    }));
    onCommitted(sentIds);
    addUserMessage(sessionId, text, imageRefs); // EXPANDED
    beginTurn(sessionId);
    // Pass the third arg ONLY when there are images: a text-only send (and
    // an all-images-removed send, normalized above) calls
    // `sendPrompt(id, text)` — the pre-existing 2-arg call the existing tests
    // assert (`toHaveBeenCalledWith("s1", "hello")`; vitest compares arg
    // arrays by length, so an explicit `undefined` third arg would break it).
    const stopReason = imageRefs
      ? await sendPrompt(sessionId, text, imageRefs) // EXPANDED
      : await sendPrompt(sessionId, text); // EXPANDED
    // NOTE: no `turnCompleted` here. The success path releases `heldForSendRef`
    // BEFORE settling and the `catch` settles BEFORE `setError` + the
    // attachment restore (one React 19 batch), so moving the settle in here
    // would invert both orders — each caller owns its own settle.
    return stopReason;
  };

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
    //
    // SPLIT (ADR 0069): the emptiness check and the LOCK check are no longer one
    // condition. Empty stays a silent no-op — there is nothing to queue — but a
    // non-empty draft while the composer is locked now has somewhere to go: the
    // **Prompt queue**. The lock itself is unchanged (`composerLocked`, and
    // `ComposerRow`'s `disabled` props): the harness is still one-turn-at-a-time
    // and a queued prompt is NEVER dispatched here — the **Flush** sends it later
    // as an ordinary `send_prompt`.
    if (!hasImages && (rawText === "" || draftIsMarkerOnly(rawText))) return;
    // ── The fork. It sits BEFORE `sendingSessionsRef` and before the `try`, so a
    // queueing press never occupies the double-send slot (and, because it returns
    // ahead of the `try`, it must not rely on the `finally` for cleanup — and it
    // needs none: `setDraft`/`setAttachments` are its only effects).
    if (composerLocked) {
      // A **Composer command** is NEVER queued, and the two contracts are why:
      // ADR 0044's defining act is that `/compact` is CONSUMED (nothing sent, no
      // user row), while a queue entry's whole contract is "becomes an ordinary
      // `send_prompt`". Queuing it would deliver the literal text `/compact` to
      // the model. It gets a VISIBLE line instead of today's dead key — and the
      // draft is left alone, so the same Enter works once the turn ends.
      const command = parseComposerCommand(rawText);
      if (command) {
        addSystemLine(
          targetSessionId,
          `/${command.name} runs when this turn ends — try again then.`,
        );
        return;
      }
      // The URLs MOVE with the text: never revoke here, or the queue row's
      // preview and the later send both lose the file. The `[image #N]` markers
      // travel UNTOUCHED for the same reason-in-reverse: the numbering is
      // per-message, message-ness is preserved by the move, so there is nothing
      // to renumber. Nor is the text expanded — ADR 0069 stores the RAW draft so
      // expansion runs at send, against the catalog of THAT moment.
      const moved = attachmentsRef.current;
      attachmentsRef.current = [];
      setAttachments([]);
      useQueuedPrompts.getState().enqueue(targetSessionId, {
        id: crypto.randomUUID(),
        text: rawText,
        attachments: moved,
        state: "queued",
      });
      setDraft("");
      return;
    }
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
      let images: SendTextImages | undefined;
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
      // The send tail — expansion, the images-empty normalisation, the user
      // row, `beginTurn`, `sendPrompt` — now lives in `sendText` so the prompt
      // queue's Flush runs the SAME code a typed prompt does (a queued Mention
      // must never expand differently from a typed one). `images` is passed
      // RECONCILED (the `liveIds` filter above already ran) because `sendText`
      // derives `sentIds` from what is actually going on the wire.
      //
      // `onCommitted` is where `setDraft("")` and the held-attachment move used
      // to sit, merged into ONE callback: today the held block ran three
      // statements after `setDraft("")` with **no `await` between them**, and
      // both are synchronous ref/state writes that React 19 batches into the
      // same commit — so firing them together at `setDraft`'s old position is
      // observationally identical, not a reordering a user or a test can see.
      const stopReason = await sendText(
        targetSessionId,
        rawText,
        images,
        (sentIds) => {
          setDraft("");
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
        },
      );
      // NOTHING was dispatched (every attachment removed with no text): bail
      // silently, do NOT settle — no user row exists and `beginTurn` never ran.
      // This `return` sits AFTER the `sendText` await and so still runs the
      // `finally` below, releasing the double-send slot — exactly what today's
      // in-line `return` did.
      if (stopReason === null) return;
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

  // ── The **Flush** (ADR 0069) ───────────────────────────────────────────────
  // Sends the queue's head as an ordinary prompt. Declared AFTER `sendText` so
  // it closes over it — and a plain `const`, NOT a hook or a `useCallback`: this
  // is a fresh closure every render, which is exactly what makes the values it
  // reads (`imageCapable`, the store actions, `sendText`) current. It is reached
  // only through `flushRef` above, which the idle edge calls.
  const flushHead = async () => {
    // VISIBLE **Session** only, and that is a correctness rule rather than a
    // scope choice: `sendText` expands **Mentions** through catalogs keyed on
    // the ACTIVE **Session**'s Space (`spacePath`), so a background **Session**'s
    // prompt would expand against the WRONG **Space**.
    const sessionId = activeSessionIdRef.current;
    // `sendingSessionsRef` is the same double-send slot `send()` uses: a manual
    // send already in flight owns this session, and a **Flush** must not race it
    // into a second `send_prompt` (the harness's `pending_turn` claim is atomic
    // and refuses the loser).
    if (!sessionId || sendingSessionsRef.current.has(sessionId)) return;
    const entry = useQueuedPrompts.getState().takeHead(sessionId);
    // `undefined` covers an empty queue AND a queue whose every live entry is
    // `failed` or under edit — `takeHead` skips those rather than blocking the
    // entries behind them, so an all-skipped list simply has nothing to send.
    if (!entry) return;
    sendingSessionsRef.current.add(sessionId);
    // Did this Flush reach the send tail at all? `sendText` is the only thing
    // here that calls `beginTurn`, so the flag is set immediately before that ONE
    // call — the last point before a turn can be opened. The catch needs it
    // because it is SHARED by two very different failures: a rejection from
    // `sendText` left a live turn that must be settled, while a `FileReader`
    // failure during the attachment read happened BEFORE any turn was opened —
    // settling that one would overwrite the previous turn's stop reason and hide
    // the footer's "Turn ended: …" line, for a prompt that never went anywhere.
    // `send()` handles the same asymmetry by `return`ing from its read arm
    // before its catch can see it; this body has one `try`, so the flag carries
    // the distinction instead.
    let dispatched = false;
    try {
      // Fail-closed on capability exactly as `send()` does. `imageCapable` is
      // the render-derived value and `flushHead` is a fresh closure every
      // render, so it is current — `send()`'s post-resume re-derivation exists
      // only because a resume can happen MID-send, and the Flush never resumes
      // anything (a **Queue** entry only ever exists on a session you could
      // already send to).
      const images: SendTextImages | undefined =
        entry.attachments.length > 0 && imageCapable
          ? await Promise.all(
              entry.attachments.map(async (att) => ({
                id: att.id,
                name: att.filename,
                mimeType: att.mimeType,
                sizeBytes: att.sizeBytes,
                data: await readAttachmentAsBase64(att),
              })),
            )
          : undefined;
      // The Flush has NO composer, so `onCommitted` — the hook where `send()`
      // wipes the draft and moves the held thumbnails out of the strip — is an
      // empty function: the entry's text and attachments already left the
      // composer when it was queued. It stays a REQUIRED argument (making it
      // optional would add a branch to `sendText` for a caller that has nothing
      // to commit).
      //
      // Set IMMEDIATELY before the call: everything above this line can fail
      // without a turn having been opened, everything below it failed after one
      // was. See the flag's comment.
      dispatched = true;
      const stopReason = await sendText(sessionId, entry.text, images, () => {});
      // UNREACHABLE from this caller and deliberately UNTESTED: `sendText` only
      // returns `null` from its images-empty-with-no-text arm, which needs
      // `images === []`, and this caller passes `undefined` or a NON-EMPTY array.
      // Keep it — it is what makes the `StopReason | null` union exhaustive for
      // `turnCompleted` below — but read it as a type branch, not as covered
      // behaviour.
      if (stopReason === null) return;
      // The dispatch path owns these URLs: Task 1's `forget` refuses to release
      // a "sent" entry precisely because the sender does. Nothing after this
      // point can put them back in a row.
      //
      // AFTER the `null` guard, which is where the OWNERSHIP rule reads the way
      // it actually holds: these URLs are released when a send HAPPENED, not
      // merely when `sendText` came back. `null` means nothing was dispatched, so
      // on that arm the entry's previews would have been revoked while its row
      // was requeued by the failure paths — reachable only if a caller ever
      // passes `images === []`, which this one does not (see the guard above), but
      // the order must not state the rule backwards.
      entry.attachments.forEach(releaseAttachment);
      turnCompleted(sessionId, stopReason);
    } catch (err) {
      // ONLY settle a turn that was opened. A `sendText` rejection came after
      // `beginTurn`, so the bookkeeping has to be closed here exactly as
      // `send()`'s `catch` does; a `FileReader` failure came BEFORE it, and
      // settling THAT would overwrite the previous turn's stop reason and erase
      // the footer's "Turn ended: …" line for a prompt that never shipped. See
      // the `dispatched` flag's comment for why one shared catch needs the flag.
      // Settle FIRST, then requeue: both are synchronous and the hook's edge
      // cannot run until React re-renders, so `takeHead` sees the entry already
      // marked `failed` — but the ordering is what makes that reasoning
      // one-line obvious at the point where the self-inflicted edge is produced.
      if (dispatched) turnCompleted(sessionId, "end_turn");
      // Restore the head AND mark it failed. `leaving` clears so its row stops
      // animating out, its object URLs were never revoked so the preview is
      // still valid, and `failed` is what stops the idle edge `turnCompleted`
      // just caused from re-sending it (and on the undispatched arm there was no
      // edge at all — the entry stays put either way, which is the point: the
      // prompt must remain VISIBLE whatever failed).
      //
      // WHY A MARKER AND NOT A "FLUSH IN PROGRESS" REF: that edge fires AFTER
      // this function's `finally` has cleared any such ref, so the guard would
      // already have lapsed by the time the hook read it — the retry loop would
      // survive the fix. `failed` is durable state instead of a timing window,
      // and it buys the right user behaviour for free: the prompt stays visibly
      // queued and becomes sendable again only when the user saves an edit of it
      // (`updateText` clears the flag). One consequence worth knowing: the edge
      // a failure causes moves on to the NEXT non-failed entry, so one broken
      // prompt never stalls the ones queued behind it.
      useQueuedPrompts.getState().requeueHead(sessionId, { ...entry, leaving: undefined, failed: true });
      if (activeSessionIdRef.current === sessionId) setError(describeIpcError(err));
    } finally {
      sendingSessionsRef.current.delete(sessionId);
    }
  };

  // Part 2 of the trigger: a plain assignment (NOT a hook — the hook already ran
  // above the early return), the same render-phase ref mirror this file uses for
  // `attachmentsRef`, `activeSessionIdRef` and `draftRef`. A discarded concurrent
  // render can leave ITS closure in the ref and the next render re-assigns it —
  // harmless here (`flushHead` re-reads every value from the stores and the refs
  // when it runs) and worth saying, because it is the one thing a reader of a
  // render-phase write worries about.
  flushRef.current = () => {
    void flushHead();
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

  // The current turn's standalone `diff` messages (`turnDiffs`) moved to
  // `useChatSessionDerivations` / `lib/chatSessionDerivations.ts` (issue #135
  // §3), comment and all — including the rule that a `tool-call`'s own `diff`
  // ref is deliberately NOT summed with the standalone `diff` messages.

    // `hasPendingRequest` (computed ABOVE, next to the other unconditional cue
  // hooks) is what suppresses the hint below. It is the SAME hook the chrome
  // bar's pane toggles read for their `bg-warning` dots (`ChromeControls`) —
  // the cue for the COLLAPSED-PANE case, where a pane's content is clipped
  // away by the `SIDE_PANE_RAIL` sliver + `overflow: hidden` and only the
  // toggle's dot is left to say "something needs you" — so the hint and the
  // dots can only ever agree; a hand-rolled copy of the hook's terms in THIS
  // file (what this comment's previous version described) was how they could
  // not.
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

  // Staging attachments is allowed DURING A TURN on all three paths — paste,
  // drop and the `+` picker. The turn (`composerLocked`) is not a capability
  // check, and the three routes used to disagree about it: paste staged mid-turn
  // while drop and the picker refused, so a screenshot pasted mid-turn and a
  // prompt queued with Enter left the image stranded in the composer while the
  // words travelled to the queue row. `imageCapable` is the gate here and it is
  // fail-closed — an agent that does not advertise `promptCapabilities.image`
  // still takes no image on ANY route.
  // The invariant this keeps: a locked composer STAGES, it does not DISPATCH.
  // Enter while locked reaches `send()`, which moves the whole staged set (with
  // its object URLs) into the queue entry alongside the text — so a dropped file
  // never waits in the composer for the turn to end.
  const handleDrop = (e: React.DragEvent) => {
    if (!imageCapable) return;
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
  //
  // NO `composerLocked` term, on purpose: the picker stages, it does not
  // dispatch — see `handleDrop`'s comment for the invariant (staging is allowed
  // during a turn on all three paths; a locked Enter moves the staged set into
  // the queue row). `composerEnabled` DOES stay: a session that cannot be sent
  // to must not accumulate images.
  const handleAttachClick = async () => {
    if (!composerEnabled || !imageCapable) return;
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

  // `selectMention` moved to `hooks/useMentionPicker.ts` (Task D4) — it is part
  // of the picker's derivation half (it writes the picker cell) and is returned
  // from the hook call above.

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
        hasMore={hasMore}
        loadingMore={loadingMore}
        generation={generation}
        emptyStateAnimation={emptyStateAnimation}
        onStartReached={() => {
          if (activeSessionId) void loadOlder(activeSessionId);
        }}
      />

      {error && <IpcErrorLine error={error} className="mb-2 px-3" />}
      </main>
      {/* The **Prompt queue** stack: the THIRD island of the center column
          (transcript above, composer below). `QueueRows` is `null` while nothing
          is queued, so this costs nothing in the common case; when it renders it
          is a `shrink-0` SIBLING in normal flow, so `main`'s load-bearing
          `min-h-0` is untouched and a row can never float over a **Gate** card or
          the streaming answer. */}
      <QueueRows sessionId={activeSessionId} />
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
        agentState={agentState}
        workingOrInTurn={workingOrInTurn}
        compacting={compacting}
        spinnerStyle={spinnerStyle}
        quip={quip}
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
