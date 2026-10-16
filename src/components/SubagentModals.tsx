import { useSubagents } from "../store/subagents";
import { useSubagentSelection } from "../store/subagentSelection";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSessions } from "../store/sessions";
import {
  childGateKey,
  childGatesOf,
  isInlineChildGate,
} from "../hooks/useChildGates";
import {
  GATE_PANEL_DODGE_MAX_WIDTH_CLASS,
  GATE_PANEL_DODGE_OFFSET_CLASS,
  SHEET_WIDTH_CLASS,
} from "../lib/subagentSheetLayout";
import SudoConfirmModal from "./SudoConfirmModal";
import SudoPasswordModal from "./SudoPasswordModal";
import AskQuestionCard from "./AskQuestionCard";
import PermissionPrompt from "./PermissionPrompt";

/**
 * The overlay's half of the ONE-SITE-PER-GATE partition. A Subagent session's
 * gate is answerable in exactly one place, and the key is **is this gate's
 * parent the ACTIVE session**:
 *
 * - `ask` / Permission prompt of a child whose parent IS active → rendered
 *   INLINE at the bottom of that parent's transcript (`MessageList`, fed by
 *   `useChildGates(activeSessionId)` in `ChatStream`). That is the conversation
 *   the user is already reading, so answering there is the point of the
 *   feature. This component renders NEITHER of those two kinds in that case —
 *   a second live copy would mean divergent typed-but-unsubmitted `ask` drafts
 *   and an Esc that closes only one. The MIRROR of that cost is accepted: a
 *   `Subagent session` has no transcript of its own, so navigating away from
 *   the active parent moves its child's `ask` to a DIFFERENT component
 *   instance (`AskQuestionCard` keeps its drafts in component state), and a
 *   typed-but-unsubmitted draft is lost with the old instance. One site per
 *   gate is worth more than a draft that survives a navigation.
 * - `ask` / Permission prompt of a child whose parent is NOT active → HERE.
 *   `ChatStream` renders only `activeSessionId`, so a child of a Session you
 *   navigated away from has no transcript to render into, and an unrendered
 *   gate strands that child. Since ADR 0055 it strands it INDEFINITELY: a child
 *   parked on a gate holds its `tool_call_id` open, so it is an **Active
 *   Subagent** and NO clock bounds it — the drive's bound is a silence bound
 *   that does not run at all while a tool call is outstanding
 *   (`DEFAULT_SUBAGENT_DEAD_BOUND`, `src-tauri/src/agent/worker/manager.rs`).
 *   That is the deliberate trade: a forgotten question is no longer silently
 *   killed off as a child failure after 30 minutes; the escape hatches are
 *   leaving Settings (the gate becomes renderable and answerable) or Stop.
 * - `confirm` / `password` of EVERY child, active parent or not → HERE, always.
 *   `SudoConfirmModal`/`SudoPasswordModal` are Radix `Dialog`s; a modal
 *   `Dialog` inlined into a scrolling transcript is not on the menu, so these
 *   two kinds never move regardless of who is active. The two cards and the two
 *   `Dialog`s also differ in FOCUS, which is not an oversight: an `ask` card here
 *   passes `autoFocus={false}` so a gate that appears while the user is typing
 *   never takes the caret, whereas a sudo `Dialog` DOES take focus on open
 *   (Radix's default `onOpenAutoFocus`, and `SudoPasswordModal` focuses its own
 *   input) — pre-existing, and the right behaviour for a modal. So "a child gate
 *   never steals focus from what you are typing" is a rule about the `ask` /
 *   Permission cards, not about every gate this host can render.
 *
 * The three rules above are the WHOLE render contract: together they cover
 * every gate exactly once, so a gate is never answerable twice and never
 * rendered NOWHERE — where the workspace view is mounted. The one accepted
 * exception is named below: the Settings view while the gate's parent IS the
 * active session renders that gate nowhere, and `App.test.tsx`'s known-hole pin
 * says so. (`activeSessionId === null` matches no `parentSessionId`,
 * which is why the no-active-session case falls to the overlay rather than
 * dropping everything — `useChildGates(null)` is `[]` by design.) The card half
 * is not restated here as a kind list: it is `isInlineChildGate` minus the
 * active parent, i.e. literally the transcript's half for a parent whose
 * transcript is not on screen, so the two sites cannot drift as the kinds change
 * (`SubagentModals.renderSite.test.tsx` pins that this component ASKS the
 * predicate rather than re-deciding).
 *
 * One CROSS-LAYER assumption holds that contract up, and nothing in this file
 * enforces it: a `Subagent session` id is never the ACTIVE session. The filters
 * below key on `parentSessionId`, never on the CHILD, so if a child id ever did
 * become active, its `ask` would render BOTH as the active session's own card
 * (`ChatStream` → `MessageList`) and here — the double-render the ONE-SITE-PER-
 * GATE rule forbids.
 * It holds only because the Rust side filters `is_subagent = 0` out of every
 * session LIST — both branches of `list_sessions`
 * (`src-tauri/src/storage/db.rs`)
 * — so a child row never reaches
 * `sessions` / `historySessions` / `archivedSessions`. Every write of
 * `activeSessionId` (`store/sessions.ts`) takes its id from one of those lists —
 * `setSpaces`' auto-select, `selectSpace`, `openSession` — or from a
 * `startSession` / `resumeSession` return, which only ever names a MAIN session
 * (`deleteSession` clears the field to `null`). That is a contract between this
 * component and that SQL, not an
 * accident: drop the `is_subagent` filter on the Rust side and this host renders
 * a child's gate twice.
 *
 * The name says "Modals" but it also hosts the two inline cards above.
 * Renaming would churn the import and the test file for
 * zero behaviour, so the name stays and this paragraph is the correction.
 *
 * Mounted at the `App` root, as a SIBLING of the whole
 * `view === "settings" ? … : …` ternary — NOT inside `SidePane` or
 * `SubagentDetailHost`, both of which live in that ternary's else-branch and
 * therefore render NOTHING while Settings is open. (A MAIN session's `ask` has
 * that same settings-view hole — `ChatStream` is inside the ternary too, and so
 * is an ACTIVE parent's child `ask`/permission, which now rides `ChatStream`.
 * So opening Settings WHILE a child's parent is the active session leaves that
 * one gate unrendered: the transcript is unmounted and this host stands down
 * for it. Accepted, and NOT a new class of bug — it is the pre-existing
 * main-session hole, reachable by the same two clicks and escaped the same
 * way: leave Settings. Nothing closes the gate in the meantime, and since
 * ADR 0055 NOTHING times it out either: a child parked on a gate holds its
 * `tool_call_id` open, so it is an **Active Subagent** and the drive's
 * `DEFAULT_SUBAGENT_DEAD_BOUND` (`src-tauri/src/agent/worker/manager.rs`) does
 * not run at all while a tool call is outstanding. The hole is therefore
 * unbounded in time and is closed from the other side instead — at teardown
 * `finish_subagent` emits `interactive-request-close` under the CHILD id for
 * every unanswered gate, and `App.tsx`'s one close listener clears BOTH the
 * interactive and the permission stores. Closing it in the meantime still
 * means
 * either moving the chat column out of the ternary or making this host
 * conditionally re-adopt the active parent's cards while the workspace is
 * unmounted, and this component must not be asked to host the ACTIVE
 * session's own cards either way (that is the other half of the render-site
 * partition). `App.test.tsx` pins the hole so a fix deletes this paragraph
 * with it.)
 *
 * Every gate comes from the pure `childGatesOf(entries, requests, prompts,
 * null)` — `null` means EVERY child, because the sudo `Dialog`s must cover
 * every parent and the card half only filters afterwards by parent.
 * `useChildGates(activeSessionId)` is deliberately NOT used: it would drop the
 * children of a non-active parent, which is exactly what this host exists for.
 *
 * GEOMETRY, in one place. The card region is a `fixed` bottom-right panel, and
 * the Subagent transcript SHEET (`SubagentDetailHost`) is a `fixed` right-side
 * panel of the same width, so a corner panel is 100% covered while a sheet is
 * open — hence the dodge to the sheet's left edge, gated on a min-width variant
 * so it only applies when the leftover room is wide enough for a real card
 * (`src/lib/subagentSheetLayout.ts` holds the arithmetic, and the body's
 * geometry comment has the reasoning). Two consequences worth stating because
 * they are what makes the geometry cheap to live with. The region is
 * `pointer-events-none` with `pointer-events-auto` on each card, so it is
 * CLICK-TRANSPARENT outside its cards and an overlap steals nothing — the same
 * PRINCIPLE the rails work to (a readout must not steal the footer toggle's
 * click, which is what the per-block `pointer-events-none` on `TodoRail`'s strip
 * and `SessionRail`'s marks are for) but NOT the same placement: `SessionRail`'
 * own doc states the opposite rule — `pointer-events-none` goes on a block,
 * never on the frame — because the rail's frame holds blocks with OPPOSITE
 * pointer rules and a transparent frame would switch its clickable strips off.
 * This panel has no clickable child of its own: the frame IS the scroll
 * container, so putting it on the frame is the whole idiom here, and the
 * consequences the JSX comment below names are the price of that. And below the
 * breakpoint the panel prefers the corner, where a gate is buried but RENDERED
 * and answerable
 * the moment the sheet closes, over a dodge that would squeeze it toward zero
 * width and leave the gate unreachable forever — a child buried this way is
 * an **Active Subagent** (ADR 0055), so no clock ever resolves it either.
 *
 * WHY THE HOST NEEDS THE `sheetMounted` PROP. The dodge fires when a sheet is
 * actually ON SCREEN, and that is TWO facts the overlay cannot derive on its own:
 * the selection names a sheet (`useSubagentSelection` + the entry still
 * existing), and the sheet's own view is MOUNTED. `SubagentDetailHost` lives
 * inside `App`'s `view === "settings"` ternary and this host deliberately does
 * not, so the Settings view is exactly the state where a selection names a sheet
 * that is not painted. `App` therefore passes `sheetMounted` for the second fact
 * instead of clearing the selection on the way in: the selection belongs to the
 * sheet (`store/subagentSelection`, written by `SubagentDetailHost` and the
 * `SubagentDelegatingCard` rows that open it), and a host that resets another
 * component's store to fix its own geometry both reaches across a boundary and
 * costs the user their open
 * sheet — Back from Settings used to land with the transcript closed.
 *
 * PERF (accepted deliberately): the three selectors below return the stores'
 * OWN map references, so this component re-renders on ANY session's gate
 * churn — the per-entry `useShallow` map this used to read avoided that, and
 * dropping it is a conscious trade: the whole point of this component is that
 * it must react to any child's gate, and it renders a handful of cards. What is
 * NOT negotiable is that the selectors return store references — assembling with a
 * `?? {}` fallback INSIDE a selector mints a fresh object per call and re-renders
 * forever (the hazard `useSessionStatuses`' selector note states). All assembling
 * happens in the component body.
 */
export function SubagentModals({ sheetMounted = true }: { sheetMounted?: boolean }) {
  // The whole maps, on purpose (see the PERF note above).
  const entries = useSubagents((s) => s.entries);
  const requests = useInteractive((s) => s.requests);
  const prompts = usePermissions((s) => s.prompts);
  // The partition key (see the component doc). A per-key selector, not the
  // whole store: this component must not re-render on unrelated session churn.
  const activeSessionId = useSessions((s) => s.activeSessionId);
  // Does a child's transcript SHEET occupy the right edge? TWO facts, and the
  // host is told one and reads the other (see the GEOMETRY note above): the
  // `sheetMounted` prop is the view, and this selection plus a still-present
  // entry is whether a sheet is actually painted in it — `SubagentDetailHost`
  // paints one only for a selection that still has an entry, so a stale
  // selection must not move this panel either. This component is an `App`-root
  // sibling, so an extra hook here is safe (no early return), and it reads a
  // store this component already needs to react to. `sheetMounted` defaults to
  // `true` because a test that renders this host in isolation IS the workspace
  // case; `App` — the only production caller, and the only place that knows which
  // view is mounted — passes the real value.
  const selectedSessionId = useSubagentSelection((s) => s.selectedSessionId);
  // `null` = every child's gates, whatever their parent — the sudo modals need
  // all of them, and the cards filter the active parent out below.
  const gates = childGatesOf(entries, requests, prompts, null);
  const confirmGates = gates.filter((g) => g.kind === "confirm");
  const passwordGates = gates.filter((g) => g.kind === "password");
  // The overlay's CARD half is `isInlineChildGate` MINUS the active parent: the
  // kinds the transcript draws, for a parent whose transcript is not on screen.
  // It is written as the predicate rather than a local `kind` check on purpose
  // — `isInlineChildGate` is what the transcript filters with, so this filter is
  // the OTHER HALF of that one definition and cannot disagree with it. A
  // hand-written `ask || permission` copy here is how a fifth `ChildGateKind`
  // added to the predicate ends up rendered in BOTH sites (the ONE-SITE-PER-GATE
  // rule), because the copy would keep drawing the old two while the transcript
  // drew the new one.
  const cardGates = gates.filter(
    (g) => isInlineChildGate(g) && g.parentSessionId !== activeSessionId,
  );

  // The children named in the region label (distinct, in arrival order).
  const childNames: string[] = [];
  for (const g of cardGates) {
    if (!childNames.includes(g.agentName)) childNames.push(g.agentName);
  }
  // The panel's geometry. The sheet is a `fixed` panel pinned to the viewport's
  // top-right at `SHEET_WIDTH_CLASS` (`SubagentDetailHost`), so its rect is a
  // strict SUPERSET of a corner panel's: while a sheet is painted, a
  // right-anchored panel is 100% hidden underneath it — including the very card
  // the attention alert just told the user to answer. So at wide-enough viewports
  // the panel slides to the sheet's LEFT edge and caps its width at the room left
  // over.
  //
  // The dodge is a MEDIA VARIANT (the breakpoint variant of
  // `GATE_PANEL_DODGE_BREAKPOINT`), not a swap, and the corner geometry stays as
  // the unconditional base — which is the whole design:
  //   • at ≥ 760px the leftover room is `100vw - 480 ≥ 280px`, which is the
  //     narrowest card column worth squeezing in (`GATE_PANEL_MIN_WIDTH`,
  //     `src/lib/subagentSheetLayout.ts`), so the dodge is a real gain;
  //   • below it the variant stops applying and the panel is back in the
  //     viewport corner, where a gate is at least RENDERED. The dodge's own math
  //     there is `min(480, 100vw - 480)` — a 120px strip at 600px and, at
  //     ≤ 480px, a ZERO-width box positioned off-viewport: a gate that is
  //     mounted and UNREACHABLE — and since ADR 0055 nothing else rescues it
  //     either, because a child parked on a gate is Active and no clock bounds
  //     it.
  //     Buried-but-rendered is the better failure: it is the geometry this
  //     branch had before the dodge, and closing the sheet reveals a card you
  //     can answer. Right-anchored as the base also means a variant that failed
  //     to compile degrades to the old behaviour rather than to an unreachable
  //     gate (the classes are verified present in the built CSS;
  //     `SubagentModals.test.tsx` pins the class list, jsdom has no layout).
  //
  // Every number in that pair comes from `src/lib/subagentSheetLayout.ts`, and so
  // do the class literals themselves: this file interpolates the module's
  // constants (`SHEET_WIDTH_CLASS` for the width, the two dodge classes for the
  // offset and the cap), so the sheet and this panel cannot be widened
  // independently — the module's literal and its arithmetic are tied at compile
  // time, and `SubagentModals.test.tsx` re-pins the rendered pair. Nothing here
  // changes WHERE a gate renders: this is geometry only.
  const sheetOpen =
    sheetMounted &&
    selectedSessionId !== null &&
    Object.values(entries).some((e) => e.sessionId === selectedSessionId);

  return (
    <>
      {/* The sudo modals are SIBLINGS of the panel below, never children of it:
          Radix `Dialog` portals to `document.body` but React events still
          bubble through the REACT tree, so a `Dialog` nested in the panel would
          have its Escape swallowed by the panel's stop — silently changing
          today's Esc-in-sudo-modal behaviour. */}
      {confirmGates.map((g) => (
        <SudoConfirmModal
          key={childGateKey(g)}
          sessionId={g.childSessionId}
          requestId={g.requestId}
        />
      ))}
      {passwordGates.map((g) => (
        <SudoPasswordModal
          key={childGateKey(g)}
          sessionId={g.childSessionId}
          requestId={g.requestId}
        />
      ))}
      {/* The lifted cards (`ask` / permission) for a child whose PARENT IS NOT
          the active session (see the component doc — the active parent's half
          renders inline in its own transcript). `fixed` so the panel pins to
          the viewport's bottom-right corner WITHOUT taking a slot in `App`'s
          flex row (it is a sibling of the workspace columns, not one of them);
          it is not inside the clipped `SidePane` frame at all, so a collapsed
          pane is simply not its concern.
          `pointer-events-none` on the region, `pointer-events-auto` on each
          card: the panel spans up to 480px of the window and a `fixed` box
          would otherwise eat every click inside its rect, including controls it
          does not contain — the `SidePane` footer toggle behind it, and (when
          dodging) the LEFT pane's footer/toggle, since `LEFT_PANE_WIDTH` is 260
          and a panel offset 480px from the right edge of an 800px window covers
          it. The region is therefore CLICK-TRANSPARENT outside its cards, which
          is also why the geometry costs stopped being a reason to refuse the
          dodge: an overlap that steals no clicks is a painting question only.
          THE PRICE, named honestly, is everything the frame itself would have
          taken a pointer for — three things, all accepted:
            • a wheel event reaches the panel only over a CARD (the gaps are
              click-through, so they are wheel-through too), which is what
              `max-h-[70vh]` and a handful of cards are for;
            • the panel's own SCROLLBAR is not draggable — the scrollbar belongs
              to this frame, and the frame takes no pointer events. Keyboard and
              assistive-tech scrolling are unaffected, as is the wheel-over-card
              path above;
            • text cannot be drag-SELECTED across the gaps: a drag that starts in
              a gap or in the `p-3` padding lands on nothing and never reaches a
              card. It still starts inside a card, and copy/click-by-keyboard are
              untouched.
          `SessionRail`'s doc states the opposite rule for its frame (see the
          GEOMETRY note on the component): same principle — transparent where the
          box holds nothing — applied to the frame here because the frame IS the
          scroll container and has no clickable child to switch off. That is the
          accepted trade, and it is the reason the panel caps its height instead
          of relying on a draggable scrollbar.
          `z-40`: `DialogContent` and `SubagentDetailHost`'s sheet are both
          `z-50`, so this panel always paints UNDER an open sudo modal (and is
          `aria-hidden`/pointer-inert while one is open — accepted: that modal
          IS the prompt in front of the user, and the gate underneath stays
          pending). It must not paint under the TRANSCRIPT sheet either, though
          — the sheet is right-anchored and `SUBAGENT_SHEET_WIDTH` wide, so
          `z-40` alone meant every card here vanished the moment a child's
          transcript was opened (and the attention alert can point at one of
          them). Hence `sheetOpen` and the variant-prefixed dodge pair above
          (`GATE_PANEL_DODGE_OFFSET_CLASS` + `GATE_PANEL_DODGE_MAX_WIDTH_CLASS`,
          both gated on `GATE_PANEL_DODGE_BREAKPOINT`): at any
          width where there is room for both, opening a child's transcript moves
          the question aside instead of hiding it, and where there is not, the
          panel falls back to the corner (see the geometry comment). Escape is
          stopped here with NO answering action (the region is not dismissible):
          `ChatStream`'s window-level `keydown` sends `session/cancel` while a
          turn is in flight, `AskQuestionCard` stops propagation only when focus
          is inside ITS OWN root, and `PermissionPrompt` has no Escape handler at
          all — so an Esc landing on the scroll container or on a permission
          button would otherwise kill the PARENT's turn. It does not break the
          cards' own Esc: React runs the innermost handler first, and a child's
          ask answers Esc as soon as the user clicks into it — and never before
          (`autoFocus={false}`, so a card that appears mid-sentence cannot take
          the composer's focus). */}
      {cardGates.length > 0 && (
        <div
          data-testid="subagent-gate-overlay"
          role="region"
          aria-label={`Subagent prompts — ${childNames.join(", ")}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.stopPropagation();
          }}
          className={
            // The corner geometry is the BASE (see the geometry comment above):
            // the dodge is layered on top of it, and only from the breakpoint
            // up. `pointer-events-none` here, re-armed per card below. The width
            // and the dodge pair are the layout module's own literals.
            "fixed bottom-0 z-40 flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-3 " +
            "pointer-events-none right-0 " +
            SHEET_WIDTH_CLASS +
            " max-w-[90vw] " +
            (sheetOpen
              ? GATE_PANEL_DODGE_OFFSET_CLASS + " " + GATE_PANEL_DODGE_MAX_WIDTH_CLASS
              : "")
          }
        >
          {cardGates.map((g) => (
            <div key={childGateKey(g)} className="pointer-events-auto">
              {/* The attribution chip lives HERE, not inside the card
                  components: those stay parent/child-agnostic and are reused
                  unchanged by the main chat. A child's `requestId` is the
                  model's tool-call id, which some OpenAI-compatible gateways
                  reuse per response, so the key is `childGateKey` (child id +
                  request id) — a bare `requestId` collides across children and
                  drops one card. */}
              <p className="mb-1 text-ui-xs text-foreground-subtle">
                ↳ {g.agentName}
              </p>
              {g.kind === "ask" ? (
                <AskQuestionCard
                  sessionId={g.childSessionId}
                  requestId={g.requestId}
                  autoFocus={false}
                />
              ) : (
                <PermissionPrompt
                  sessionId={g.childSessionId}
                  requestId={g.requestId}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
