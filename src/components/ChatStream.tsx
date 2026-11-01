import {
  useEffect,
  useRef,
  useState,
} from "react";
// The dispatch-path imports (`sendPrompt`, `compactSession`, `type StopReason`,
// `describeIpcError`, `parseComposerCommand`, `expandMentions`,
// `agentSupportsImages`, `draftIsMarkerOnly`, `readAttachmentAsBase64`,
// `releaseAttachment`, `type ImageRef`, `useQueuedPrompts`) moved with their ONLY
// consumers into `hooks/useChatPromptDispatch` / `hooks/usePromptQueueFlusher`
// (issue #135 §2). `cancelSession` stays: the Esc effect below is its consumer.
import { cancelSession } from "../lib/tauri";
import {
  dirPartOfOutsideQuery,
  isOutsideSpaceQuery,
} from "../lib/skills";
import { groupConsecutiveFileWrites } from "../lib/toolGroups";
import { useSessions } from "../store/sessions";
import { usePermissions } from "../store/permissions";
import { useInteractive } from "../store/interactive";
import { useSettings } from "../store/settings";
import { useHasPendingRequest } from "../hooks/useHasPendingRequest";
import { useSessionIdleEdge } from "../hooks/useSessionIdleEdge";
import { useChatSessionDerivations } from "../hooks/useChatSessionDerivations";
import { useChatAttachments } from "../hooks/useChatAttachments";
import { useChatPromptDispatch } from "../hooks/useChatPromptDispatch";
import { usePromptQueueFlusher } from "../hooks/usePromptQueueFlusher";
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

// `SendTextImages` (the reconciled attachment payload `sendText` takes) moved to
// `hooks/useChatPromptDispatch` with `sendText` itself (issue #135 §2) — `grep -rn
// "SendTextImages" src/` showed `ChatStream.tsx` as its only importer, so the move
// breaks nothing, and `usePromptQueueFlusher` now types its `sendText` argument
// with it from there.

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
  // the current turn's diffs, the composer-lock chain (`workingOrInTurn` /
  // `composerLocked`) and the history-pagination slice (`loadOlder` / `hasMore`
  // / `loadingMore` / `generation`). The pure logic lives in
  // `lib/chatSessionDerivations.ts`; this is a HOOK (it reads the stores), so it
  // sits in this UNCONDITIONAL block — a hook below the `!activeSessionId` early
  // return is a conditional hook call and white-screens the app with
  // "Rendered more hooks than during the previous render". `workingOrInTurn` is
  // therefore IN SCOPE for `useSpinQuip` below (the call order the extraction
  // depends on) and `composerLocked` for the two argument sites that take it.
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
    workingOrInTurn,
    composerLocked,
    loadOlder,
    hasMore,
    loadingMore,
    generation,
  } = useChatSessionDerivations();
  // The five store actions the dispatch path used to pull here (`addUserMessage`,
  // `addSystemLine`, `beginTurn`, `turnCompleted`, `resumeSession`) moved with
  // `sendText` / `send` / `flushHead` / `resume` into `useChatPromptDispatch` and
  // `usePromptQueueFlusher` (issue #135 §2) — each hook pulls its own selectors,
  // and `noUnusedLocals` is what proves no consumer was left behind here.

  // The interactive agent state for the active session (both JSX props read
  // it). The `workingOrInTurn` derivation that used to sit under this selector
  // moved to `useChatSessionDerivations` / `lib/chatSessionDerivations.ts`
  // (issue #135 §3 final) — comment and all, including the rule that a STALE
  // `idle`/`working` from the previous turn must not unlock the composer or
  // hide the working indicator, because the store does not reset `agentState`
  // on `turnCompleted` and `inTurn` is the ground truth for an in-flight turn.
  const agentState = useInteractive((s) =>
    activeSessionId ? s.agentState[activeSessionId] : undefined,
  );
  // The active session's in-flight compaction reason (ADR 0045) — the
  // `compaction_update` frame the harness emits around a compaction. The
  // COMPOSER LOCK it feeds moved to the derivation hook (issue #135 §3 final);
  // `compacting` stays selected here because the Esc effect below needs it and
  // `ComposerRow` renders the indicator. An idle compaction (the `/compact`
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
  // The composer lock (`composerLocked`) moved to `useChatSessionDerivations` /
  // `lib/chatSessionDerivations.composerLockDerivations` (issue #135 §3 final) —
  // the whole chain and its load-bearing comment (the one-turn-at-a-time
  // harness, the REJECTED-not-queued prompt, the always-editable TEXTAREA, the
  // `blocked`-without-a-turn term and the compaction term) travel with it. The
  // destructured name above feeds `useSpinQuip`, the `useChatPromptDispatch`
  // argument, `useSessionIdleEdge`'s `busy` and the two `ComposerRow` props.
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
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // The attachment lifecycle (state, refs, handlers and the held-for-send map)
  // moved to `hooks/useChatAttachments` (issue #135 §1). The hook call sits in
  // this UNCONDITIONAL block, before the `!activeSessionId` early return below —
  // the state and effects it replaced all lived here, so a hook called only on
  // the full-frame path would change the hook count when the active session
  // appears/disappears and crash React (the same bug the `useHasPendingRequest`
  // comment above warns about).
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
  // The attachment lifecycle (issue #135 §1): the staged-attachment state, the
  // live `attachmentsRef` mirror, the held-for-send map, the five handlers
  // `ComposerRow` takes, and the unmount cleanup (staged + held object URLs —
  // moved into the hook). Called HERE, in the unconditional block above the
  // `!activeSessionId` early return: the state, refs and effect it replaced all
  // ran on the no-session path too, and a hook below that return is a
  // conditional hook call — "Rendered more hooks than during the previous
  // render", white screen. The draft, its live ref, the error line, the composer
  // ref and the two capability gates are ARGUMENTS: the hook owns none of them
  // (`useMentionPicker`'s "the hook never owns the draft" is the precedent).
  // `stageFiles` is conspicuously ABSENT from this destructure: its only callers
  // were the three staging handlers, and all three moved with it, so the hook is
  // its own only caller now — `noUnusedLocals` is what proves no site was missed.
  const {
    attachments,
    attachmentsRef,
    handlePaste,
    handleDrop,
    handleAttachClick,
    removeAttachment,
    moveOutForSend,
    restoreHeldForSend,
    releaseHeldForSend,
    clearAll,
    clearStaged,
  } = useChatAttachments({
    setDraft,
    setError,
    draftRef,
    activeSessionIdRef,
    composerRef,
    imageCapable,
    composerEnabled,
  });
  // `hasImages`: a staged attachment AND the capability — the last line of
  // the fail-closed defense. Staged attachments are already cleared on
  // session switch (Task 4), but a same-session capability regression must
  // not ship images to an agent that can't take them. With it, an
  // image-ONLY send while `!imageCapable` is blocked (an empty prompt +
  // unsent images is meaningless), while a text-only send simply doesn't
  // attach images.
  // Moved UP into the unconditional block (issue #135 §2) because it is now a
  // `useChatPromptDispatch` argument, and hook arguments must be in scope in the
  // block above the `!activeSessionId` early return. A pure-derivation placement
  // move: the no-session frame renders no `ComposerRow`, so nothing observable
  // changed. It is a `const` HERE — the `let` and its mid-`send` RE-DERIVATION
  // (the FRESH agent's capabilities, not the saved ones, decide whether images
  // ship) moved inside the hook, which re-derives its own local copy.
  const hasImages = attachments.length > 0 && imageCapable;
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
    clearAll();
    // A turn still in flight in the session we just left: its held
    // attachments can never be restored there (this effect already cleared the
    // composer) and can never be restored here, so release them now. `left`
    // can be `null` (no session → session), and nothing is ever held under a
    // `null` key, so the guard is both the type narrowing and the truth.
    if (left !== null) {
      releaseHeldForSend(left);
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

  // The history-pagination slice (`history` / `loadOlder` / `hasMore` /
  // `loadingMore` / `generation`) moved to `useChatSessionDerivations` /
  // `lib/chatSessionDerivations.historyPaginationDerivations` (issue #135 §3
  // final) — the four destructured names above are its output and the store
  // action the `onStartReached` arrow below closes over. The `?? false` / `?? 0`
  // no-session fallbacks moved with it (outside every selector, per the
  // stable-reference rule).

  // ── The **Flush** trigger (part 1 of two — part 2 is the ref assignment
  // inside `usePromptQueueFlusher`) ───────────────────────────────────────────
  // BEFORE the `!activeSessionId` early return: a hook after it is a
  // conditional hook call. `composerLocked` is in scope above, and the Flush's
  // real body now lives in `hooks/usePromptQueueFlusher`, reached through this ref.
  const flushRef = useRef<() => void>(() => {});
  // ── The **Prompt dispatch** (issue #135 §2) ────────────────────────────────
  // `sendText` / `send` / `resume` and the `/compact` interception, moved
  // VERBATIM into `hooks/useChatPromptDispatch`. Called HERE, in the
  // unconditional block above the `!activeSessionId` early return, for the same
  // reason as every other hook in it — a hook below that return is a conditional
  // hook call ("Rendered more hooks than during the previous render", white
  // screen). `sendingSessionsRef` is the ONE double-send **Set** this component
  // declares (its comment is above the declaration) and hands to BOTH hooks: a
  // second `Set` would defeat the guard, because a manual send in flight would
  // not be visible to the **Flush**'s check-and-add. The attachment boundary
  // functions are THREADED from the `useChatAttachments` destructure above — this
  // component re-owns none of the attachment state, and neither does the hook.
  // Source ORDER matters: dispatch first (it produces `sendText`), then the
  // flusher (it consumes `sendText` and takes over `flushRef`), then the edge
  // (it consumes the ref) — the same "declared after `sendText` so it closes over
  // it" order the moved code depended on.
  const { sendText, send } = useChatPromptDispatch({
    setDraft,
    setError,
    draftRef,
    activeSessionIdRef,
    sendingSessionsRef,
    composerLocked,
    isLive,
    canResume,
    hasImages,
    attachments,
    attachmentsRef,
    skills,
    agents,
    mcpServers,
    mcpMentionsEnabled,
    moveOutForSend,
    restoreHeldForSend,
    releaseHeldForSend,
    clearStaged,
  });
  usePromptQueueFlusher({
    flushRef,
    sendText,
    sendingSessionsRef,
    activeSessionIdRef,
    imageCapable,
    setError,
  });
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

  // The image-attachment handlers (`stageFiles`, `handlePaste`, `handleDrop`,
  // `handleAttachClick`, `removeAttachment`) moved to
  // `hooks/useChatAttachments` (issue #135 §1) with the state they close over —
  // they are returned from the hook call in the unconditional block above.

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
