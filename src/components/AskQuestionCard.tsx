import { useEffect, useRef, useState } from "react";
import {
  respondInteractiveRequest,
  type AskQuestionDto,
  type AskResponsePayload,
} from "../lib/tauri";
import { useInteractive } from "../store/interactive";
import type { InteractiveRequestData } from "../store/interactive";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useSessions } from "../store/sessions";
import { useSubagents } from "../store/subagents";
import { Button } from "./ui/button";
import { IpcErrorLine } from "./IpcErrorLine";
import { MutedCaption } from "./MutedCaption";
import { cn } from "./lib/utils";

const OTHER_OPTION = "Other (type your own)";
const RECOMMENDED_TAG = " (Recommended)";

/**
 * THE OPTION ROW and the `Other` row — the same box, drawn twice (C8 records
 * them as two copies of one shape). `ASK_OPTION_WALL` undoes what `Button`'s
 * base and the `default` size would change; `ASK_OPTION_ROW` is the class list
 * both rows carried VERBATIM and it comes FIRST-BUT-LAST among the two, so the
 * row wins every group it spells. The selected fill is appended after both, as
 * it was before.
 *
 * What the wall undoes:
 *  - `border-0` — the base's `border` is a 1px ring; the row had none, and
 *    preflight sets `border: 0 solid`. It would grow a 21px row to 23px and
 *    inset the ☐ by 1px. It also makes the base's `bg-clip-padding` a no-op:
 *    with a zero-width border, `padding-box` and `border-box` are the same box,
 *    which matters only on the SELECTED arm, where a background does paint.
 *  - `h-auto` — the size's `h-7` is a fixed 28px. These rows are
 *    `py-0.5`-high and GROW: an option label wraps onto two lines
 *    (`[overflow-wrap:anywhere]` is on the label's own span precisely so a long
 *    one can). A fixed height would clip the second line.
 *  - `justify-start` — the size centres content on the main axis; these rows
 *    are left-aligned lists and the row spells `text-left` but not `justify-*`.
 *  - `whitespace-normal` — the base's `whitespace-nowrap` is a real repaint:
 *    the row inherited `white-space: normal`, and the label's own
 *    `[overflow-wrap:anywhere]` is only meaningful if wrapping is allowed.
 *  - `[user-select:auto]` — the base's `select-none` would make an option's
 *    text unselectable. `select-auto` would instead be the SAME tailwind-merge
 *    group as `select-none` and get it dropped by the merge; the arbitrary
 *    property is a different group, so both survive and the cascade decides —
 *    `[user-select:auto]` is emitted after `.select-none` in the built sheet.
 *    (`.select-auto` itself exists in the sheet, but BEFORE `.select-none`, so
 *    the merge is what would have to carry it. See `SpacesList.tsx`'s same wall
 *    for the measured offsets.)
 *  - `disabled:pointer-events-auto` — the base's `disabled:pointer-events-none`
 *    is a REAL change here and this is the one arm `Button` adds that a test
 *    would never catch: these rows ARE disabled while `busy`, and in the
 *    original a disabled row still matched `:hover`, so hovering it filled
 *    `bg-surface-hover` under the 50% dimming. With `pointer-events: none` it
 *    would not fill, and the pointer would fall through to the card behind.
 *
 * What the row wins by being LAST: `flex` (over the base's `inline-flex`),
 * `gap-2` (over the size's `gap-1`), `px-1` (over `px-2`), `rounded-md`,
 * `items-center`, `text-ui-base`, `hover:bg-surface-hover` (the ghost arm's
 * `hover:bg-hover` is a different colour in zai-dark and Dracula — 5% against
 * surface-hover's 10%), and `disabled:opacity-50`, which is byte-identical to
 * the base's own so neither side can lose it.
 *
 * Inert additions, with the reason:
 *  - the ghost arm's `text-foreground` / `hover:text-foreground` — the row
 *    spells no colour, but it paints NO TEXT of its own: both children are
 *    spans that spell their own (`text-interaction-ask-foreground` /
 *    `text-foreground` / `text-foreground-subtlest`), and the row itself is
 *    inside a card whose ink is `text-foreground` anyway;
 *  - `text-ui-base/relaxed` never survives the merge at all — the row's own
 *    `text-ui-base` deletes the base's compound utility, line-height included
 *    (measured: `cn("text-ui-base/relaxed", "text-ui-base")` → `text-ui-base`),
 *    so the row keeps the font-size it inherited and declares no line-height,
 *    exactly as before;
 *  - `outline-none` — `base.css:53-57` forces `outline: none !important` on
 *    every `:focus`/`:focus-visible` regardless, in every browser and again
 *    under `forced-colors`;
 *  - `aria-invalid:*` / `aria-expanded:*` — nothing sets either attribute here;
 *  - `shrink-0` — the rows are children of a `space-y-1` BLOCK container, so
 *    `flex-shrink` never applies;
 *  - `[&_svg]:pointer-events-none`, `[&_svg]:shrink-0`,
 *    `[&_svg:not([class*='size-'])]:size-3.5` — there is no `<svg>` in either
 *    row; the ☐/● marks are text in spans;
 *  - `has-data-[icon=inline-*]:pr/pl` — no child carries `data-icon`;
 *  - `group/button` — nothing reads that group.
 */
const ASK_OPTION_WALL =
  "border-0 h-auto justify-start whitespace-normal [user-select:auto] disabled:pointer-events-auto";
const ASK_OPTION_ROW =
  "flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-ui-base hover:bg-surface-hover disabled:opacity-50";

/**
 * Per-question draft: which option indexes are selected, whether `Other` is
 * chosen, the `Other` free text, and a note per option index (mirrors the
 * TUI picker's `noteByOptionIndex`).
 */
interface QuestionDraft {
  selected: number[];
  other: boolean;
  otherText: string;
  notes: Record<number, string>;
}

const EMPTY_DRAFT: QuestionDraft = {
  selected: [],
  other: false,
  otherText: "",
  notes: {},
};

/**
 * Build one question's result entry (mirrors the TUI's
 * `buildSingleSelectionResult` / `buildMultiSelectionResult`): a selected
 * option with a note becomes `"<label> - <note>"`; the `Other` option's
 * text becomes `customInput`.
 */
function buildResult(
  question: AskQuestionDto,
  draft: QuestionDraft,
): { selectedOptions: string[]; customInput?: string } {
  const selectedOptions: string[] = [];
  for (const index of draft.selected) {
    const label = question.options[index]?.label ?? "";
    const note = draft.notes[index]?.trim();
    selectedOptions.push(note ? `${label} - ${note}` : label);
  }
  const customInput = draft.other ? draft.otherText.trim() : "";
  if (customInput) return { selectedOptions, customInput };
  return { selectedOptions };
}

/** Whether the draft has an answer to submit (a selection or `Other` text). */
function draftHasAnswer(draft: QuestionDraft): boolean {
  return (
    draft.selected.length > 0 || (draft.other && draft.otherText.trim() !== "")
  );
}

/**
 * The questions an `ask` request carries — ONE derivation, because two places
 * ask the question and they MUST agree: this card (its render, its
 * self-cancelling effect) and `MessageList`'s anchored row (issue #86 — see
 * `isAskRowRenderable`). The cast is the wire shape: `params` is a
 * `Record<string, unknown>` on the store type, and the `ask` method's payload
 * is the `questions` array.
 */
function askQuestionsOf(
  request: InteractiveRequestData | undefined,
): AskQuestionDto[] {
  return (request?.params as { questions?: AskQuestionDto[] } | undefined)
    ?.questions ?? [];
}

/**
 * Whether an `ask` request has anything to DRAW — the single rule behind both
 * the card (`if (!isAskRowRenderable(request)) return null`) and the anchored
 * transcript row in `MessageList`, which must not emit a padded `message-row`
 * for a card that would render `null`.
 *
 * It exists as an EXPORTED PREDICATE rather than an inline condition because
 * the row cannot observe the card's own `return null` (`wrap()` receives a JSX
 * element, and the child's decision happens later, during render). The row
 * therefore evaluates this on the same data, and if the two ever disagreed the
 * blank row of issue #86 would be back — which is why neither side is allowed
 * to hand-write `!request || questions.length === 0` again.
 *
 * False for a request that has left the store (dismissed / answered — the
 * anchor's `tool-call` message outlives it) and for one carrying zero
 * questions.
 */
export function isAskRowRenderable(
  request: InteractiveRequestData | undefined,
): boolean {
  return !!request && askQuestionsOf(request).length > 0;
}

/**
 * Inline card for an interactive `ask` request — the ask UI ported from the TUI
 * (accent separator, circular radio list — filled amber dot = selected;
 * `Other (type your own)` free-text; checkboxes for `multi`;
 * `(Recommended)` suffix; a per-option note field; footer hints; a final
 * batch review for multi-question asks).
 *
 * **Correlation** is keyed by `(source, toolCallId)` or the frame UUID
 * `requestId` — never by bare `toolCallId` (the store keys by `requestId`;
 * the `toolCallId` is carried for anchoring to the ACP `tool_call` frame
 * when present). The card's "who is asking" label is the RESOLVED agent
 * name from `useSubagents` (keyed by this card's `sessionId`, which is the
 * CHILD's id when a child's gate is rendered), never `request.source` — the
 * only value the desktop's transport emits there is the transport label
 * `native`, which names nobody. `isSubagent` survives ONLY as the `queued`
 * placeholder's gate below (a child's ask never gets a `tool_call` frame, so
 * it is never queued); no production emitter sends a `subagent:` source, so
 * that gate is live for a future emitter and for the fixtures that pin it,
 * not for traffic. If the request arrives before its ACP
 * `tool_call` frame, the card renders queued (bounded ~1.5 s) then
 * unanchored/labeled.
 *
 * Submit → `respondInteractiveRequest` with the `AskResponsePayload` +
 * `removeRequest` (the card collapses on settle). The card takes focus on
 * mount when UNANCHORED (a standalone card — no focus steal from the
 * message stream) so the advertised Enter/Esc shortcuts work immediately.
 * Cancel → `{ cancelled: true, results: [] }` + `removeRequest`.
 *
 * `autoFocus` (default `true`) opts out of that mount focus. It exists for a
 * CHILD's gate lifted into its parent's transcript or into the overlay: such a
 * card is NEVER anchored (anchoring needs `source === "main"`, and every frame
 * the transport emits carries `source: "native"` — see
 * `InteractiveRequestData.source` — while `ask_flow` and the sudo sub-prompts
 * both send `toolCallId: null`), so the unanchored rule above would fire for
 * every one of them — and a child's `ask` can arrive at any moment, including
 * while the user is mid-sentence in the composer. Focus would jump to a
 * `tabIndex={-1}` div, the remaining keystrokes would be lost, and Enter would
 * stop sending. Both lifted sites therefore pass `autoFocus={false}`; the
 * shortcuts still work as soon as the user clicks into the card (the `onKeyDown`
 * lives on the card root either way).
 */
export default function AskQuestionCard({
  sessionId,
  requestId,
  autoFocus = true,
}: {
  sessionId: string;
  requestId: string;
  autoFocus?: boolean;
}) {
  const request = useInteractive((state) =>
    (state.requests[sessionId] ?? []).find((r) => r.requestId === requestId),
  );
  const removeRequest = useInteractive((state) => state.removeRequest);
  // The card takes focus on mount when unanchored AND `autoFocus` (see the
  // component doc above) so the Enter/Esc `onKeyDown` — which only fires with
  // focus INSIDE the card — works immediately for a standalone card.
  const cardRef = useRef<HTMLDivElement>(null);
  // Anchoring: the ACP `tool_call` frame for this request is in the stream
  // (only a `main` ask with a `toolCallId` can anchor — the desktop has no
  // `tool_call` frame for child tool calls).
  const anchored = useSessions((state) => {
    if (!request || request.source !== "main" || !request.toolCallId) {
      return false;
    }
    const messages = state.messages[sessionId];
    if (!messages) return false;
    return messages.some(
      (m) => m.kind === "tool-call" && m.id === request.toolCallId,
    );
  });
  const isSubagent = request?.source.startsWith("subagent:") ?? false;
  // "Who is asking" comes from the RESOLVED agent name, never from
  // `request.source`. Every `interactive-request` the desktop emits carries
  // the transport label `"native"` (`ask_flow` in
  // `src-tauri/src/agent/harness/ask.rs`, the sudo sub-prompts in
  // `src-tauri/src/agent/interactive/mod.rs`) for a main session and a
  // Subagent session alike, so `source` names no one — and `isSubagent`
  // below, which needs a `subagent:` prefix no emitter sends, never fires
  // in production. A child's card is mounted with the CHILD's session id
  // (`TranscriptFooter` / `SubagentModals` pass `gate.childSessionId`),
  // which is the key `useSubagents` stores entries under, so the child's
  // own `agentName` resolves here. A main session has no entry under its id
  // and keeps the generic copy. The fallback is a TRUTHINESS test, not a
  // nullish coalesce: `agentName` is a required string and a config-less
  // (label-only) dispatch stores `""` (`unwrap_or_default()` on the
  // `agentName` param in `src-tauri/src/agent/harness/dispatch.rs`), which a
  // `??` would render as an EMPTY label. The selector returns a PRIMITIVE, so
  // no snapshot-equality churn (the store's stable-reference rule).
  const agentName = useSubagents(
    (state) => state.entries[sessionId]?.agentName,
  );
  // Queued: the request arrived before its ACP `tool_call` frame — render a
  // bounded (~1.5 s) placeholder, then the full card (unanchored/labeled).
  // Subagent asks never get a `tool_call` frame, so they are never queued.
  const [queued, setQueued] = useState(
    () => !isSubagent && request?.toolCallId !== undefined,
  );
  // NO `guard`: this site has no `if (busy) return` today. Re-entrancy is held
  // by the two keydown guards (`!busy` on Enter and on Esc) and the four
  // `disabled={busy}` props below, all of which read this `busy` — the flag is
  // still the same value from the same machine, so every one of them behaves as
  // before. The `queued` pair and `drafts` are separate machines and stay here.
  const { busy, error, run } = useAsyncAction();
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});

  // Queued: the request arrived before its ACP `tool_call` frame — render a
  // bounded (~1.5 s) placeholder, then the full card (unanchored/labeled).
  useEffect(() => {
    if (!queued) return;
    if (anchored) {
      // The `tool_call` frame arrived: unqueue immediately.
      setQueued(false);
      return;
    }
    const timer = setTimeout(() => setQueued(false), 1500);
    return () => clearTimeout(timer);
  }, [queued, anchored]);

  useEffect(() => {
    if (!queued && autoFocus) {
      // Unanchored (a standalone card): take focus so the Enter/Esc
      // shortcuts work immediately. Anchored (inline in the message
      // stream): don't steal focus — the shortcuts work once the user
      // clicks into the card. `autoFocus === false` (a lifted child gate)
      // opts out for the same reason, unconditionally: see the component doc.
      if (!anchored) cardRef.current?.focus();
    }
  }, [queued, anchored, autoFocus]);

  const questions = askQuestionsOf(request);

  // SAFETY NET: a request this card has no questions to draw is still a GATE
  // — in the store (the sidebar `?`, a locked composer) and in the Worker (the
  // turn is blocked on it) — and rendering `null` leaves nothing that can
  // answer it, so the session strands until the user cancels the whole turn.
  // The harness no longer opens such a gate (`ask_flow` errors first), but this
  // card is the LAST thing able to close one, so it does: cancel + clear. Once
  // per instance (`cleared`), because the effect re-runs while the request is
  // still in the store during the round trip.
  const cleared = useRef(false);
  const unrenderable = !!request && questions.length === 0;
  useEffect(() => {
    if (!unrenderable || cleared.current) return;
    cleared.current = true;
    void respondInteractiveRequest(sessionId, requestId, {
      cancelled: true,
      results: [],
    })
      .catch(() => {})
      .finally(() => removeRequest(sessionId, requestId));
  }, [unrenderable, sessionId, requestId, removeRequest]);

  if (!isAskRowRenderable(request)) return null;

  const draft = (id: string): QuestionDraft => drafts[id] ?? EMPTY_DRAFT;
  const updateDraft = (id: string, fn: (d: QuestionDraft) => QuestionDraft) =>
    setDrafts((prev) => ({ ...prev, [id]: fn(prev[id] ?? EMPTY_DRAFT) }));

  const toggleOption = (question: AskQuestionDto, index: number) =>
    updateDraft(question.id, (d) => {
      const selected = d.selected.includes(index)
        ? d.selected.filter((i) => i !== index)
        : question.multi
          ? [...d.selected, index]
          : [index];
      // Single: choosing an option clears `Other` (they are exclusive).
      // Multi: `Other` stays additive.
      const other = question.multi ? d.other : false;
      return { ...d, selected, other };
    });

  const toggleOther = (question: AskQuestionDto) =>
    updateDraft(question.id, (d) => {
      const other = !d.other;
      const selected = question.multi ? d.selected : other ? [] : d.selected;
      return { ...d, other, selected };
    });

  const respond = (cancelled: boolean) => {
    const payload: AskResponsePayload = cancelled
      ? { cancelled: true, results: [] }
      : {
          cancelled: false,
          results: questions.map((q) => {
            const result = buildResult(q, draft(q.id));
            return result.customInput !== undefined
              ? {
                  id: q.id,
                  selectedOptions: result.selectedOptions,
                  customInput: result.customInput,
                }
              : { id: q.id, selectedOptions: result.selectedOptions };
          }),
        };
    return run(() =>
      respondInteractiveRequest(sessionId, requestId, payload).then(() =>
        // The card collapses on settle.
        removeRequest(sessionId, requestId),
      ),
    );
  };

  // Queued: a bounded placeholder while the ACP `tool_call` frame is
  // expected (then the full card, unanchored/labeled).
  if (queued) {
    return (
      <div className="rounded-xl border border-border bg-interaction-ask-surface px-3 py-2">
        <p className="text-ui-sm text-interaction-ask-foreground">
          {agentName ? `${agentName} is asking…` : "Agent is asking…"}
        </p>
      </div>
    );
  }

  const canSubmit = questions.every((q) => draftHasAnswer(draft(q.id)));

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      className="rounded-xl border border-border focus-visible:outline focus-visible:outline-foreground-subtle/60"
      onKeyDown={(e) => {
        if (e.key === "Enter" && canSubmit && !busy) {
          e.preventDefault();
          void respond(false);
        } else if (e.key === "Escape" && !busy) {
          e.preventDefault();
          // Stop the native event from bubbling to `window`: the global
          // Esc handler (ChatStream) sends `session/cancel` while a turn is
          // in flight — an Esc meant for THIS card (dismiss) must not also
          // cancel the whole turn.
          e.stopPropagation();
          void respond(true);
        }
      }}
    >
      {/* Accent separator (the TUI's accent line). */}
      <div className="flex items-center gap-2 bg-interaction-ask-surface px-3 py-2">
        <span className="h-px flex-1 bg-interaction-ask-foreground/60" aria-hidden />
        <span className="text-ui-xs text-interaction-ask-foreground">
          {agentName || "Agent question"}
        </span>
        <span className="h-px flex-1 bg-interaction-ask-foreground/60" aria-hidden />
      </div>

      <div className="space-y-4 p-3">
        {questions.map((question, questionIndex) => {
          const d = draft(question.id);
          return (
            // Keyed by POSITION, never by `question.id`. The Rust `ask` flow
            // now NORMALIZES its payload before emitting it (a question with
            // no `id` gets a unique positional one), so a live ask always
            // arrives with usable ids — but this stays position-keyed on
            // purpose: a session recorded BEFORE that fix replays from SQLite
            // with no `id` at all (`key={undefined}` is React's "unique `key`
            // prop" warning), and a live 5-question ask once arrived exactly
            // like that. Position is also the identity this component already
            // uses for its drafts (`drafts[question.id]` aside, the selections
            // and notes are option INDEXES), and the list is neither reordered
            // nor spliced for the life of a pending request — so an index key
            // is stable here.
            <div key={questionIndex}>
              <p className="text-ui-base [overflow-wrap:anywhere] text-interaction-ask-foreground">
                {question.question}
              </p>
              {question.description && (
                <p className="mt-1 text-ui-xs [overflow-wrap:anywhere] text-foreground-subtle">
                  {question.description}
                </p>
              )}
              <div className="mt-2 space-y-1">
                {question.options.map((option, index) => {
                  const selected = d.selected.includes(index);
                  const recommended = question.recommended === index;
                  return (
                    // Keyed by POSITION (see the question key above). The
                    // `label` is the wrong key twice over regardless of the
                    // normalization: two options of the SAME question may share
                    // a label, which no `question.id` prefix can rescue
                    // (`${question.id}:${option.label}` scopes a key across
                    // questions, never within one); and a row persisted BEFORE
                    // the fix still replays options as bare STRINGS, which makes
                    // `option.label` — and therefore the key — `undefined`.
                    <div key={index}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="default"
                        disabled={busy}
                        onClick={() => toggleOption(question, index)}
                        className={cn(ASK_OPTION_WALL, ASK_OPTION_ROW, {
                          "bg-interaction-ask-fill": selected,
                        })}
                      >
                        {question.multi ? (
                          <span
                            aria-hidden
                            className={
                              selected
                                ? "text-interaction-ask-foreground"
                                : "text-foreground-subtlest"
                            }
                          >
                            {selected ? "☑" : "☐"}
                          </span>
                        ) : (
                          <span
                            aria-hidden
                            className={
                              selected
                                ? "text-interaction-ask-foreground"
                                : "text-foreground-subtlest"
                            }
                          >
                            {selected ? "●" : "○"}
                          </span>
                        )}
                        <span
                          className={cn(
                            "min-w-0 [overflow-wrap:anywhere]",
                            selected
                              ? "text-interaction-ask-foreground"
                              : "text-foreground",
                          )}
                        >
                          {option.label}
                          {recommended && RECOMMENDED_TAG}
                        </span>
                      </Button>
                      {selected && (
                        <input
                          value={d.notes[index] ?? ""}
                          onChange={(e) =>
                            updateDraft(question.id, (dd) => ({
                              ...dd,
                              notes: {
                                ...dd.notes,
                                [index]: e.target.value,
                              },
                            }))
                          }
                          placeholder="note (optional)"
                          className="ml-6 mt-1 w-3/4 rounded-md border-input-border bg-input px-2 py-0.5 text-ui-xs outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused"
                        />
                      )}
                    </div>
                  );
                })}
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="default"
                    disabled={busy}
                    onClick={() => toggleOther(question)}
                    className={cn(ASK_OPTION_WALL, ASK_OPTION_ROW, {
                      "bg-interaction-ask-fill": d.other,
                    })}
                  >
                    {question.multi ? (
                      <span
                        aria-hidden
                        className={
                          d.other
                            ? "text-interaction-ask-foreground"
                            : "text-foreground-subtlest"
                        }
                      >
                        {d.other ? "☑" : "☐"}
                      </span>
                    ) : (
                      <span
                        aria-hidden
                        className={
                          d.other
                            ? "text-interaction-ask-foreground"
                            : "text-foreground-subtlest"
                        }
                      >
                        {d.other ? "●" : "○"}
                      </span>
                    )}
                    <span
                      className={cn(
                        "[overflow-wrap:anywhere]",
                        d.other
                          ? "text-interaction-ask-foreground"
                          : "text-foreground",
                      )}
                    >
                      {OTHER_OPTION}
                    </span>
                  </Button>
                  {d.other && (
                    <input
                      value={d.otherText}
                      onChange={(e) =>
                        updateDraft(question.id, (dd) => ({
                          ...dd,
                          otherText: e.target.value,
                        }))
                      }
                      placeholder="Type your own answer"
                      className="ml-6 mt-1 w-3/4 rounded-md border-input-border bg-input px-2 py-0.5 text-ui-xs outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused"
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Final batch review for multi-question asks. */}
      {questions.length > 1 && (
        <div className="mt-3 rounded-md bg-surface p-2">
          <p className="text-ui-xs font-medium text-foreground-subtle">Review</p>
          <ul className="mt-1 space-y-0.5">
            {questions.map((question, questionIndex) => {
              const d = draft(question.id);
              const parts: string[] = [];
              for (const index of d.selected) {
                const label = question.options[index]?.label ?? "";
                const note = d.notes[index]?.trim();
                parts.push(note ? `${label} - ${note}` : label);
              }
              if (d.other) {
                parts.push(
                  d.otherText.trim() ? `Other: ${d.otherText.trim()}` : "Other",
                );
              }
              return (
                <li
                  key={questionIndex}
                  className="text-ui-sm [overflow-wrap:anywhere] text-foreground-subtle"
                >
                  {question.question}:{" "}
                  {parts.length > 0 ? parts.join(", ") : "—"}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Footer hints + actions. */}
      <div
        data-testid="ask-footer"
        className="mt-3 flex items-center justify-between gap-2 px-3 pb-3"
      >
        <MutedCaption as="p">Enter submit · Esc cancel</MutedCaption>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void respond(true)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || !canSubmit}
            onClick={() => void respond(false)}
          >
            Submit
          </Button>
        </div>
      </div>
      {error && <IpcErrorLine error={error} className="px-3 pb-2" />}
    </div>
  );
}
