---
status: approved
issue: https://github.com/danielcherubini/archimedes/issues/75
done-when: With a Space open and a Session that has no messages, `pnpm tauri dev` shows the Archimedes ASCII film in the transcript area instead of "Send a prompt to start"; dragging the window to any shape leaves the figure undistorted and the film centred, with no visible bars and the pane's own background showing at the edges; Settings → Appearance → "Empty-session animation" → Off restores the text line. `pnpm test` and `pnpm build` are green at the repo root; `cargo test`, `cargo clippy --all-targets` (0 warnings) and `cargo fmt --check` are green in `src-tauri/`. One manual pass on Linux with `WEBKIT_DISABLE_DMABUF_RENDERER=1` reaches the text line rather than a blank pane.
---

# Empty-state ASCII film — spec

**Goal:** Replace the **Transcript**'s **empty state** hint with a live ASCII rendering of the Archimedes-and-the-lever film — real glyphs drawn at runtime, coloured by a theme token, on a transparent canvas so it sits on the pane's own background — sized dynamically to the pane at a fixed aspect ratio.

**Architecture:** Three modules with a luminance-array seam. `src/lib/archimedes-film/scene.ts` owns three.js (offscreen, never in the DOM) and produces a `Float32Array` of per-cell luminance. `src/lib/archimedes-film/compositor.ts` turns that array into glyphs and knows nothing about three. `src/components/chat/EmptyStateFilm.tsx` is the React shell: resize, frame loop, visibility gating, and the four-state machine. `MessageList`'s empty branch gains one child. The fallback state reuses today's markup verbatim, so a machine with no working GL gets a working **empty state** rather than a void (ADR 0070).

**Tech stack:** React 19 + TypeScript, three.js (`0.186.1`, exact pair with `@types/three@0.186.0`, dynamically imported), Canvas 2D, Tailwind v4 theme tokens, Vitest + Testing Library (jsdom). Rust: one `Option<String>` settings field.

**Decisions:** ADR 0070 (offscreen WebGL, output-based liveness, three pinning) and ADR 0071 (the film's own opaque palette token, transparent compositing).

---

## 1. Integration point

`src/components/chat/MessageList.tsx:184-198` — the `units.length === 0` branch. The film is an absolutely-positioned layer of the existing scroll `div` (`data-testid="transcript-scroll"`, `emptyRef`), rendered under the **unchanged** suppression condition `!hasPendingRequest && !workingOrInTurn && agentState !== "blocked"`. `TranscriptFooter` keeps rendering in the same container, above the film layer, so permission/`ask`/child gates stay visible over it. `ChatStream` (`ChatStream.tsx:1565`) is the only mount site — `SubagentTranscript` does not use `MessageList` — so there is one integration point and no subagent-sheet film.

`emptyRef`'s existing scroll effect (`MessageList.tsx:145-146`) is untouched; the film layer is `position: absolute` + `pointer-events: none` so it never affects scroll height.

## 2. The four states, in precedence order

| State | Condition | Renders |
|---|---|---|
| `off` | `emptyStateAnimation === "off"` | the text line |
| `static` | `prefers-reduced-motion: reduce`, otherwise `emptyStateAnimation === "static"` | one frame at t ≈ 6.5 s (mid-heave), no rAF |
| `film` | `emptyStateAnimation` is `"animated"` or `null`, **and** a WebGL2 target was acquired, **and** the first composited frame drew ≥ 1 cell | the film, no caption |
| `fallback` | anything else (no WebGL2, context lost, zero-cell frame, engine construction threw) | today's markup, unchanged |

`prefers-reduced-motion` may only **reduce**, never enable: it can pin `animated` to `static`, but it cannot un-`off` a deliberate Off. The two-cue case is decided by that ordering, so the OS preference wins over the setting only in the direction of less motion.

`aria-hidden="true"` on the canvas and its wrapper — the film is decoration (the convention `braille-loader.tsx:103` already follows). There is no caption, so no text-contrast obligation (WCAG 1.4.3 does not apply); WCAG 2.2.2's pause/stop/hide mechanism is the Settings control.

**The liveness check** is behavioural, per ADR 0070: composite one frame, and if zero cells were drawn, treat the renderer as dead and go to `fallback`. Capability probing is not used because WebKitGTK masks the renderer string and software-backed context creation reports success.

## 3. Geometry and fit

- **Grid**: 230 × 115 cells at the largest tier. `CHAR_RAMP` is the demo's 68-character ramp (verified length), ordered by perceptual density.
- **Aspect is not a free parameter**: the film's own aspect is `230 × 0.58 ÷ 115 = 1.16`, fixed by the camera the demo builds (`(GRID_COLS * 0.58) / GRID_ROWS`, where `0.58` is a monospace cell's width/height ratio). Drawing into any other box stretches the figure.
- **Fit = contain**: the largest 1.16-aspect box that fits the pane, centred. **There are no letterbox bars to see**, because the canvas keeps its alpha channel and cells below threshold emit no draw call — `--color-chat` shows through the bars, the margins, and the vignette-faded frame edge alike (ADR 0071).
- **Adaptive grid tiers**: below a ~4 px cell-height floor the grain stops reading as characters while the cost stays identical, so the grid steps down a notch (230×115 → 160×80 → 115×58; `COLS` stays `2 × ROWS`). Buffers, the render target and the font size are rebuilt only on a **tier** change, not on every resize event. Measured contain boxes: 800×600 → 696×600 (cells 3.03×5.22), 1200×400 → 464×400 (2.02×3.48, so tier 2), 600×900 → 600×517.
- **Resize**: a rAF-coalesced `ResizeObserver` on the scroll container (precedent `Reasoning.tsx:348`, `ChangesGroupCard.tsx:133`). The demo's `outputCanvas.width = window.innerWidth` is **deleted** — sizing to the window is precisely wrong inside a resizable pane.
- **DPR**: backing store = css size × `devicePixelRatio`, capped at 2. The demo has no DPR handling, so on a 2× display the browser upscales and every glyph is blurry.
- **Font**: the demo derives `fontSize` from cell **height** (`1.08 * ch`) while placing glyphs at cell **width** (`cw`); the two agree only by luck with Courier New. The port measures the advance once with `ctx.measureText("M")` against the app's `--font-mono` (Fira Code by default, user-changeable) and derives `fontSize = cellW / advanceRatio`, so glyphs land on the cell grid for any chosen font. Re-measured on font change.

## 4. The scene (`scene.ts`)

Ported from `/home/daniel/Downloads/archimedes_cinematic_ascii_film.html` — the ground plane, fulcrum cone, noise-displaced icosahedron boulder, per-frame-bent lever, the hand-built articulated figure with 2-bone IK (`solveLimbIK`), the debris particle pool, the light-shaft cone, `FogExp2`, and the 10.5 s `evaluateChoreography` loop with phase boundaries at 1.8 / 4.6 / 7.6 / 9.0 s. No React, and it creates its own canvas.

Concrete deltas from the demo, each a fix rather than a style choice:

1. **No `preserveDrawingBuffer`, no `gl.readPixels`.** Read into a `WebGLRenderTarget` via `renderer.readRenderTargetPixels`. The demo's path is a synchronous GPU stall — headless Chrome logs `GPU stall due to ReadPixels` running it unmodified.
2. **Every light intensity is re-tuned.** The demo is r128; from r155 `useLegacyLights` defaults to false and spot/point intensity and decay changed meaning, so `SpotLight(…, 2.9)` and its siblings will not read the same. This is the port's one piece of judgement work — tune against the reference frame, not against the code.
3. **The lever keeps its bend but not a per-frame normal rebuild.** `computeVertexNormals()` over 864 triangles every frame is dropped; precompute once and offset, since the visual difference at 230×115 is nil.
4. **`renderer.dispose()` and `forceContextRestore()` handling**: dispose on teardown (browsers cap live contexts near 16); `webglcontextlost` → `preventDefault` + go to `fallback`.

Public surface: `createFilmEngine(canvasHost) → { resize(cssW, cssH, dpr, tier), frame(elapsedSec) → Float32Array, drawCallsForLastFrame: number, dispose() }`. `evaluateChoreography` and `solveLimbIK` stay **pure and exported** so the maths is testable with no GL (Task 2).

## 5. The compositor (`compositor.ts`)

Owns the ramp, the Sobel rule, the 8-band colour quantisation, run-batched `fillText`, grid tiers, contain maths and DPR. Pure w.r.t. three.js: takes a luminance grid, emits draw calls.

- **Bands + run batching** are the difference between 12 ms and 3 ms per frame (both measured): the demo sets `fillStyle` per glyph, and colour-string churn dominates. Cells of equal band on a row collapse into one `fillText` per run.
- **Skip, never clear**: cells under ~0.015 luminance draw nothing, and the context is created with `alpha: true`. The demo's `alpha: false` and its full-canvas black `fillRect` are **deleted** — that is the transparency mechanism, and it also removes the visible-rectangle problem (`--color-chat` is `neutral-800` at 60%, not `#000`).
- **Sobel → directional glyphs** (`/ _ \ |` above magnitude ~0.22) preserved verbatim, plus the vignette and the `pow(lum, 1.85)` contrast curve.
- **Colour**: quantise to 8 bands of the resolved token. Token resolution goes through a probe element's computed `color` — `getPropertyValue` returns an unresolved `color-mix(...)` that canvas `fillStyle` cannot parse (both verified, ADR 0071). Re-resolved on theme/palette change.

## 6. Frame loop and idle cost (`EmptyStateFilm.tsx`)

**24 fps via a time accumulator**, not free-running rAF (the demo free-runs; ~26,450 lit cells at 230×115 do not need 60). Loop stops on `visibilitychange` / `document.hidden`, window `blur`, and `IntersectionObserver` (`isIntersecting === false`) — rAF pausing is unreliable in a webview (`wry#204`: 12% CPU minimised; `SIZE_MINIMIZED` is a no-op in wry), so all three are explicit. Engine disposed on unmount.

## 7. Settings

Mirrors `spinnerStyle` exactly — same field shape, same defaulting story, no migration.

- `src-tauri/src/config.rs`: `empty_state_animation: Option<String>` with `#[serde(default)]`, added to the `Default` impl, plus a test in the shape of `spinner_style_defaults_to_none_and_round_trips` (absent key → `None`; explicit value survives a camelCase round trip).
- `src/lib/tauri.ts`: `AppSettings.emptyStateAnimation: string | null`.
- `src/components/settings/AppearanceSection.tsx`: a `SettingsRow` labelled **Empty-session animation** beside "Thinking spinner", `controlLayout="wide"`, control a 3-option `role="radiogroup"` (Off / Static / Animated) with `aria-checked`, following `SpinnerStylePicker`'s shape in `controls.tsx`.
- **Default `null` → Animated**, visible on first launch; `prefers-reduced-motion` still pins it static with no setting involved.

## 8. Theme token

A new palette-owned **opaque** token (`--color-film-glyph`, name to be confirmed against `themeTokens.test.ts`'s conventions) per ADR 0071: `@theme`, `.dark`, `.theme-zai-light` and `.theme-zai-dark` alias to an existing reading so zai renders byte-identically; `.theme-dracula` gets its own hex. Added to `MEANINGFUL_TOKENS` and to an `it.each`-per-layer readings table in `src/lib/themeTokens.test.ts`, in the shape of `ROW_READINGS`, so a palette that omits it fails by name instead of silently inheriting grey.

## 9. Testing

**The seam is the injection point.** jsdom returns `null` for both `getContext("2d")` and `getContext("webgl2")` (measured), and stubbing `WebGLRenderer` against a fake GL would test our stub rather than our code. So `EmptyStateFilm` takes `createEngine` as a prop defaulting to the real factory, and tests pass a fake emitting deterministic luminance grids. The real engine is never constructed in jsdom — which is also why `fallback` is what jsdom renders for free.

- **`compositor.test.ts`** — asserts the *decisions*, not the plumbing: a dark cell produces **zero** draw calls (that is the transparent-blends-into-theme requirement, stated as an observable); contain maths yields the 1.16 box and never a stretched one; band quantisation collapses a row into one `fillText` per run; the 68-entry ramp maps luminance → glyph; Sobel magnitude past the threshold yields `/ _ \ |`; tiers step down at the cell-height floor; backing store = css size × dpr with the cap.
- **`scene.test.ts`** — GL-free maths only: `evaluateChoreography` at the 1.8 / 4.6 / 7.6 / 9.0 s boundaries and the lift/push/bend/shake curves; `solveLimbIK` reachability clamps. These are the functions most likely to break in the r128→r186 translation and none need a GPU.
- **`EmptyStateFilm.test.tsx`** — one test per precedence rule (off beats reduced-motion; reduced-motion beats static; static beats film; each `fallback` trigger), `prefers-reduced-motion` via the full `matchMedia` stub already proven in `braille-loader.test.tsx:16`, `webglcontextlost` → fallback, zero-cell → fallback, construction throw → fallback, `dispose()` on unmount, and each of the three idle gates cancelling rAF. `aria-hidden="true"`.
- **`MessageList` tests** — the 4 existing `"Send a prompt to start"` assertions stay green untouched (jsdom lands on `fallback`). Add one asserting the string is **absent** when the film is active, so the no-caption decision is pinned rather than implied.
- **`themeTokens.test.ts`** — per-layer `it.each` for the new token plus a non-vacuity assertion, matching the `--color-row-icon` gate.
- **`config.rs`** — the round-trip/`None` test named above.

## 10. Out of scope

No click-to-toggle on the film (the demo's click-to-invert is dropped — clicking the empty pane should stay inert). No interactivity, no camera response, no audio, no reduced asset. No film in the **Subagent** transcript sheet. No change to the **working indicator** or its `spinnerStyle` setting.
