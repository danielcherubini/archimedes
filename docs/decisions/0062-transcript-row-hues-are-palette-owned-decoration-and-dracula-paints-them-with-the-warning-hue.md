---
status: accepted
date: 2026-10-18
superseded-by:
---

# Transcript-row hues become palette-owned decoration, and Dracula paints them with `--color-warning`'s hex

The request was "make the tool icons orange and the verbs light blue, and create a token we can reuse when changing themes." We decided: add two palette-owned tokens — `--color-row-icon` and `--color-row-verb` — named for `TRANSCRIPT_ROW`, the class constant the `Thought` row, the tool rows and the `Changes` group already share, aliased back to their current readings in every palette except `.theme-dracula`, which gives them `#ffb86c` and `#8be9fd`; and delete the dead `--color-trajectory-*` family in the same change rather than ship a second row-hue family beside it.

This cuts against ADR 0027, which classes transcript-row hues as **Identity colors** — hues that encode *what kind of thing this is* and are therefore **never** re-hued by a **Palette**. Two things about that placement were worth recording, because both look like defects afterwards.

## The row tokens are decoration, not identity

`--color-trajectory-*` split by **row kind** (`-user`, `-assistant`, `-reasoning`, `-tool-call`, `-tool-result`): the hue answered "which kind of row is this?", which is exactly the identity question 0027 was protecting. The new pair splits by **role within a row** — glyph versus verb — uniformly across all three `TRANSCRIPT_ROW` consumers. It encodes nothing about what the row *is*: every tool icon gets one hue and every verb another, so removing the hue loses no information. A token whose value carries no meaning is decoration, and decoration is what a **Palette** exists to re-hue. That is the distinction 0027's rule turns on, and it is why these two tokens belong to the palette while `git-*` and the role chips do not.

The alias-back is what makes the change free where it should be free: `@theme`, `.dark`, `.theme-zai-light` and `.theme-zai-dark` all read `var(--color-foreground-subtle)` / `var(--color-foreground-subtlest)` — today's values — so zai renders byte-identically. `.theme-dracula` is the only block with its own reading. This is the `--color-context-track` precedent, which was split out of a text token the same way and aliased straight back in every palette but Dracula's.

## The warning-hue collision is accepted, and looks like a bug

Under Dracula `--color-row-icon` is `#ffb86c`, which is **verbatim `--color-warning`** — the hue the context bar's 70–89% fill, the stalled-session banner, the new-session error banner, `SessionStatusMark` and the todo/pending dots all wear. A decorative terminal icon and an alarm dot are now the same pixel colour, so orange stops meaning only "needs attention".

Nothing in CI can catch this. `themeTokens.test.ts`'s hex-collision gate compares the **thinking ramp** against the status tokens and nothing else, so a decorative family riding a status hex passes it silently. The mitigation is therefore a test that pins both hexes of the new family per palette — not to assert the collision is absent, which it is not, but to make a later "cleanup" that collapses these onto `--color-warning` / `--color-interaction-ask-foreground` fail by name instead of shipping.

The collision is reversible in one line, which is the whole argument for taking it: the token turns "the icon happens to be that orange" into a named slot a palette owner can move. Scattering the hex through components would have made the same choice irreversible and invisible.

## Considered Options

- **Paint the icons with `--color-warning` and the verbs with the existing cyan token, adding nothing (rejected).** Zero palette churn and no completeness-count edits — and it hard-wires decoration to a status token, so any theme that re-hues `warning` silently re-colours every tool icon. The request was explicitly for something reusable across themes; a status token is reusable only by accident.
- **Add the tokens but nudge Dracula's icon orange off `#ffb86c` to restore the warning signal's exclusivity (rejected).** Buys back the alarm hue's uniqueness and costs the exact value that was asked for. The hue is a spec-published Dracula orange, so the spec gate passes either way — the only thing deciding it was the collision, and the collision is one line wide.
- **Keep `--color-trajectory-*` and reuse it (rejected).** Wrong axis (row kind, not glyph/verb), and `--color-trajectory-tool-call`'s dark reading is `#f59e0b` — already an orange, so it would have sat beside `#ffb86c` as a near-twin, two oranges one of which means "tool" and one of which means "warning". It is also unconsumed: no component or `src/lib` module has ever referenced `trajectory`, and only `paletteCompleteness.test.ts`'s `INHERITED` list kept the five names alive.
- **Add the pair and leave the dead family alone as a follow-up (rejected).** `CONTEXT.md`'s **Identity color** entry cites `--color-trajectory-*` as live. Shipping a second "transcript row hue" family beside a phantom one that the glossary advertises as real is how the next reader ends up choosing between two things, one of which renders nowhere.

## Consequences

- **The `INHERITED` list shrinks and the declaration counts move in opposite directions, so a partial edit fails loudly.** Deleting five inherited tokens takes `INHERITED` 59 → 54 and `ZAI_DARK.size` 170 → 167; adding two palette-owned tokens takes `--theme-dracula` 117 → 119 and `diff(DARK, INHERITED)` 92 → 94. The cross-check `ZAI_DARK − DRACULA == INHERITED − 6` holds at 48 == 48 only if both halves land. This is a useful property, not an obstacle: it is the completeness gate doing its job.
- **`CONTEXT.md`'s Identity color entry is corrected here, and ADR 0027's body is not touched.** 0027 names `trajectory-*` in its identity rule and in its amendment; `docs/decisions/` is append-only, so those mentions stay as written and this document is what records the deletion. The glossary is a living document and its entry is fixed. A reader of 0027 alone will see a deleted token named — this ADR is the answer to "why is that not in the CSS?"
- **A pending tool call keeps the shimmer, not the verb hue.** `animated-gradient-text` is the "this call is working" cue and outranks a static colour while `status === "pending"`; `--color-row-verb` applies once the call settles. A future reader should not "simplify" the verb to one colour and lose the motion signal.
- **Any future row hue must state which axis it splits on.** The failure mode here was two families with similar names splitting on different axes, one of them dead. Row kind is identity and stays inherited; role within a row is decoration and belongs to the palette. Say which in the token's comment.

## Amendment (same change, before it shipped)

**Correction 1: "zai renders byte-identically" is too strong — the `Thought` glyph moves, and that is the intended outcome.**

The body above claims the alias-back leaves zai "byte-identically". It does leave every *token* reading identical, and every row of zai renders as it did, with **one glyph** as the exception, and the reason is an asymmetry in the three consumers that the family's naming exposes.

The three `TRANSCRIPT_ROW` glyphs did not agree with each other before this change: `ToolCallCardHeader`'s icon and `ChangesGroupCard`'s icon both read `text-foreground-subtle`, while `Reasoning`'s `BrainIcon` read `text-foreground-subtlest` — one step dimmer than its two siblings for no recorded reason. A single `--color-row-icon` token can only hold one value, and the alias takes `--color-foreground-subtle`, so the `Thought` brain glyph becomes very slightly more opaque under zai. Measured on the zai dark page that is `foreground-subtle` at 60% instead of 30% of the same foreground; nothing about the row's layout, size or wording moves.

This is a **fix, not a regression**, and it is the argument for naming the token after the shared row class rather than after `ToolCall`: the three glyphs are the same affordance in three components, and a token that describes the row cannot express the drift that let them disagree in the first place. Recording it here rather than silently widening the claim keeps "the alias is free" checkable — it is free in four of five layers and costs one glyph's opacity everywhere, which is precisely the price of making three siblings agree.

The `--color-row-verb` half has no such asymmetry: all three verbs/labels (`Ran`/`Edited`, `Changes`, `Thought`) already read `text-foreground-subtlest`, so aliasing to that token is byte-identical for every verb in every palette but Dracula's.
