---
status: committed
issue: https://github.com/danielcherubini/archimedes/issues/75
done-when: With a Space open and a Session that has no messages, `pnpm tauri dev` shows the Archimedes ASCII film in the transcript area instead of "Send a prompt to start"; dragging the window to any shape leaves the figure undistorted and the film centred, with no visible bars and the pane's own background showing at the edges; Settings → Appearance → "Empty-session animation" → Off restores the text line. `pnpm test` and `pnpm build` are green at the repo root; `cargo test`, `cargo clippy --all-targets` (0 warnings) and `cargo fmt --check` are green in `src-tauri/`. One manual pass on Linux with `WEBKIT_DISABLE_DMABUF_RENDERER=1` reaches the text line rather than a blank pane.
---

# Empty-state ASCII film Plan

**Goal:** Replace the **Transcript**'s **empty state** hint with a live ASCII rendering of the Archimedes-and-the-lever film — real glyphs drawn at runtime, coloured by a theme token, on a transparent canvas so it sits on the pane's own background — sized dynamically to the pane at a fixed aspect ratio.

**Architecture:** Two library modules with a luminance-array seam. `src/lib/archimedes-film/scene.ts` owns three.js (offscreen, **never in the DOM**) and produces a `Float32Array` of per-cell luminance. `src/lib/archimedes-film/compositor.ts` turns that array into glyphs and knows nothing about three. `src/components/chat/EmptyStateFilm.tsx` is the React shell: resize, 24 fps frame loop, visibility gating, and the four-state machine (`off` / `static` / `film` / `fallback`). `MessageList`'s empty branch gains one child. The fallback state reuses today's markup verbatim, so a machine with no working GL gets a working **empty state** rather than a void (ADR 0070).

**Tech stack:** React 19 + TypeScript, three.js (`0.186.1`, exact pair with `@types/three@0.186.0`, dynamically imported), Canvas 2D, Tailwind v4 theme tokens, Vitest + Testing Library (jsdom). Rust: one `Option<String>` settings field.

**Decisions:** ADR 0070 (`docs/decisions/0070-the-films-webgl-surface-never-enters-the-dom-and-liveness-is-judged-by-output.md` — offscreen WebGL, output-based liveness, pair pinning) and ADR 0071 (`0071-the-empty-state-film-paints-with-its-own-opaque-token.md` — the film's own opaque palette token, transparent compositing).

**Source of the film:** `/home/daniel/Downloads/archimedes_cinematic_ascii_film.html` (~780 lines, three.js r128 from a CDN). It is the port's reference. Tasks 4 and 5 read it directly; nothing in this plan paraphrases its maths, so read the file rather than guessing from this document.

**Validation bar** (`AGENTS.md`): `pnpm test` and `pnpm build` from the repo root; `cargo test`, `cargo clippy --all-targets` (0 warnings) and `cargo fmt --check` from `src-tauri/`. There is no frontend formatter or linter configured (`package.json` has no `lint`/`format` script), so no JS format/lint step appears below. Rust checks appear only in Task 1, the one task that touches a `.rs` file.

---

## Measured facts this plan relies on

Do not re-derive these; they were measured during planning. If one turns out to be false during execution, **stop and report** — several tasks are shaped by them.

1. **jsdom returns `null` from `getContext("2d")` and `getContext("webgl2")`** (and logs `Not implemented: HTMLCanvasElement's getContext()`). So the real engine can never be constructed under test, and the component's `fallback` branch is what jsdom renders for free. This is why the engine is an injected factory.
2. **jsdom has NO `ResizeObserver`, NO `IntersectionObserver`, NO `window.matchMedia`.** `requestAnimationFrame` exists, `devicePixelRatio` is `1`. Every one of those four must be feature-guarded with `typeof` before use — the repo already does this in `Reasoning.tsx:345` (`typeof ResizeObserver === "undefined"`) and `theme.ts:16` (`typeof window.matchMedia !== "function"`). An unguarded use throws in every test.
3. **`three@0.186.1` ships ZERO `.d.ts` files** (verified from the npm tarball); types come from the separate `@types/three@0.186.0`. Both are needed and must move together, exactly as `AGENTS.md` pins `@tauri-apps/cli` to the `tauri` version.
4. **`getComputedStyle(html).getPropertyValue("--color-foreground-subtlest")` returns `color-mix(in oklab, #1f2937 40%, transparent)`** — canvas `fillStyle` cannot parse that. Reading a *probe element's computed `color`* returns `oklab(0.278074 -0.00672175 -0.0288133 / 0.4)`, which `fillStyle` accepts and round-trips. Both verified in headless Chrome. Note the `/ 0.4` alpha — that is why the film needs its own opaque token (ADR 0071).
5. **The film's aspect ratio is `230 × 0.58 ÷ 115 = 1.16`**, fixed by the demo's camera (`(GRID_COLS * 0.58) / GRID_ROWS`, where `0.58` is a monospace cell's width/height ratio). Drawing into any other box stretches the figure. Contain boxes: 800×600 → 696×600 (cells 3.03×5.22 px), 1200×400 → 464×400 (2.02×3.48), 600×900 → 600×517.
6. **`CHAR_RAMP` is 68 characters** long (`. → █`). The demo's per-glyph `fillStyle` costs ~12 ms/frame at 230×115 (~26,450 lit cells); 8-band colour quantisation with per-run `fillText` costs ~3 ms.
7. **Headless Chrome renders the demo's scene on SwiftShader and screenshots it**: `google-chrome --headless=new --disable-gpu --use-angle=swiftshader --no-sandbox --window-size=928,800 --virtual-time-budget=6500 --screenshot=/tmp/ref.png file://<demo.html>`. This is how the re-light reference frame is captured (Task 4). It also logs `GPU stall due to ReadPixels`, which is the readback defect Task 4 removes.
8. **Adding a required field to the TypeScript `AppSettings` breaks 10 test files** (below) — `tsconfig.json` sets `strict: true` and `pnpm build` runs `tsc`. They are all updated in Task 1, the same task that adds the field, so no intermediate commit is red.

   `src/App.test.tsx`, `src/components/AgentsDialog.test.tsx`, `src/components/ChatStream.test.tsx`, `src/components/MessageBubble.codeblock.test.tsx`, `src/components/settings/SettingsPage.test.tsx`, `src/components/settings/WebSearchSection.test.tsx`, `src/components/SpacesList.test.tsx`, `src/hooks/useAttentionAlert.test.ts`, `src/lib/settings.test.ts`, `src/store/settings.test.ts`

9. **Adding a token to every palette layer moves exactly three hard-coded counts** in `src/lib/paletteCompleteness.test.ts`: `DRACULA` `119 → 120`, `diff(DARK, INHERITED)` `94 → 95`, `ZAI_DARK.size` `167 → 168`. The cross-check `ZAI_DARK.size - DRACULA.size === INHERITED.length - 6` (48 == 48) is count-neutral and must stay untouched.
10. **The palette layer blocks are** `@theme` (`theme.css:2`), `.dark` (`theme.css:238`), `.theme-zai-light` (`theme.css:419`), `.theme-zai-dark` (`theme.css:571`), `.theme-dracula` (`dracula.css:204`). The `--color-row-icon` family (ADR 0062) is declared in **all five** — that is the pattern to copy.

---

## Parallelisation

**Verdict:** PARALLEL — 4 waves

- **Wave 1: Task 1, Task 2, Task 3** — pairwise disjoint file sets (verified against `Files:` lists below), no cross-imports. Task 1 is Rust + `lib/tauri.ts` + settings fixtures, Task 2 is `src/styles/*.css` + the two palette test files, Task 3 is `archimedes-film/compositor.ts` + its test. Task 3's test takes a colour **string** as a parameter and must NOT read CSS (that would create a gate-2 edge to Task 2).
- **Wave 2: Task 4** — alone, because `pnpm add` rewrites `package.json` and `pnpm-lock.yaml` (gate 3, shared mutable artifact; gate 5, lockfile regeneration).
- **Wave 3: Task 5** — needs Task 3's `compositor` and Task 4's `scene` to exist (gate 2).
- **Wave 4: Task 6, then Task 7** — Task 6 edits `MessageList.tsx` (what Task 5 creates mounts into) and `SettingsPage.test.tsx` (which Task 1 edited), so it cannot join an earlier wave. Task 7 is the full-suite run, which gate 4 makes serial by definition.

The win is one wave of three; it is declared with its reason rather than assumed.

---

### Task 1: The `emptyStateAnimation` setting (Rust → TS → fixtures)

**Parallel:** wave 1 — disjoint from Task 2 (`src/styles/theme.css`, `src/styles/dracula.css`, `src/lib/themeTokens.test.ts`, `src/lib/paletteCompleteness.test.ts`) and Task 3 (`src/lib/archimedes-film/compositor.ts`, `src/lib/archimedes-film/compositor.test.ts`)

**Context:**
The film needs a user-facing pause/stop/hide control, because WCAG 2.2.2 (level A) applies to auto-running decoration and a decorative loop must be stoppable by the user, not only by the OS preference. The setting follows the existing `spinnerStyle` field in shape and in defaulting story — a nullable string with `#[serde(default)]`, so a `settings.json` written before this feature parses to `None` and no migration is needed. `None` on the TS side means the app default, which for this setting is **animated**: the film is visible on first launch, and `prefers-reduced-motion` still pins it static with no setting involved (ADR 0070). This task only carries the value end-to-end; no component reads it until Task 6, so nothing user-visible changes here.

The TypeScript field is **required** (`emptyStateAnimation: string | null`, not optional) — the same choice `spinnerStyle` and every map field in `AppSettings` make, because a field the backend always serializes must not arrive as `undefined`. Consequence: `tsc` fails on the 10 test fixtures listed in fact 8, so they are updated in this same task.

**Files:**
- Modify: `src-tauri/src/config.rs`
- Modify: `src/lib/tauri.ts`
- Modify: `src/App.test.tsx`, `src/components/AgentsDialog.test.tsx`, `src/components/ChatStream.test.tsx`, `src/components/MessageBubble.codeblock.test.tsx`, `src/components/settings/SettingsPage.test.tsx`, `src/components/settings/WebSearchSection.test.tsx`, `src/components/SpacesList.test.tsx`, `src/hooks/useAttentionAlert.test.ts`, `src/lib/settings.test.ts`, `src/store/settings.test.ts`

**What to implement:**

In `src-tauri/src/config.rs`, immediately after the `spinner_style` field (line ~274), add a field with the same shape:

```rust
/// The **Transcript**'s empty-state animation: `"off"` / `"static"` /
/// `"animated"`. `None` = the frontend's `"animated"` default (a
/// pre-feature file — `#[serde(default)]`, no migration). `prefers-reduced-motion`
/// can pin `"animated"` to `"static"` but can never un-`off` a deliberate
/// `"off"` (ADR 0070).
#[serde(default)]
pub empty_state_animation: Option<String>,
```

The struct carries `#[serde(rename_all = "camelCase")]` (line 29), so the wire key is `emptyStateAnimation` — do not add a `rename`. Add `empty_state_animation: None,` to the `Settings::default()` impl (next to `spinner_style: None,`, line ~343).

In `src/lib/tauri.ts`, in `interface AppSettings` (line ~541), immediately after `spinnerStyle`, add:

```ts
/** The empty-state animation (`"off"` / `"static"` / `"animated"`); `null` = the `"animated"` default. `prefers-reduced-motion` may pin `"animated"` to `"static"`, never un-`off` a deliberate `"off"` (ADR 0070). */
emptyStateAnimation: string | null;
```

In each of the 10 test files: add `emptyStateAnimation: null,` **next to every existing `spinnerStyle:` line** (13 sites total — `SettingsPage.test.tsx` has 6, `ChatStream.test.tsx` 5, `SpacesList.test.tsx`/`settings.test.ts`/`store/settings.test.ts` 2–3 each; `grep -n spinnerStyle <file>` gives the exact list). Some of those `spinnerStyle:` lines are inside partial patches rather than whole literals — adding the key there is harmless and keeps the two sibling settings adjacent everywhere, which is what a reader will look for.

Add ONE Rust test, directly after `spinner_style_defaults_to_none_and_round_trips` (line ~891), copying its structure verbatim:

```rust
#[test]
fn empty_state_animation_defaults_to_none_and_round_trips() {
    // A pre-feature file (no `emptyStateAnimation`) parses to `None` (the
    // frontend falls back to `"animated"`); an explicit choice survives a
    // round trip in camelCase.
    assert_eq!(Settings::default().empty_state_animation, None);
    let settings = Settings {
        empty_state_animation: Some("static".to_string()),
        ..Default::default()
    };
    let json = serde_json::to_string(&settings).unwrap();
    assert!(
        json.contains("\"emptyStateAnimation\""),
        "missing emptyStateAnimation in {json}"
    );
    let back: Settings = serde_json::from_str(&json).unwrap();
    assert_eq!(back.empty_state_animation, Some("static".to_string()));
    // Absent-key input reads as the default, not as an error.
    let file: Settings = serde_json::from_str(r#"{ "theme": "dark" }"#).unwrap();
    assert_eq!(file.empty_state_animation, None);
}
```

**Do NOT** read the new setting anywhere, add a Settings UI row (Task 6), or touch `AppSettings` defaults in `src/lib/settings.ts`. No migration code, no key-renaming.

**Steps:**
- [ ] Add the failing Rust test above to `src-tauri/src/config.rs`
- [ ] Run `cargo test empty_state_animation` from `src-tauri/`
  - Did it FAIL to compile with `no field 'empty_state_animation'`? If it passed, stop — the field already exists and this plan is stale.
- [ ] Add the Rust field + `Default` entry; re-run `cargo test empty_state_animation` from `src-tauri/` → passes
- [ ] Add `emptyStateAnimation: string | null;` to `AppSettings` in `src/lib/tauri.ts`
- [ ] Run `pnpm build` from the repo root
  - Did `tsc` report missing-property errors naming the 10 test files? If it reported NO errors, stop — `strict` may be off or the field was made optional by mistake; a silently-optional field is the bug this step catches.
- [ ] Add `emptyStateAnimation: null,` at all 13 fixture sites; re-run `pnpm build` → green
- [ ] Run `pnpm test` from the repo root → green (the new setting changes no behaviour, so no assertion should move)
- [ ] Run `cargo test`, `cargo clippy --all-targets`, `cargo fmt --check` from `src-tauri/` → green, **0 clippy warnings**
- [ ] Commit: `feat(settings): add emptyStateAnimation (the empty-state film's control)`

**Acceptance criteria:**
- [ ] `Settings::default().empty_state_animation == None`, and a `settings.json` with no `emptyStateAnimation` key parses to `None` (no migration).
- [ ] The value survives a `Settings` → JSON → `Settings` round trip under the camelCase key `emptyStateAnimation`.
- [ ] `AppSettings.emptyStateAnimation` is required (not `?:`), and `pnpm build` is green.
- [ ] `pnpm test` shows the same pass count as before this task, with no assertion edited other than adding fixture keys.

---

### Task 2: The film's own opaque palette token

**Parallel:** wave 1 — disjoint from Task 1 (`src-tauri/src/config.rs`, `src/lib/tauri.ts`, settings fixtures) and Task 3 (`src/lib/archimedes-film/compositor.ts`, `compositor.test.ts`)

**Context:**
The film draws up to ~26,000 glyphs per frame whose **brightness is the data** — luminance picks the glyph and its intensity. The obvious colour, `--color-foreground-subtlest`, resolves to `oklab(0.278 -0.0067 -0.0288 / 0.4)` (fact 4): an alpha of 0.4. Multiplying an already-luminance-scaled glyph by a 40% alpha flattens the chiaroscuro into invisibility, so the film gets its own **opaque** token (ADR 0071). The name is `--color-film-glyph`.

Per ADR 0062's precedent for decoration that a Palette may re-hue, the token is declared in **all five** palette layers, aliased to an existing reading in the four non-Dracula blocks so zai renders byte-identically, with `.theme-dracula` carrying its own hex. `--color-row-icon` is the copyable example (fact 10). In light palettes the glyphs must be DARK (the page is light) and in dark palettes LIGHT — so the `@theme` reading (which is what a light mode reads, per `themeTokens.test.ts`'s block comment) is the dark grey.

Dracula's `#6272a4` is Comment, already used by `--color-border` (`dracula.css:329`). That is deliberate — a decorative film shares the palette's quietest grey — and it is safe to add: the `statusCollisions` gate compares only the thinking **levels** (hexes `#a4ffff`, `#69ff94`, `#ffffa5`, `#ff92df`, `#ff5555`, `#f1fa8c`) against `MEANINGFUL_TOKENS`, and none of them is `#6272a4`.

**Files:**
- Modify: `src/styles/theme.css` (four blocks: `@theme` at 2, `.dark` at 238, `.theme-zai-light` at 419, `.theme-zai-dark` at 571)
- Modify: `src/styles/dracula.css` (`.theme-dracula` at 204)
- Modify: `src/lib/themeTokens.test.ts`
- Modify: `src/lib/paletteCompleteness.test.ts`

**What to implement:**

Declare `--color-film-glyph` in all five blocks, placed next to the `--color-row-icon` declaration in each (dracula.css:431) so the two decoration families sit together:

| Block | Value | Why |
|---|---|---|
| `@theme` | `var(--color-neutral-500)` | Light-safe (a light page needs dark glyphs); `@theme` is the classless and `.theme-zai-light`-adjacent reading |
| `.dark` | `var(--color-neutral-400)` | Light-grey glyphs on the dark pane, matching the demo's `rgb(v,v,v)` headroom |
| `.theme-zai-light` | `var(--color-neutral-500)` | Alias of the `@theme` reading (the row family does exactly this) |
| `.theme-zai-dark` | `var(--color-neutral-400)` | Alias of the `.dark` reading |
| `.theme-dracula` | `#6272a4` | Comment — the palette's quiet grey, same value `--color-border` uses |

Give each declaration a short comment naming ADR 0071 and stating that it is **opaque on purpose** (the luminance bands are the only dimming mechanism) — a future reader will otherwise "fix" it by aliasing to `--color-foreground-subtlest`, which is the trap this task exists to avoid.

In `src/lib/themeTokens.test.ts`:
1. Add `"color-film-glyph"` to `MEANINGFUL_TOKENS` (line ~210) with a one-line comment in the style of the `color-row-icon` entry: it is here so the film's colour and the thinking ramp cannot later be collapsed onto one hex without failing by name.
2. Add a new `describe` block modelled on `the row token family` (line 748): a `FILM_GLYPH` name const, a `FILM_READINGS` table mapping each of the five layer names to its required value (the four aliases by their exact `var(...)` string, Dracula by `#6272a4`), and `it.each(LAYER_NAMES)` tests for (a) the layer declares the token and (b) it carries exactly the table's value. Compare the WHOLE value, not `contains("var(")` — that is what stops a re-anchor onto a different token. Reuse the existing `ALL_LAYERS` / `LAYER_NAMES`; do not build a second layer list.

In `src/lib/paletteCompleteness.test.ts`: move the three counts per fact 9 (`119 → 120`, `94 → 95`, `167 → 168`), update the `it(...)` **title** to read `is 120 declarations: 89 structural + 25 descriptors + 6 ramp`, and extend its explanatory comment in the style of the ADR 0062 note already there — state that `--color-film-glyph` is added to EVERY layer so Dracula gains one (+1 = 120), `diff(DARK, INHERITED)` gains one (+1 = 95), `ZAI_DARK` gains one (+1 = 168), `INHERITED` is unchanged because the token is declared in Dracula too, and the `48 == 48` cross-check is therefore unmoved. **Do not** edit the `expect(ZAI_DARK.size - DRACULA.size).toBe(INHERITED.length - 6)` line.

**Do NOT** change any existing token's value, and do not add the token to `paletteCompleteness.test.ts`'s `INHERITED` list (it is "in zai-dark but NOT in dracula" — our token is in both).

**Steps:**
- [ ] Add the `FILM_READINGS` table + `it.each` tests to `src/lib/themeTokens.test.ts`
- [ ] Run `pnpm test src/lib/themeTokens.test.ts` from the repo root
  - Did it fail naming `color-film-glyph missing from @theme` (or the first layer)? A pass here means the token somehow already exists — stop and investigate.
- [ ] Add the five CSS declarations with their comments
- [ ] Re-run `pnpm test src/lib/themeTokens.test.ts` → green
- [ ] Add `"color-film-glyph"` to `MEANINGFUL_TOKENS`
- [ ] Run `pnpm test src/lib/themeTokens.test.ts` → green. If a **status collision** is reported, the Dracula hex collides with a thinking level — stop and pick a different Dracula reading rather than adding to `KNOWN_STATUS_COLLISIONS`.
- [ ] Run `pnpm test src/lib/paletteCompleteness.test.ts`
  - Did it fail on the three counts with numbers matching fact 9 (`120`/`95`/`168`)? If it fails with DIFFERENT numbers, stop — the token landed in the wrong set of layers, which is exactly what this gate is for.
- [ ] Update the three counts + the `it` title + the comment; re-run → green
- [ ] Run `pnpm build` from the repo root → green (Tailwind must still compile)
- [ ] Commit: `feat(theme): add --color-film-glyph, the empty-state film's opaque decoration token (ADR 0071)`

**Acceptance criteria:**
- [ ] `--color-film-glyph` is declared in all five palette layers and resolves to an **opaque** colour in every one (no `color-mix(... transparent)`, no `/ alpha`).
- [ ] The four non-Dracula layers alias, so every zai surface renders byte-identically.
- [ ] `themeTokens.test.ts` fails by name if any single layer drops the token or re-anchors its value.
- [ ] `paletteCompleteness.test.ts` is green at 120 / 95 / 168 with the 48 == 48 cross-check untouched.

---

### Task 3: The ASCII compositor

**Parallel:** wave 1 — disjoint from Task 1 and Task 2; it creates `src/lib/archimedes-film/compositor.ts` + its own test, and its test takes a colour **string** parameter so it imports nothing from Task 2

**Context:**
This module owns everything that turns a luminance grid into glyphs: the 68-character ramp, the Sobel → directional-glyph rule, the vignette/contrast curve, the 8-band colour quantisation with per-run batching, the grid tiers, the contain maths and the device-pixel-ratio sizing. It is written with **no knowledge of three.js** — the seam between it and the scene is a `Float32Array` of luminance. That seam is what makes Task 5's `static` and `fallback` states cheap, and it is what makes this module testable in jsdom, where `getContext` returns `null` (fact 1) so the compositor must be exercised against a **recording fake context**, never a real one.

Two behaviours here are the decisions the feature was asked for, so they are asserted rather than incidental (ADR 0071): a cell below threshold emits **no draw call at all** and the canvas keeps its alpha channel, so the pane's own `--color-chat` shows through — that is both the "blends into the theme" requirement and the reason letterbox bars cannot appear.

**Files:**
- Create: `src/lib/archimedes-film/compositor.ts`
- Test: `src/lib/archimedes-film/compositor.test.ts`

**What to implement:**

Read the demo's `renderAsciiVideoFrame` (the luminance pass, the vignette, the `Math.pow(lum, 1.85) * vignette * 0.65` curve, the Sobel branch, the ramp indexing) and port its *logic* into pure functions. Public surface:

```ts
export const CHAR_RAMP: string;              // the demo's 68-char ramp, verbatim
export const FILM_ASPECT: number;            // 230 * 0.58 / 115 === 1.16
export interface GridTier { readonly cols: number; readonly rows: number; }
/** Largest first. 230x115 -> 160x80 -> 115x58; cols is always 2*rows so every tier keeps FILM_ASPECT at a 0.58 cell. */
export const GRID_TIERS: readonly GridTier[];
/** Pick the largest tier whose cell height (containBox.h / rows) is >= MIN_CELL_HEIGHT_PX (4). */
export function chooseTier(boxWidth: number, boxHeight: number): GridTier;
/** Contain: the largest box of FILM_ASPECT fitting (w,h). Never stretches. */
export function containBox(w: number, h: number): { width: number; height: number };
/** One band index per luminance value, `null` when the cell must NOT be drawn. */
export const BAND_COUNT = 8;
export function bandFor(lum: number): number | null;   // null when lum < DRAW_THRESHOLD_LUM (0.015)
/** The demo's glyph rule: Sobel magnitude > SOBEL_EDGE_THRESHOLD (0.22) -> '/','_','\\','|' by angle; else CHAR_RAMP[floor(lum * (len-1))]. */
export function glyphFor(grid: Float32Array, cols: number, rows: number, x: number, y: number): string;
/** Record draws instead of painting; a null band must produce NO call. */
export interface GlyphSink { fillText(glyph: string, x: number, y: number, band: number): void; }
export function drawGrid(grid: Float32Array, tier: GridTier, boxWidth: number, boxHeight: number, glyphColor: string, sink: GlyphSink): number;  // returns lit-cell count
/** Resolve a CSS custom property to a canvas-parsable colour via a probe element (fact 4). */
export function resolveTokenColor(cssVar: string): string;
/** Measure the monospace advance ratio once: measureText("M").width / fontSize for `fontSpec`. */
export function measureAdvanceRatio(ctx: CanvasRenderingContext2D, fontSpec: string): number;
```

Requirements with teeth:

- `drawGrid` **batches**: for each row, consecutive cells of the same band collapse into as few `fillText` calls as possible. Call `sink` with a `band` index, not a colour string — colour construction belongs to the caller so the per-frame string allocation happens 8 times, not 26,000 (fact 6).
- `drawGrid` skips cells whose `bandFor` is `null` and must not call the sink for them. The returned count is the lit-cell count, which Task 5 uses as its liveness check (ADR 0070).
- Glyph placement is `x * cellW` / `y * cellH` where `cellW = boxWidth / cols`, `cellH = boxHeight / rows`, and font size derives from `cellW / advanceRatio` — **not** from cell height as the demo does. The demo guesses `1.08 * ch` while placing at `cw`; the two agree only by luck with Courier New, and this app's `--font-mono` is user-changeable (default Fira Code).
- `resolveTokenColor` creates one off-screen element, sets `style.color = cssVar`, reads `getComputedStyle(el).color`, removes it, and returns that string. It must return `""` (not throw) when `document` is unavailable, and must NOT use `getPropertyValue` on the custom property (fact 4: that returns the unresolved `color-mix(...)`).
- `containBox` returns the largest `w'×h'` with `w'/h' === FILM_ASPECT` fitting inside `w×h`; for a 800×600 input it must give 696×600 (fact 5).
- Cell geometry uses the 0.58 ratio for tier selection so a drawn cell is never non-square in a way that stretches the render.

**Steps:**
- [ ] Write `src/lib/archimedes-film/compositor.test.ts` first, with a fake `GlyphSink` collecting calls. Cover: `containBox(800,600)` → `{696,600}` and `containBox(600,900)` → `{600, 517}` (allow ±1 px rounding) and that `width/height` is `FILM_ASPECT` for a tall and a wide input; `FILM_ASPECT === 1.16`; `CHAR_RAMP.length === 68`; `bandFor(0)` and `bandFor(0.01)` → `null`; `bandFor(0.9)` in `[0, BAND_COUNT)`; `drawGrid` over an all-zero grid calls the sink **zero times** and returns `0`; `drawGrid` over an all-`0.9` grid of 16×8 returns 128 and issues **strictly fewer** `fillText` calls than 128 (the batching is real); `glyphFor` returns `'/'`-family for a strong horizontal gradient and a ramp character for a flat region; `chooseTier` picks the smaller tier when the box is short (e.g. 464×400 → not the 115-row tier) and the largest when tall; `measureAdvanceRatio` returns a positive finite number for a fake context whose `measureText` returns a fixed width.
- [ ] Run `pnpm test src/lib/archimedes-film/compositor.test.ts`
  - Did it fail with "Cannot find module './compositor'"? A pass here means you wrote no assertions — stop.
- [ ] Implement `compositor.ts`; re-run the same scoped command → green
- [ ] Run `pnpm build` from the repo root → `tsc` green (note: `noUnusedLocals`/`noUnusedParameters` are on — no dead parameters)
- [ ] Commit: `feat(chat): add the ASCII film compositor (grid tiers, contain fit, band-batched glyphs)`

**Acceptance criteria:**
- [ ] A luminance value below the draw threshold produces **no** `fillText` call — the transparency mechanism, asserted.
- [ ] `containBox` never returns a box whose aspect differs from `FILM_ASPECT`.
- [ ] Row batching demonstrably reduces call count below one-per-cell.
- [ ] The module imports nothing from three.js, React, or any CSS file, and its test runs without `getContext`.

---

### Task 4: Pin three.js and port the scene

**Parallel:** none — `pnpm add` rewrites `package.json` and `pnpm-lock.yaml`, so this task is alone in its wave (gates 3 and 5)

**Context:**
This is the port itself. `scene.ts` builds the demo's scene and, per ADR 0070, renders into an offscreen `WebGLRenderTarget` that is **never appended to the document** — the DOM ends up holding only the 2D canvas Task 5 creates. Keeping GL off the compositor tree matters here specifically because the app's window is `"transparent": true` (`tauri.conf.json:16`) and a composited WebGL surface inside a transparent WebKitGTK window has a documented paints-nothing failure mode.

Three concrete deltas from the demo are required, not stylistic: (a) `preserveDrawingBuffer` + `gl.readPixels` is a synchronous GPU stall — headless Chrome logs `GPU stall due to ReadPixels` running the demo unmodified — so it becomes `readRenderTargetPixels`; (b) the demo is three **r128** and every light intensity must be re-tuned because r155 turned off `useLegacyLights` (spot/point intensity and decay changed meaning) and r163+ dropped WebGL1 entirely, so we are on modern lighting semantics with no legacy escape hatch; (c) the demo rebuilds the lever's vertex normals every frame over ~864 triangles, which buys nothing at 230×115.

`three@0.186.1` ships no type declarations (fact 3), so `@types/three@0.186.0` is installed in the same command and pinned at the exact same version pair.

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`
- Create: `src/lib/archimedes-film/scene.ts`
- Test: `src/lib/archimedes-film/scene.test.ts`
- Reference (read-only): `/home/daniel/Downloads/archimedes_cinematic_ascii_film.html`

**What to implement:**

**4a. Capture the reference frame BEFORE porting.** Run:

```
google-chrome --headless=new --disable-gpu --use-angle=swiftshader --no-sandbox \
  --window-size=928,800 --virtual-time-budget=6500 \
  --screenshot=/tmp/film-ref-6p5s.png \
  file:///home/daniel/Downloads/archimedes_cinematic_ascii_film.html
```

Keep the file. `--virtual-time-budget=6500` lands the 10.5 s loop near t ≈ 6.5 s (the deep-heave moment). This image is what "the look" means for the re-light, and it is also what a reviewer compares against.

**4b. Install the pair, exact:** `pnpm add three@0.186.1 @types/three@0.186.0` (no `^`). Both land in `dependencies`; keep them adjacent in `package.json` and comment the pair-pinning reason with a pointer to `AGENTS.md`'s `@tauri-apps/cli` rationale.

**4c. Port.** Move from the demo, keeping its numbers verbatim unless a delta above says otherwise: the materials, ground plane, fulcrum cone, noise-displaced boulder icosahedron, lever cylinder, the `human` group hierarchy (pelvis/torso/chest/neck/head, skirt, sash, cranium/brow/nose/beard/hair), `createLimbSegment`, the eight limb segments, feet, hands, `solveLimbIK`, the 38-particle debris pool with `spawnDebris`, the light-shaft cone, `FogExp2`, `evaluateChoreography` (the 10.5 s loop with phase boundaries 1.8 / 4.6 / 7.6 / 9.0 and the push/lift/bend/strain/shake/slam curves), and `updateScene`. Delete: the CDN script dependency, the `document.body` click/`inverted` handler, `resizeOutputCanvas`'s `window.innerWidth` sizing, the `outputCanvas`/2D context (Task 3 owns drawing), the dead `ctx.drawImage` line and the dead `imgData` block, and the per-frame `computeVertexNormals()` on the lever.

**4d. Public surface** (Task 5 consumes exactly this; the `three` types stay inside the module):

```ts
export interface FilmEngine {
  /** Resize the offscreen target for a drawn box at `dpr`. */
  resize(boxWidth: number, boxHeight: number, dpr: number, tier: { cols: number; rows: number }): void;
  /** Advance the choreography to `elapsedSec` and return COLS*ROWS luminance in [0,1], row-major, y already flipped. */
  frame(elapsedSec: number, dtSec: number): Float32Array;
  /** Free the GL context and GPU buffers. Idempotent. */
  dispose(): void;
  /** Called by the owner on `webglcontextlost`. */
  onContextLost(): void;
}
/** Throws if WebGL2 or the render target cannot be obtained — the caller catches and falls back (ADR 0070). */
export function createFilmEngine(): FilmEngine;
/** Pure, exported for tests: the 10.5 s choreography. */
export function evaluateChoreography(time: number): { t: number; push: number; lift: number; bend: number; strain: number; shake: number; slam: number };
/** Pure, exported for tests: two-bone IK; mutates `upper`/`lower` positions+rotations. */
export function solveLimbIK(...): void;
export const FILM_LOOP_SECONDS = 10.5;
export const FILM_HERO_TIME = 6.5;   // the `static` state's frame
```

`createFilmEngine` creates its own canvas, never appends it, uses `new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" })` **without** `preserveDrawingBuffer`, renders to a `THREE.WebGLRenderTarget` and reads it with `renderer.readRenderTargetPixels`. Do NOT add `renderer.capabilities` probing or `WEBGL_debug_renderer_info` checks — ADR 0070 rejects capability detection because WebKitGTK masks the renderer string and software-backed context creation reports success. Liveness is judged by Task 5 counting drawn cells.

**4e. Re-light.** With `useLegacyLights` gone, start from `intensity × Math.PI` on the `SpotLight` (the legacy→physical conversion commonly cited for the ÷π factor) and leave the `DirectionalLight`s unchanged, then compare the composited result against `/tmp/film-ref-6p5s.png` and tune by eye until the boulder reads against the ground and the figure is legible. Record the final intensities in the commit message — the numbers are a judgement call and the reason for them must not live only in the author's head. Do not "fix" this by disabling shadows; the shadowed chiaroscuro is the look.

**4f. Dynamic import.** Task 5 loads this module with `await import("./scene")`, so keep `three` imports static *within* this file (the dynamic boundary is at the module edge) and keep top-level side effects to none — a module that touches `document` at import time would run even when the setting is `off`.

**Steps:**
- [ ] Capture `/tmp/film-ref-6p5s.png` (4a) and open it — you need it for 4e
- [ ] `pnpm add three@0.186.1 @types/three@0.186.0`; confirm `package.json` shows both without `^`
- [ ] Write `scene.test.ts` covering the PURE maths only, with no GL: `evaluateChoreography` at 0, 1.8, 4.6, 7.6, 9.0 and 10.5 — assert the phase boundaries (e.g. `lift === 0` just before 1.8+ ; `push` reaches ~1.0 in the heave phase; the loop is periodic so `f(10.5) === f(0)`; `shake` peaks in the slam window; `slam === 0` outside 7.6–9.0); and `solveLimbIK` — a reachable target places the end effector within 1e-3 of it, an unreachable one clamps to full extension rather than throwing or producing `NaN`, and `len1+len2` is never exceeded
- [ ] Run `pnpm test src/lib/archimedes-film/scene.test.ts`
  - Did it fail with "Cannot find module './scene'"? Then proceed.
- [ ] Port the scene per 4c–4f; re-run the scoped test → green
- [ ] Run `pnpm build` — `tsc` must be clean against `@types/three`. If `useLegacyLights` or `outputEncoding` is reported missing, that is the r128→r186 API gap: use the modern equivalent, do not cast to `any` to silence it.
- [ ] Run `pnpm test` from the repo root → the whole suite still green (nothing mounted the film yet, so no new behaviour)
- [ ] **Visual verification (cannot be automated here — do not skip):** temporarily mount the engine in a scratch route or a one-off `pnpm tauri dev` session, composite a frame at `FILM_HERO_TIME`, and compare against `/tmp/film-ref-6p5s.png`. Tune 4e until it matches. Then remove the scratch mount.
- [ ] Commit: `feat(chat): port the Archimedes ASCII film scene to three r186 (offscreen, no readPixels)` — include the final light intensities in the body

**Acceptance criteria:**
- [ ] `three` and `@types/three` are both pinned exactly and are the same pair version.
- [ ] `createFilmEngine` never appends anything to the document, and `grep -n "preserveDrawingBuffer\|readPixels(" src/lib/archimedes-film/scene.ts` finds only `readRenderTargetPixels`.
- [ ] `document.body.addEventListener` (the demo's invert toggle) and `window.innerWidth` are absent from the port.
- [ ] Choreography and IK are asserted with no WebGL context constructed.
- [ ] The composited hero frame visibly matches `/tmp/film-ref-6p5s.png`.
- [ ] `scene.ts` is not imported statically by any module that runs on every session (only Task 5's dynamic `import()`), so a normal session never downloads three.js.

---

### Task 5: The `EmptyStateFilm` component and its state machine

**Parallel:** none — imports Task 3's `compositor` and Task 4's `scene` (gate 2), and creates `src/hooks/usePrefersReducedMotion.ts`, which Task 5 also edits two existing consumers of (below)

**Context:**
The React shell: it owns the canvas, the `ResizeObserver`, the 24 fps loop, the three idle gates, and the four-state precedence from the design (`off` beats reduced-motion; reduced-motion beats `static`; `static` beats `film`; every failure route lands on `fallback`, which renders today's markup unchanged). Per ADR 0070 liveness is judged **behaviourally** — composite one frame, and if zero cells were drawn, treat the renderer as dead — because no capability query works on the broken platforms.

The engine arrives as an **injected factory** with the real one as the default. This is not test cosmetics: jsdom returns `null` from `getContext` (fact 1), so the real engine cannot be constructed under test at all, and a stub of three.js's `WebGLRenderer` against a fake GL would test our stub rather than our code. Injecting the seam means each half is tested against its own contract.

`prefers-reduced-motion` is read through a new shared hook. The logic already exists **twice** in the repo — an inline `usePrefersReducedMotion` in `QueuedSummaryContent.tsx:60-89` and a private `getPrefersReducedMotion`/`usePrefersReducedMotion` pair in `src/components/ui/braille-loader.tsx:26-49` — so this task extracts the `QueuedSummaryContent` version (the more defensive one, it also handles the legacy `addListener` path) to `src/hooks/` and points both existing consumers at it. Neither has a dedicated test file, so the new hook gets one.

**Files:**
- Create: `src/hooks/usePrefersReducedMotion.ts`
- Create: `src/hooks/usePrefersReducedMotion.test.ts`
- Create: `src/components/chat/EmptyStateFilm.tsx`
- Test: `src/components/chat/EmptyStateFilm.test.tsx`
- Modify: `src/components/QueuedSummaryContent.tsx` (delete its inline hook, import the shared one)
- Modify: `src/components/ui/braille-loader.tsx` (delete its two private helpers, import the shared one)

**What to implement:**

`src/hooks/usePrefersReducedMotion.ts` — export `usePrefersReducedMotion(): boolean`, moving `QueuedSummaryContent.tsx:60-89` verbatim (keep the `typeof window`/`typeof window.matchMedia` guard from fact 2 and the `addListener` fallback). `QueuedSummaryContent.tsx` keeps its own `usePrefersReducedMotion()` call site working via the import; delete the local definition. Same for `braille-loader.tsx:26-49` (replace both `getPrefersReducedMotion` and its `usePrefersReducedMotion` with the import — its `React.useState(getPrefersReducedMotion)` initialiser becomes the plain hook call, which is equivalent because the new hook seeds `false` then syncs in its effect; confirm `braille-loader.test.tsx` still passes unchanged).

`src/components/chat/EmptyStateFilm.tsx`:

```ts
export type FilmMode = "off" | "static" | "film" | "fallback";
/** Pure, exported: the precedence rules. Testable without rendering. */
export function resolveFilmMode(input: {
  setting: string | null; reducedMotion: boolean; glAvailable: boolean; drewCells: boolean; engineFailed: boolean;
}): FilmMode;
export interface EmptyStateFilmProps {
  setting: string | null;
  /** Injected for tests; defaults to the real dynamic-import factory. */
  createEngine?: () => Promise<FilmEngine>;
  /** Resolved glyph colour; defaults to resolveTokenColor("var(--color-film-glyph)"). */
  glyphColor?: string;
}
export default function EmptyStateFilm(props: EmptyStateFilmProps): JSX.Element | null;
```

`resolveFilmMode` precedence, in this exact order: `setting === "off"` → `off`; `engineFailed || !glAvailable || !drewCells` → `fallback`; `reducedMotion` → `static`; `setting === "static"` → `static`; otherwise `film`. Reduced-motion may only *reduce*: it turns `animated`/`null` into `static`, never an `off` into anything else (ADR 0070).

Rendering: `off`/`fallback` render **exactly** the current markup (`<div className="flex h-full items-center justify-center"><p className="text-ui-base text-foreground-subtlest">Send a prompt to start</p></div>` — copy it from `MessageList.tsx:192-196` so the 4 existing assertions keep matching); `static` and `film` render `<div className="absolute inset-0 pointer-events-none" aria-hidden="true"><canvas … /></div>`. The wrapper and canvas are both `aria-hidden="true"` (the convention `braille-loader.tsx:103` follows). Decoration only — no label, no role, no caption (the design removed it).

Engine lifecycle and loop:
- On mount, if the mode could be `film`, `await createEngine()` inside try/catch; a throw sets `engineFailed`.
- After the first composited frame, take `drawGrid`'s return value; `0` sets `drewCells = false` → `fallback`. This is the liveness probe.
- Resize: `ResizeObserver` on the nearest sized ancestor, rAF-coalesced, guarded by `typeof ResizeObserver === "undefined"` (fact 2 — jsdom has none). Compute `containBox`, then `chooseTier`, then `engine.resize(box.width, box.height, Math.min(devicePixelRatio, 2), tier)`; rebuild buffers/font measurement **only when the tier changes**, not on every resize event. Canvas backing store = css size × capped dpr; CSS size = the contain box.
- Loop: `requestAnimationFrame` with a time accumulator advancing at 24 fps (`1000/26` ms quantum). Never free-run.
- Idle: stop the loop and cancel rAF on `document.visibilitychange` with `document.hidden`, on window `blur`, and when an `IntersectionObserver` reports `isIntersecting === false`. Guard `IntersectionObserver` with `typeof` (fact 2). rAF pausing is not reliable in a webview (`wry#204` measured 12% CPU minimised, `SIZE_MINIMIZED` is a no-op in wry), so all three are explicit and each is its own test.
- `static` calls `engine.frame(FILM_HERO_TIME, 0)` once, draws, and never schedules another frame.
- Teardown (cleanup function): cancel rAF, disconnect both observers, remove both listeners, call `engine.dispose()`. Make `dispose` safe to call twice — browsers cap live WebGL contexts near 16 and a remount leak can steal the only GL slot in the app.
- `webglcontextlost` → `preventDefault()`, then set `glAvailable = false` → `fallback`.

**Do NOT** add a click handler (the demo's click-to-invert is out of scope — clicking the empty pane must stay inert), do not add a caption or a play/pause affordance inside the pane, do not render the film when `units.length > 0`, and do not touch `TranscriptFooter`'s behaviour.

**Steps:**
- [ ] Create `src/hooks/usePrefersReducedMotion.test.ts`: with a full `matchMedia` stub (copy the shape from `braille-loader.test.tsx:16-24`) it returns `true` when the query matches and re-renders on the `change` event; with `window.matchMedia` absent (jsdom's real state, fact 2) it returns `false` and does not throw
- [ ] Run `pnpm test src/hooks/usePrefersReducedMotion.test.ts` → fails (module missing) → implement → green
- [ ] Point `QueuedSummaryContent.tsx` and `braille-loader.tsx` at the shared hook, deleting both local copies
- [ ] Run `pnpm test src/components/ui/braille-loader.test.tsx src/lib/braille` → green **with no assertion changed** (this proves the extraction was behaviour-preserving)
- [ ] Write `EmptyStateFilm.test.tsx`. Inject a fake engine whose `frame()` returns a deterministic grid and whose `dispose`/`resize` are `vi.fn()`; stub `ResizeObserver` and `IntersectionObserver` on `globalThis` (fact 2 — jsdom has neither) and the `matchMedia` stub for the reduced-motion cases. Cover, one test each: `resolveFilmMode` for all five precedence branches; `off` renders `"Send a prompt to start"`; `fallback` renders it; the fake engine + a non-zero grid yields a canvas and **no** `"Send a prompt to start"`; a grid of all zeros yields `"Send a prompt to start"` (the liveness probe); `createEngine` rejecting yields the text line and logs via `console.error`; reduced-motion renders a canvas, calls `frame` with `FILM_HERO_TIME`, and schedules no further animation frame; `dispose` is called on unmount; each of `visibilitychange` (hidden), `blur`, and `isIntersecting: false` stops the frame callback; the canvas and wrapper carry `aria-hidden="true"`
- [ ] Run `pnpm test src/components/chat/EmptyStateFilm.test.tsx` → red → implement → green
- [ ] Run `pnpm test` and `pnpm build` from the repo root → green
- [ ] Commit: `feat(chat): add EmptyStateFilm with off/static/film/fallback states and a shared reduced-motion hook`

**Acceptance criteria:**
- [ ] `resolveFilmMode` precedence is asserted in all five branches, including that `off` wins over `reducedMotion`.
- [ ] Every failure route (no GL, context lost, zero-cell frame, engine throw) lands on the text line, each with its own test.
- [ ] `static` draws exactly one frame and schedules nothing further.
- [ ] Each of the three idle gates independently stops the loop, each with its own test.
- [ ] `dispose()` runs on unmount and is safe twice.
- [ ] `grep -c "usePrefersReducedMotion" src/components/QueuedSummaryContent.tsx src/components/ui/braille-loader.tsx` shows imports, not local definitions, and both suites pass unedited.

---

### Task 6: Mount the film and add the Settings control

**Parallel:** none — shares `src/components/chat/MessageList.tsx` with nothing but must come after Task 5, and shares `src/components/settings/SettingsPage.test.tsx` with Task 1 (gate 1)

**Context:**
Two integrations that finish the feature. The **Transcript**'s empty branch gains one child under the existing suppression condition, and Settings → Appearance gains the control that satisfies WCAG 2.2.2. `MessageList` reads the setting from the existing `useSettings` store — `ChatStream` already consumes that store (`ChatStream.tsx:52` region), so the reactive path exists and a Settings change takes effect without a reload (`SettingsPage.tsx`'s `update()` pushes the next document into the store on every commit).

`MessageList` is mounted only by `ChatStream` (`ChatStream.tsx:1565`); `SubagentTranscript` does not use it, so the subagent sheet correctly gets no film. The film must not change scroll behaviour: the existing `emptyRef` effect (`MessageList.tsx:145-146`) sets `scrollTop`, so the film layer is absolutely positioned and never contributes content height.

**Files:**
- Modify: `src/components/chat/MessageList.tsx`
- Create: `src/components/chat/MessageList.emptyFilm.test.tsx`
- Modify: `src/components/settings/AppearanceSection.tsx`
- Modify: `src/components/settings/SettingsPage.test.tsx`

**What to implement:**

In `MessageList.tsx`, in the `units.length === 0` branch (line 184), make the wrapper `relative` and render the film **in place of** the hint, under the unchanged condition:

```tsx
<div ref={emptyRef} data-testid="transcript-scroll"
     className="relative flex-1 flex flex-col gap-3 overflow-y-auto overflow-x-hidden min-w-0 max-w-full p-4">
  {!hasPendingRequest && !workingOrInTurn && agentState !== "blocked" && (
    <EmptyStateFilm setting={emptyStateAnimation} />
  )}
  <TranscriptFooter … />
</div>
```

Read the setting with `useSettings((s) => s.settings?.emptyStateAnimation ?? null)` — a selector, so an unrelated settings write does not re-render the transcript. Add `emptyStateAnimation: string | null` to `MessageListProps` instead if a prop is easier to test than a store subscription; if you add a prop, update `makeProps` in `src/components/chat/MessageList.scroll.test.tsx:84` (the only `MessageListProps` factory) and keep `MessageList.test.tsx`/`.gap.test.tsx`/`.scroll.test.tsx`'s existing `"Send a prompt to start"` assertions green — they pass because jsdom has no `getContext`, so `EmptyStateFilm` renders the fallback (fact 1).

In `AppearanceSection.tsx`, add a `SettingsRow` immediately after the "Thinking spinner" row (~line 219), `controlLayout="wide"`, labelled **Empty-session animation** with description "The animation the transcript shows when a session has no messages yet. Reduced-motion settings always stop it." Control: a small radiogroup in `src/components/settings/controls.tsx` (add `EmptyStateAnimationPicker` there — it is where `SpinnerStylePicker` lives, `controls.tsx:73`), `role="radiogroup"`, `aria-label="Empty-session animation"`, three `role="radio"` buttons `aria-checked` for Off / Static / Animated, styled like `SpinnerStylePicker`'s buttons (`border-border hover:bg-muted` unselected, `border-primary bg-primary/10` selected).

Default-sentinel handling: the closed vocabulary is `"off"` / `"static"` / `"animated"`, and the stored default is `null`. Select **Animated** when the stored value is `null`, following `closedSelectValue`'s convention for an off-list value (a hand-edited `"spatial"` reads back as the default and is rendered, not re-saved). **Animated** writes `"animated"` (a non-null write is fine here — unlike `palette`, whose `null` keeps `settings.json` minimal for a dark-only-palette surprise, this setting's default is genuinely animated, and writing it is the user's explicit choice).

In `SettingsPage.test.tsx`, add tests in the style of the existing `spinnerStyle` tests (~line 2122): the row renders with Animated selected while `emptyStateAnimation` is `null`; choosing Static saves `emptyStateAnimation: "static"`; choosing Off saves `"off"`; and the whole saved document still contains every other key (the fixtures already assert this shape).

**Steps:**
- [ ] Write `src/components/chat/MessageList.emptyFilm.test.tsx`: with `units: []` and the suppression flags clear, the film layer is present (assert a `canvas`-blessing fallback: the `aria-hidden` wrapper exists); with `hasPendingRequest: true` (and with `workingOrInTurn: true`, and `agentState: "blocked"`) neither the film nor the hint renders; with `units` non-empty no film renders and `"Send a prompt to start"` does not appear; with `emptyStateAnimation: "off"` the text line renders
- [ ] Run `pnpm test src/components/chat/MessageList.emptyFilm.test.tsx` → red (no film yet)
- [ ] Implement the `MessageList` change; re-run → green
- [ ] Run `pnpm test src/components/chat/` → green, with the pre-existing `"Send a prompt to start"` assertions untouched (they pass via `fallback`)
- [ ] Add `EmptyStateAnimationPicker` to `controls.tsx` and the row to `AppearanceSection.tsx`
- [ ] Add the `SettingsPage.test.tsx` cases; run `pnpm test src/components/settings/SettingsPage.test.tsx` → red → green
- [ ] Run `pnpm test` and `pnpm build` from the repo root → green
- [ ] Commit: `feat(chat): show the ASCII film in the empty transcript, with an Appearance control`

**Acceptance criteria:**
- [ ] An empty session renders the film layer; the four existing `"Send a prompt to start"` assertions across `MessageList.test.tsx`/`ChatStream.test.tsx` still pass with no edits.
- [ ] The film is suppressed by exactly the same three conditions the hint was (`hasPendingRequest`, `workingOrInTurn`, `agentState === "blocked"`), asserted for each.
- [ ] `TranscriptFooter` still renders in the empty branch, so a permission or `ask` gate is still visible.
- [ ] The Settings row saves `"off"` / `"static"` / `"animated"`, renders Animated selected for `null`, and a non-empty-session transcript is unaffected.
- [ ] No subagent transcript sheet gains a film.

---

### Task 7: Full validation and the manual passes

**Parallel:** none — a whole-suite run is serial by gate 4, and it is the only thing that can prove the integration

**Context:**
Nothing so far has run the film inside the real webview, and the design explicitly assumes a platform where GL can fail silently. This task runs the repo's full bar and the two manual passes that automated tests structurally cannot make: jsdom has no canvas, no `ResizeObserver`, no `IntersectionObserver` and no `matchMedia` (fact 2), so every resize/visibility/reduced-motion behaviour proven above is proven against fakes.

**Files:** none (verification only — if anything fails, fix it in the file that owns it)

**Steps:**
- [ ] From the repo root: `pnpm test` → all green
- [ ] From the repo root: `pnpm build` → `tsc` + Vite green. Then confirm the lazy chunk is real: `ls -la dist/assets/ | sort -k5 -n | tail -5` should show a ~500 KB (minified) chunk that is NOT `index-*.js`, and `grep -c "THREE" dist/assets/index-*.js` should be `0` — proving `three` sits behind the dynamic import and a normal session never downloads it (ADR 0070).
- [ ] From `src-tauri/`: `cargo test` → green
- [ ] From `src-tauri/`: `cargo clippy --all-targets` → **0 warnings** (`AGENTS.md` requires zero)
- [ ] From `src-tauri/`: `cargo fmt --check` → clean
- [ ] Manual, dark theme: `pnpm tauri dev`, open a Space, start a new session. Expected: the film fills the transcript area, centred, no caption, no visible rectangle or bars, the pane's background visible at the edges.
- [ ] Manual, resize: drag the window from very wide/short to very tall/narrow. Expected: the figure stays undistorted at every size (that is the 1.16 contain rule), the grain visibly coarsens once or twice (the tier steps), and nothing crops or squashes.
- [ ] Manual, light theme: Settings → Theme → Light. Expected: dark glyphs on the light pane (the `@theme` reading), still legible, no inversion glitch.
- [ ] Manual, control: Settings → Appearance → Empty-session animation → Off → the text line returns immediately without a reload; → Static → one frozen hero frame; → Animated → motion returns.
- [ ] Manual, OS: set the OS reduced-motion preference and return with no setting saved → static frame.
- [ ] Manual, Linux (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, per `AGENTS.md`/Tauri's Linux graphics doc): an empty session either shows the film or falls back to the text line — **never** a blank pane. If it shows a blank pane, the liveness probe is not firing; fix before shipping (ADR 0070).
- [ ] Commit any fixes: `fix(chat): empty-state film validation fixes`

**Acceptance criteria:**
- [ ] All five validation commands are green, with 0 clippy warnings.
- [ ] `three` lives in its own chunk and `index-*.js` contains no three.js.
- [ ] Resize keeps the figure undistorted across the tier steps, in both themes.
- [ ] All three control values take effect live, and reduced-motion yields a static frame.
- [ ] On the Linux pass a GL failure produces the text line, never a blank pane.

---

## Out of scope

No click-to-toggle on the film (the demo's click-to-invert is dropped — clicking the empty pane stays inert). No interactivity, camera response, or audio. No film in the **Subagent** transcript sheet. No change to the **working indicator** or its `spinnerStyle` setting. No baked/pre-rendered asset (ADR 0070 records why the offline-bake option was rejected).
