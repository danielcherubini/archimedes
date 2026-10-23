import AskQuestionCard from "./AskQuestionCard";
import PermissionPrompt from "./PermissionPrompt";
import type { ChildGate } from "../hooks/useChildGates";

/**
 * The CHILD-GATE CARD — one gate's attribution chip plus the card that answers
 * it, rendered by BOTH render sites (finding 5).
 *
 * THE INVARIANT THIS SERVES, stated once here and cross-referenced from both
 * call sites: **every gate renders exactly once**, so a gate is never answerable
 * twice and never rendered NOWHERE (ADR 0040). Which SITE renders a gate is NOT
 * this component's decision — it is the partition on "is this gate's parent the
 * ACTIVE Session": the parent's own transcript (`chat/TranscriptFooter`, fed by
 * `useChildGates(activeSessionId)`) or the always-mounted corner overlay
 * (`SubagentModals`). Both sites hand THIS component a gate they have already
 * agreed is theirs by filtering with the one predicate `isInlineChildGate`, so
 * the card half cannot drift from the row half as `ChildGateKind` grows — see
 * `SubagentModals.renderSite.test.tsx`, which pins that the overlay ASKS that
 * predicate instead of re-deriving a kind list. This component therefore has NO
 * kind list of its own: its only branch is WHICH card a gate draws (`ask` →
 * `AskQuestionCard`, anything else the site hands it → `PermissionPrompt`),
 * never WHETHER it is drawn. Dropping an unrecognised kind here would be a gate
 * rendered NOWHERE — the strand this invariant exists to prevent.
 *
 * THE NAME SAYS "ROW", THE COMPONENT IS THE CARD. The row belongs to the site:
 * the transcript's `data-testid="gate-row"` flex column (whose `flex flex-col`
 * and its freedom from any top-padding utility `MessageList.gap.test.tsx` pins)
 * and the overlay's `pointer-events-auto` card box (whose click-transparency
 * rule the overlay documents) are each a property of WHERE the card is drawn,
 * not of the card. So this component renders a FRAGMENT and therefore NO
 * ELEMENT: a React boundary emits no DOM, which is the only way one
 * implementation can replace two copies without changing either rendered tree.
 * That is also why the two sites' `Escape` handlers stay where they are (below)
 * — a fragment cannot carry a handler, and giving the card an element to host
 * one would add a DOM level to both sites.
 *
 * THE ESCAPE HANDLERS STAY AT THE SITES, AND THEY ARE NOT THE SAME HANDLER.
 * Both stop `Escape` with NO answering action (neither site's wrapper is
 * dismissible: stopping answers nothing and hides nothing, the gate stays
 * pending) so a keypress meant for a child's card cannot reach `ChatStream`'s
 * WINDOW-level `keydown`, which answers Escape with `session/cancel` while a
 * turn is in flight — and `PermissionPrompt` has no Escape handler of its own at
 * all, so without a stop an Esc on one of its buttons would cancel the PARENT's
 * turn under a child's unanswered question. But the two stops cover DIFFERENT
 * areas on purpose:
 *   • `chat/TranscriptFooter.tsx` stops on the ROW, per gate, because in a
 *     transcript the only thing between a card and the window is its own row;
 *   • `SubagentModals.tsx` stops on the REGION, once, because the overlay's
 *     frame is a scroll container whose padding and the gaps between its cards
 *     are also "between a card and the window" — a stop on a card could never
 *     cover them.
 * Neither stop is duplicated here, and neither may be: React runs the innermost
 * handler first, so a card-level stop would swallow the keypress BEFORE the
 * region's stop and, worse, would leave the chip (a sibling of the card, not a
 * descendant of it) and every gap and the region's own padding uncovered —
 * strictly fewer keypresses consumed than today. An `ask` card that answers
 * Escape itself (only once focus is inside it) still stops it first at both
 * sites, which is `SubagentModals.test.tsx`'s "the wrapper's stop does not
 * swallow it" pin and holds unchanged.
 *
 * `autoFocus` DEFAULTS TO `false`, and that default IS the invariant: a lifted
 * child gate must never take the caret out from under the composer, because a
 * child's `ask` can arrive at any moment including mid-sentence
 * (`AskQuestionCard`'s own doc: focus would jump to a `tabIndex={-1}` div and
 * Enter would stop sending). Both sites rely on the default — a lifted gate has
 * no case where stealing focus is right, so the safe value is the one a call
 * site cannot forget to pass. The `ask` card's own Enter/Esc shortcuts still
 * work the moment the user clicks into it, because that `onKeyDown` belongs to
 * `AskQuestionCard`'s own root, not to this component -- `InlineGateRow` renders
 * a fragment and owns no handler at all (see above). `PermissionPrompt` needs no
 * key handler: it is answered by its own option buttons, which are focusable and
 * fire on Enter natively.
 * The sudo `Dialog`s are not affected: they are Radix `Dialog`s, always take
 * focus on open, and are NOT rendered here (they are the overlay's siblings, so
 * the overlay's Escape stop never reaches them).
 */
export function InlineGateRow({
  gate,
  autoFocus = false,
}: {
  /** An ALREADY-FILTERED gate (`isInlineChildGate`, and the site's own half of
   *  the partition). Never re-filtered here — see the component doc. */
  gate: ChildGate;
  /** Overrides the never-steal-the-caret default. No production site passes it. */
  autoFocus?: boolean;
}) {
  return (
    <>
      {/* The attribution chip — "who is asking" — lives on the CARD, never
          inside `AskQuestionCard`/`PermissionPrompt`: both stay parent/child
          agnostic and are reused unchanged by the main chat, which has no child
          to name. A child's `agentName` is the resolved name from its directory
          entry (`SubagentEntry.agentName`), which is the only "who" a gate
          carries — `InteractiveRequestData.source` names no one (every emitter
          sends the transport label `"native"`). */}
      <p className="mb-1 text-ui-xs text-foreground-subtle">
        ↳ {gate.agentName}
      </p>
      {gate.kind === "ask" ? (
        <AskQuestionCard
          sessionId={gate.childSessionId}
          requestId={gate.requestId}
          autoFocus={autoFocus}
        />
      ) : (
        <PermissionPrompt
          sessionId={gate.childSessionId}
          requestId={gate.requestId}
        />
      )}
    </>
  );
}
