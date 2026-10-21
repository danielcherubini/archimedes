---
status: accepted
date: 2026-10-21
superseded-by:
---

# The empty-state film paints with its own opaque token, because the muted text tokens carry alpha

The **Transcript**'s **empty-state film** draws tens of thousands of glyphs per frame whose *brightness is the data* — luminance picks both the glyph and its intensity. The obvious colour is `--color-foreground-subtlest`, which is what the caption it replaced used. We decided against it: that token resolves to `oklab(0.278 -0.0067 -0.0288 / 0.4)` (measured), and a glyph that is already dimmed by its own luminance band and then again by a 40% alpha lands near invisible over `--color-chat`. The film gets its **own** token, deliberately **opaque**, so the bands are the only dimming mechanism. Following ADR 0062, it is palette-owned: the four non-Dracula layers alias to an existing reading so zai renders byte-identically, and `.theme-dracula` gets its own hex.

## The two-mechanisms trap

`--color-foreground-subtlest` was chosen for text sitting on a solid pane, where alpha is a reasonable way to say "quiet". A film cell is not that. Its value already encodes how lit the surface is, so stacking a second multiplicative dimmer on top compresses the whole dynamic range into the bottom few percent and flattens the chiaroscuro that makes the film readable. The token being opaque is not a preference, it is the thing that keeps one dimming axis in charge.

## Considered Options

- **Paint with `--color-foreground-subtlest` and add nothing (rejected).** Zero palette churn — and it silently multiplies two independent dimmers, so any future palette that adjusts that text token's alpha re-tunes the film by accident.
- **Paint with `--color-foreground` at full strength (rejected).** Opaque, but it is the token for primary text, so a decorative animation becomes hostage to the token that governs readability of actual prose.
- **Hardcode the demo's `rgb(v,v,v)` ramp in the compositor (rejected).** It was the demo's own approach and it is the pattern ADR 0062 exists to retire: scattering a literal through a component makes a palette owner unable to move it and invisible to `themeTokens.test.ts`.

## Consequences

- A token's *value* cannot always be read straight off the custom property: `getComputedStyle(documentElement).getPropertyValue('--color-foreground-subtlest')` returns the unresolved string `color-mix(in oklab, #1f2937 40%, transparent)`, which canvas `fillStyle` will not parse. The compositor resolves it through a probe element's computed `color`, which yields `oklab(…)` and round-trips through `fillStyle` (both verified in headless Chrome). Any future canvas-or-SVG-from-token work needs the same indirection.
- The token joins the `themeTokens.test.ts` per-layer table so a palette that omits it fails by name instead of silently inheriting grey — the `--color-row-icon` / `--color-row-verb` gate, in the same shape.
- The film composites onto the pane rather than over a filled rectangle: dark cells emit **no** draw call and the 2D canvas keeps its alpha channel, so `--color-chat` shows through. That is why the film needs no letterbox bars and no scrim, and why the demo's `alpha: false` context and its full-canvas black `fillRect` are both deleted in the port.
