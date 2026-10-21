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
4. **`getComputedStyle(html).getPropertyValue("--color-foreground-subtlest")` returns `color-mix(in oklab, #1f2937 40%, transparent)`** — canvas `fillStyle` cannot parse that. Reading a *probe element's computed `color`* returns `oklab(0.278074 -0.00672175 -0.0288133 / 0.4)`, which `fillStyle` accepts and round-trips. Both verified in headless Chrome. Note the `/ 0.4` alpha — that is why the film needs its own opaque token (ADR 0071). (And note the probe has to be **attached** when it is read, or it resolves the light `@theme` reading under a dark palette — see Task 3's probe-attachment paragraph.)
5. **The film's aspect ratio is `230 × 0.58 ÷ 115 = 1.16`**, fixed by the demo's camera (`(GRID_COLS * 0.58) / GRID_ROWS`, where `0.58` is a monospace cell's width/height ratio). Drawing into any other box stretches the figure.

   **5a. Two float facts, learned the hard way.** `(230 * 0.58) / 115` evaluates to `1.1599999999999997`, **not** `1.16` — so `expect(FILM_ASPECT).toBe(1.16)` FAILS; use `toBeCloseTo(1.16, 6)`. And the aspect is exactly `2 × 0.58` **only for a 2:1 grid**: `160×80` → `1.16` ✓, `116×58` → `1.16` ✓, but `115×58` → **`1.15`** ✗ (58 is half of 116, not of 115). Every tier must be exactly 2:1 or that tier stretches the render — the exact defect this feature exists to prevent.

   **5b. Do not round inside `containBox`** (full contract in Task 3). `(600, 900)` must yield height `517.2413…`, not `517`: `600/517 = 1.16054…` sits `5.4e-4` off the aspect, which fails `toBeCloseTo(FILM_ASPECT, 6)` *and* precision 3, and passes only at precision 2.
6. **`CHAR_RAMP` is 68 characters** long (`. → █`). The demo's per-glyph `fillStyle` costs ~12 ms/frame at 230×115 (~26,450 lit cells); 8-band colour quantisation with per-run `fillText` costs ~3 ms.
7. **Headless Chrome renders the demo's scene on SwiftShader and screenshots it**: `google-chrome --headless=new --disable-gpu --use-angle=swiftshader --no-sandbox --window-size=928,800 --virtual-time-budget=6500 --screenshot=/tmp/ref.png file://<demo.html>`. This is how the re-light reference frame is captured (Task 4). It also logs `GPU stall due to ReadPixels`, which is the readback defect Task 4 removes.
8. **Adding a required field to the TypeScript `AppSettings` touches 10 test files, at 16 `spinnerStyle:` declaration sites** — `tsconfig.json` sets `strict: true` and `pnpm build` runs `tsc`. They are all updated in Task 1, the same task that adds the field, so no intermediate commit is red. Count **declarations**, not `grep` hits, and count **fixtures**, not repo-wide hits: `grep -n spinnerStyle` also matches prose and comments, so `ChatStream.test.tsx` shows 5 hits but has 3 declarations, and `SettingsPage.test.tsx` shows 6 but has 2. And `grep -rn 'spinnerStyle:' src` returns **19** hits of which only **16** are fixtures — the other three are the interface itself (`src/lib/tauri.ts`) and two props-type members (`src/components/chat/ComposerRow.tsx`, `src/components/chat/WorkingIndicator.tsx`), which are not `AppSettings` literals and must not gain the key. The 16, per file: `App.test.tsx` 1, `AgentsDialog.test.tsx` 1, `ChatStream.test.tsx` 3, `MessageBubble.codeblock.test.tsx` 1, `settings/SettingsPage.test.tsx` 2, `settings/WebSearchSection.test.tsx` 1, `SpacesList.test.tsx` 2, `useAttentionAlert.test.ts` 1, `lib/settings.test.ts` 2, `store/settings.test.ts` 2. `App.test.tsx`'s literal sits inside an untyped `vi.fn().mockResolvedValue({...})`, so `tsc` may not flag that one — update it anyway.

   `src/App.test.tsx`, `src/components/AgentsDialog.test.tsx`, `src/components/ChatStream.test.tsx`, `src/components/MessageBubble.codeblock.test.tsx`, `src/components/settings/SettingsPage.test.tsx`, `src/components/settings/WebSearchSection.test.tsx`, `src/components/SpacesList.test.tsx`, `src/hooks/useAttentionAlert.test.ts`, `src/lib/settings.test.ts`, `src/store/settings.test.ts`

9. **Adding a token to every palette layer moves exactly FOUR hard-coded numbers in `src/lib/paletteCompleteness.test.ts`** — and one prose comment. `it("is 119 declarations…")` at lines **475** (`DRACULA` `119 → 120`), **476** (`diff(DARK, INHERITED)` `94 → 95`), **477** (`ZAI_DARK.size` `167 → 168`) and — separately, easy to miss because it sits in a different `it` — line **641** (`expect(Object.keys(DRACULA_VALUES).length).toBe(119)` → `120`), whose comment just above at line 639 also reads "the block sees 119 declarations" and must be re-worded too. The cross-check `ZAI_DARK.size - DRACULA.size === INHERITED.length - 6` (48 == 48) is count-neutral and must stay untouched, as must `INHERITED.length` (the token is declared in Dracula too, so it never enters the `INHERITED` list), `FILE_DESCRIPTORS.length` (25) and `declaredTerminal.length` (22).
10. **The palette layer blocks are** `@theme` (`theme.css:2`), `.dark` (`theme.css:238`), `.theme-zai-light` (`theme.css:419`), `.theme-zai-dark` (`theme.css:571`), `.theme-dracula` (`dracula.css:204`). The `--color-row-icon` family (ADR 0062) is declared in **all five** — that is the pattern to copy.

11. **Tailwind v4 tree-shakes only the `@theme`-derived copy of a theme variable; the `.text-*` utility RULE is the thing that must be earned.** Measured against the real stylesheet (token declared in all five layers, nothing referencing it): `--color-film-glyph:` appears **4 times** — the four palette blocks (`.dark`, `.theme-zai-light`, `.theme-zai-dark`, `.theme-dracula`) are plain CSS that Tailwind passes through verbatim — while the `@theme` copy that lands in `:root,:host` is dropped, and **the `.text-film-glyph{` rule appears 0 times**. Once any scanned source contains the class name both go to 5 and 1, and the rule is exactly `.text-film-glyph{color:var(--color-film-glyph)}` — which is how `--color-row-icon` survives today (`.text-row-icon{color:var(--color-row-icon)}`, generated because `ChangesGroupCard.tsx:158` uses the class).

    So the load-bearing artefact is the **utility rule**, not the variable: `resolveTokenColor` reads a computed `color`, and without that rule the probe element just inherits and resolves to black. **The gate is therefore `grep -o '\.text-film-glyph{' dist/assets/*.css | wc -l`, expected 1** — never a grep on the variable name, which counts **5** occurrences in a stylesheet where the utility was generated and so passes on a build where the utility was never generated either.

    **Count OCCURRENCES, never `grep -c`.** `grep -c` counts *matching lines*, and the built stylesheet is minified onto (essentially) one line — verified: `grep -c '\.text-film-glyph{' dist/assets/*.css` returns **1** for the real utility rule AND **1** for the vacuous `--color-film-glyph:` probe, so `-c` cannot tell the two apart and the disambiguation above silently checks nothing. `grep -o … | wc -l` counts occurrences: **1** for the utility rule, **5** for the variable string. Note that 5 is not the 4 the first draft of this plan recorded: 4 is the count in the *pre-generation* stylesheet (the four plain palette blocks, `@theme` copy tree-shaken); once the utility is earned the `@theme` copy survives too, so the same grep on the *shipped* stylesheet counts 5. Both 4 and 5 mean "the variable exists"; neither is the gate.

    **The utility rule needs TWO ingredients, and they live in different tasks.** The Tailwind rule `.text-film-glyph{…}` requires (a) the token declared in `@theme` — Task 2 — **and** (b) a scanned source that names the class: Task 3's `resolveTokenColor`, whose literal `FILM_GLYPH_COLOR_CLASS = "text-film-glyph"` supplies it. Whichever of the two runs first cannot possibly pass the `dist` check, so the check belongs to **Task 3**, the task that completes the pair (it used to be misfiled into Task 2, where it was unpassable). Task 7 re-runs it as the final gate, after this roadmap doc is deleted.

    **The trap that produced this plan's first wrong number:** Tailwind v4's automatic source detection scans `.md` files, so writing the literal class name in a **markdown document** generates the utility by itself. `src/index.css:6-9` already documents exactly this and excludes one doc with `@source not`. While this plan lived in `docs/roadmap/`, the grep reported the utility rule as present with **no source file using it**; moving the document out made it drop to 0. Roadmap docs are deleted on ship, so a gate satisfied by this plan's own prose would go red in the release that follows it. Therefore: the utility must be generated by a real `.tsx` reference (Task 3's `resolveTokenColor` probe, which applies the class), and the grep must be re-run **after** this roadmap doc is gone — Task 7 does exactly that, and Task 3's `dist` step warns about the artifact.

12. **`JSX.Element` is not available in this project.** React 19 types (`@types/react@19.3.0`) removed the global `JSX` namespace, and the repo has zero occurrences of it. The convention is an explicit `ReactElement | null` return (`ProviderSection.tsx:259`, `McpSection.tsx:428`, `UpdateSection.tsx:263`), with `ReactElement` imported from `react`.

13. **Every task's verification includes a repo-wide `pnpm build` (`tsc` over all of `src`) or `pnpm test` (the whole suite).** That single fact is what makes this plan serial — see *Parallelisation*.

---

## Parallelisation

**Verdict:** SERIAL — every task's own verification steps include a repo-wide `pnpm build` (`tsc` compiling **all** of `src`) and/or a full `pnpm test`, which fails gate 4 ("scoped verification is sufficient"). Running a repo-wide type-check or the full suite while a sibling is mid-edit in the same tree measures the sibling's half-written code, which is exactly the failure the six gates exist to prevent. Task 1 additionally rewrites `pnpm-lock.yaml`-adjacent config and 10 shared test fixtures (gate 3).

The file sets *would* have been disjoint — Task 1 (Rust + `lib/tauri.ts` + fixtures), Task 2 (`src/styles/*.css` + the two palette test files) and Task 3 (`archimedes-film/compositor.ts` + its test) share no paths — so this is a near miss worth naming: the blocker is the **commands**, not the file lists, and `AGENTS.md`'s validation bar is what forces those commands. A wave that ran only `pnpm test <own-file>` and skipped `tsc` would have been legal, but would have let the `AppSettings` and `@types/three` integration errors escape to Task 7.

**Task order: document order, 1 → 7.** Tasks 1, 2 and 3 share no files and no imports, so they cannot conflict; the one ordering constraint among them is the built-CSS gate of fact 11 — Task 3's `dist` step needs Task 2's `@theme` token to exist first, because the utility rule is generated only when the token AND the class reference are both present. Document order satisfies that; running 3 before 2 would leave that step reporting `0`. Task 4 needs Task 3's compositor types, Task 5 needs Tasks 3 and 4, Task 6 needs Task 5 and Task 1's setting, Task 7 runs last and alone.

---

### Task 1: The `emptyStateAnimation` setting (Rust → TS → fixtures)

**Parallel:** none — its verification runs repo-wide `pnpm build` (tsc over all of `src`) and the full `pnpm test`, which fails gate 4; it also rewrites 10 shared `AppSettings` fixtures. Runs 1st of 7, in document order.

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

**Third mandatory Rust edit — `settings_round_trip_with_the_new_fields`.** That test (line ~1340) builds an **exhaustive** `Settings { … }` literal — no `..Default::default()` base is available there — so adding ANY field to `Settings` breaks it with `E0063: missing field 'empty_state_animation' in initializer`. Add `empty_state_animation: Some("static".to_string()),` beside its `spinner_style` entry. This is not optional cleanup: it is the compile error you hit the moment you add the field, and a plan that does not name it leaves the executor guessing which test to blame. Note the gate sitting in the same test just under the literal: its hardcoded `for key in [ … ]` list of expected JSON keys must gain `"\"emptyStateAnimation\""` beside `"\"spinnerStyle\""`, with a comment saying why both are listed. They pin **different claims** — the key list pins the serialized DOCUMENT shape (the key set a `settings.json` actually carries, so a field that still parses but silently stops being serialized is caught ONLY there), while `empty_state_animation_defaults_to_none_and_round_trips` below pins defaulting and value round-trip. Both are needed; deleting the key from the list to make the test pass would be the wrong fix.

In `src/lib/tauri.ts`, in `interface AppSettings` (line ~541), immediately after `spinnerStyle`, add:

```ts
/** The empty-state animation (`"off"` / `"static"` / `"animated"`); `null` = the `"animated"` default. `prefers-reduced-motion` may pin `"animated"` to `"static"`, never un-`off` a deliberate `"off"` (ADR 0070). */
emptyStateAnimation: string | null;
```

In each of the 10 test files: add `emptyStateAnimation: null,` **next to every existing `spinnerStyle:` declaration** — **16 sites**, per file: `App.test.tsx` 1, `AgentsDialog.test.tsx` 1, `ChatStream.test.tsx` 3, `MessageBubble.codeblock.test.tsx` 1, `settings/SettingsPage.test.tsx` 2, `settings/WebSearchSection.test.tsx` 1, `SpacesList.test.tsx` 2, `useAttentionAlert.test.ts` 1, `lib/settings.test.ts` 2, `store/settings.test.ts` 2. Enumerate them with `grep -n 'spinnerStyle:' src -r` (the trailing colon matters: a bare `grep -n spinnerStyle` also returns prose and comments and will have you adding keys inside comments — e.g. `ChatStream.test.tsx` has 5 grep hits but only 3 declarations, `SettingsPage.test.tsx` 6 hits but 2). That repo-wide grep returns **19** hits, and 3 of them are NOT fixtures — `src/lib/tauri.ts` (the `AppSettings` interface you are editing above, which gains the declaration once, not a `null`) and the props-type members in `src/components/chat/ComposerRow.tsx` and `src/components/chat/WorkingIndicator.tsx` (the working indicator keeps its own prop; this feature changes nothing about it). Adding the key to those two props types is an active error: it widens a component contract no task asked you to widen. Some fixture sites sit inside partial patches rather than whole literals; adding the key there is harmless and keeps the two sibling settings adjacent everywhere, which is what a reader will look for. `App.test.tsx`'s literal is inside an untyped `vi.fn().mockResolvedValue({…})`, so `tsc` may not flag it — update it anyway.

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
- [ ] Add the Rust field + `Default` entry; re-run `cargo test empty_state_animation` from `src-tauri/`
  - Did it now fail to compile with `E0063 missing field 'empty_state_animation' in initializer` pointing at `settings_round_trip_with_the_new_fields`? That is the exhaustive-literal trap described above, not a broken test. Add the field to that literal AND the `"\"emptyStateAnimation\""` entry to its `for key in [...]` list, then re-run → passes
- [ ] Add `emptyStateAnimation: string | null;` to `AppSettings` in `src/lib/tauri.ts`
- [ ] Run `pnpm build` from the repo root
  - Did `tsc` report missing-property errors naming the 10 test files? If it reported NO errors, stop — `strict` may be off or the field was made optional by mistake; a silently-optional field is the bug this step catches. (Expect ~9 files flagged, not 10 — `App.test.tsx`'s untyped literal may not be flagged; see fact 8.)
- [ ] Add `emptyStateAnimation: null,` at all 16 `spinnerStyle:` fixture declaration sites (the per-file breakdown in fact 8; do NOT touch `lib/tauri.ts` again, `ComposerRow.tsx` or `WorkingIndicator.tsx`); re-run `pnpm build` → green
- [ ] Run `pnpm test` from the repo root → green (the new setting changes no behaviour, so no assertion should move)
- [ ] Run `cargo test`, `cargo clippy --all-targets`, `cargo fmt --check` from `src-tauri/` → green, **0 clippy warnings**
- [ ] Commit: `feat(settings): add emptyStateAnimation (the empty-state film's control)`

**Acceptance criteria:**
- [ ] `Settings::default().empty_state_animation == None`, and a `settings.json` with no `emptyStateAnimation` key parses to `None` (no migration).
- [ ] The value survives a `Settings` → JSON → `Settings` round trip under the camelCase key `emptyStateAnimation`.
- [ ] `settings_round_trip_with_the_new_fields` compiles and passes with `empty_state_animation` in its exhaustive literal, and its `for key in [...]` document-shape list names `"emptyStateAnimation"` beside `"spinnerStyle"`.
- [ ] `AppSettings.emptyStateAnimation` is required (not `?:`), and `pnpm build` is green.
- [ ] `pnpm test` shows the same pass count as before this task, with no assertion edited other than adding the 16 fixture keys.
- [ ] `src/components/chat/ComposerRow.tsx` and `src/components/chat/WorkingIndicator.tsx` are untouched — their `spinnerStyle` hits are props types, not fixtures.

---

### Task 2: The film's own opaque palette token

**Parallel:** none — same gate-4 reason (its steps run `pnpm build` and edit shared palette test files). Runs 2nd of 7, in document order.

**Context:**
The film draws up to ~26,000 glyphs per frame whose **brightness is the data** — luminance picks the glyph and its intensity. The obvious colour, `--color-foreground-subtlest`, resolves to `oklab(0.278 -0.0067 -0.0288 / 0.4)` (fact 4): an alpha of 0.4. Multiplying an already-luminance-scaled glyph by a 40% alpha flattens the chiaroscuro into invisibility, so the film gets its own **opaque** token (ADR 0071). The name is `--color-film-glyph`.

Per ADR 0062's precedent for decoration that a Palette may re-hue, the token is declared in **all five** palette layers, aliased to an existing reading in the four non-Dracula blocks so zai renders byte-identically, with `.theme-dracula` carrying its own hex. `--color-row-icon` is the copyable example (fact 10). In light palettes the glyphs must be DARK (the page is light) and in dark palettes LIGHT — so the `@theme` reading (which is what a light mode reads, per `themeTokens.test.ts`'s block comment) is the dark grey.

Dracula's `#6272a4` is Comment, already used by `--color-border` (`dracula.css:329`). That is deliberate — a decorative film shares the palette's quietest grey — and it is safe to add: the `statusCollisions` gate compares only the thinking **levels** (hexes `#a4ffff`, `#69ff94`, `#ffffa5`, `#ff92df`, `#ff5555`, `#f1fa8c`) against `MEANINGFUL_TOKENS`, and none of them is `#6272a4`.

**Critically (fact 11):** the token must be reached through a real Tailwind **utility class**, or the `.text-film-glyph{color:var(--color-film-glyph)}` rule is never generated, `resolveTokenColor`'s probe element inherits instead of resolving, and the film paints black-on-black while every jsdom test stays green. That rule has two ingredients and this task supplies only one of them: the `@theme` token is here, the scanned class reference is Task 3's `resolveTokenColor` (`FILM_GLYPH_COLOR_CLASS = "text-film-glyph"`). So **this task does not — cannot — prove the rule is generated**; the `dist` check that proves it belongs to Task 3, and Task 7 re-runs it as the final gate. What this task owns is the declaration half: all five layers, opaque, aliasing where the row family aliases.

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

In `src/lib/paletteCompleteness.test.ts`: move all FOUR counts per fact 9 — lines 475 (`119 → 120`), 476 (`94 → 95`), 477 (`167 → 168`) and **line 641** (`Object.keys(DRACULA_VALUES).length` `119 → 120`) — plus the prose at line 639 that says "the block sees 119 declarations". Update the `it(...)` **title** to read `is 120 declarations: 89 structural + 25 descriptors + 6 ramp`, and extend its explanatory comment in the style of the ADR 0062 note already there — state that `--color-film-glyph` is added to EVERY layer so Dracula gains one (+1 = 120), `diff(DARK, INHERITED)` gains one (+1 = 95), `ZAI_DARK` gains one (+1 = 168), `INHERITED` is unchanged because the token is declared in Dracula too, and the `48 == 48` cross-check is therefore unmoved. **Do not** edit the `expect(ZAI_DARK.size - DRACULA.size).toBe(INHERITED.length - 6)` line.

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
  - Did it fail on the counts with numbers matching fact 9 (`120`/`95`/`168`, at lines 475/476/477)? If it fails with DIFFERENT numbers, stop — the token landed in the wrong set of layers, which is exactly what this gate is for.
- [ ] Update all four counts (lines 475, 476, 477 **and 641**) + the `it` title + the comment at line 639; re-run `pnpm test src/lib/paletteCompleteness.test.ts`
  - Green? If line 641 is the only remaining failure, you found the count the first draft of this plan missed — fix it, do not adjust the expectation to fit.
- [ ] Run `pnpm test src/lib/paletteCompleteness.test.ts` → green (the spec-hex gate must accept `#6272a4`, which it does — it is the spec's Current Line / Comment hue, already carried by `--color-border`)
- [ ] Run `pnpm build` from the repo root → green
  - **No `dist` grep here, deliberately (fact 11).** The `.text-film-glyph{` utility rule needs BOTH this task's `@theme` token AND a scanned source naming the class, and that source is Task 3's `resolveTokenColor` (`FILM_GLYPH_COLOR_CLASS = "text-film-glyph"`). At the end of this task the token exists but nothing references the class, so the rule is correctly absent — a `dist` check placed here can only ever report `0` and is unfalsifiable. The rule's proof therefore runs in **Task 3**, and Task 7 re-runs it as the final gate after this roadmap doc is deleted.
- [ ] Commit: `feat(theme): add --color-film-glyph, the empty-state film's opaque decoration token (ADR 0071)`

**Acceptance criteria:**
- [ ] `--color-film-glyph` is declared in all five palette layers and resolves to an **opaque** colour in every one (no `color-mix(... transparent)`, no `/ alpha`).
- [ ] The four non-Dracula layers alias, so every zai surface renders byte-identically.
- [ ] `themeTokens.test.ts` fails by name if any single layer drops the token or re-anchors its value.
- [ ] `paletteCompleteness.test.ts` is green at 120 / 95 / 168 / 120 with the 48 == 48 cross-check untouched.
- [ ] Nothing in this task claims the utility rule exists. The `.text-film-glyph{` `dist` grep is deliberately **not** an acceptance criterion here — it is Task 3's, where the class reference that generates it lands (fact 11).

---

### Task 3: The ASCII compositor

**Parallel:** none — same gate-4 reason (`pnpm build` is a repo-wide tsc). Runs 3rd of 7, in document order. Its test takes a colour **string** parameter and imports nothing from Task 2, so there is no build-graph edge; the serial verdict is purely about the verification commands. (One soft ordering note: this task's `dist` utility-rule step is only satisfiable once Task 2's `@theme` token exists — the two-ingredient rule of fact 11 — which document order already guarantees.)

**Context:**
This module owns everything that turns a luminance grid into glyphs: the 68-character ramp and the Sobel → directional-glyph rule, the 8-band colour quantisation with per-run batching, the grid tiers, the contain maths and the device-pixel-ratio sizing. It is written with **no knowledge of three.js** — the seam between it and the scene is a `Float32Array` of luminance. That seam is what makes Task 5's `static` and `fallback` states cheap, and it is what makes this module testable in jsdom, where `getContext` returns `null` (fact 1) so the compositor must be exercised against a **recording fake context**, never a real one.

Two behaviours here are the decisions the feature was asked for, so they are asserted rather than incidental (ADR 0071): a cell below threshold emits **no draw call at all** and the canvas keeps its alpha channel, so the pane's own `--color-chat` shows through — that is both the "blends into the theme" requirement and the reason letterbox bars cannot appear.

**Files:**
- Create: `src/lib/archimedes-film/compositor.ts`
- Test: `src/lib/archimedes-film/compositor.test.ts`

**What to implement:**

Read the demo's `renderAsciiVideoFrame` (the luminance pass, the Sobel branch, the ramp indexing) and port its *logic* into pure functions. Public surface:

```ts
export const CHAR_RAMP: string;              // the demo's 68-char ramp, verbatim
export const FILM_ASPECT: number;            // (230 * 0.58) / 115 -> 1.1599999999999997, i.e. 1.16 to float (fact 5a)
export interface GridTier { readonly cols: number; readonly rows: number; }
/** Largest first: 230x115 -> 160x80 -> **116**x58. cols MUST be exactly 2*rows — that is what keeps every tier at FILM_ASPECT for a 0.58 cell. `115x58` is WRONG (it gives 1.15 and stretches the render; see fact 5a). */
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
/** Resolve a Tailwind colour utility CLASS to a canvas-parsable colour via a probe element (facts 4, 11). */
export function resolveTokenColor(colorUtilityClass: string): string;  // e.g. "text-film-glyph"; the probe is ATTACHED while measured
/** Measure the monospace advance ratio once: measureText("M").width / fontSize for `fontSpec`. */
export function measureAdvanceRatio(ctx: CanvasRenderingContext2D, fontSpec: string): number;
```

Requirements with teeth:

- **Where the tone curve lives** (an undefined contract becomes an integration bug): the demo's vignette and `Math.pow(lum, 1.85) * vignette * 0.65` contrast curve are applied by the **scene** (Task 4), whose `frame()` returns already-curved luminance. `bandFor` therefore receives post-curve luminance and applies only the `DRAW_THRESHOLD_LUM` cut and the band quantisation — it must NOT re-apply the vignette. That is what makes `drawGrid` a pure mapping from the scene's grid to draw calls, and it is why the 16×8 all-`0.9` test below yields exactly 128 lit cells with no corner falloff.

- `drawGrid` **batches**: for each row, consecutive cells of the same band collapse into as few `fillText` calls as possible. Call `sink` with a `band` index, not a colour string — colour construction belongs to the caller so the per-frame string allocation happens 8 times, not 26,000 (fact 6).
- `drawGrid` skips cells whose `bandFor` is `null` and must not call the sink for them. The returned count is the lit-cell count, which Task 5 uses as its liveness check (ADR 0070).
- Glyph placement is `x * cellW` / `y * cellH` where `cellW = boxWidth / cols`, `cellH = boxHeight / rows`, and font size derives from `cellW / advanceRatio` — **not** from cell height as the demo does. The demo guesses `1.08 * ch` while placing at `cw`; the two agree only by luck with Courier New, and this app's `--font-mono` is user-changeable (default Fira Code).
- `resolveTokenColor(colorUtilityClass)` creates one element that is **invisible but ATTACHED to the document** (see the probe-attachment subsection after this list — "off-screen" here means merely *not seen*: `position: absolute; visibility: hidden`, or parked at `left: -9999px`; it never means "not in the document"), **applies the Tailwind class** (`el.className = colorUtilityClass`, i.e. `"text-film-glyph"` — NOT an inline `style.color`, which Tailwind cannot scan and so would never generate the `.text-film-glyph` rule the probe depends on, fact 11), reads `getComputedStyle(el).color`, removes the element, and returns that string. It must NOT use `getPropertyValue` on the custom property (fact 4: that returns the unresolved `color-mix(...)` canvas cannot parse). **State the contract plainly, because jsdom surprises here:** return whatever `getComputedStyle` yields, and `""` ONLY when `document`/`getComputedStyle` is unavailable. Do not invent a sentinel for "unresolved" — an element whose class has no stylesheet behind it resolves to the inherited colour, and in jsdom that is `"rgb(0, 0, 0)"` for both attached and detached elements (verified). So the unstyled-class test asserts `"rgb(0, 0, 0)"` and the no-DOM test asserts `""`. Black is acceptable under jsdom because no jsdom test paints anything real; the real guard against a missing utility rule is this task's and Task 7's `dist` grep, not this function.

- `containBox` returns the largest `w'×h'` with `w'/h' === FILM_ASPECT` fitting inside `w×h`. **Return the UNROUNDED floats** and let the caller round when assigning `canvas.width`/`height`: `(800, 600)` → `{695.9999999999998, 600}`, `(600, 900)` → `{600, 517.2413793103448}`. Rounding is not cosmetic here: `600/517 = 1.16054…`, which is `5.4e-4` off the aspect — it fails `toBeCloseTo(FILM_ASPECT, 6)` and precision 3, and only passes at precision 2. Returning floats keeps the aspect assertion honest at precision 6.
- Cell geometry uses the 0.58 ratio for tier selection so a drawn cell is never non-square in a way that stretches the render.

**The probe must be ATTACHED before `getComputedStyle` (learned in execution).** `resolveTokenColor`'s probe is *off-screen, not detached*: append it to `document.body` (or `documentElement`), read the computed colour, then remove it. The reason is the palette mechanism, not a nicety — `.dark`, `.theme-zai-light`, `.theme-zai-dark` and `.theme-dracula` are toggled as classes on `document.documentElement` (`src/lib/theme.ts:77-84`), so every palette reading in this app is an **inherited cascade result below the root element**. A detached element is not in that cascade: it resolves the bare `@theme` (`:root,:host`) values, i.e. the LIGHT reading, under every dark palette — the film would silently paint dark-grey glyphs on the dark pane in Dracula and zai-dark, and no jsdom test could see it, because jsdom resolves the same inherited colour for attached and detached elements alike (fact 1's environment has no palette stylesheets at all). So: attach, read, remove — and keep it unseen rather than unattached (`visibility: hidden` / `position: absolute`, or parked at `left: -9999px`; either is fine, being absent from the document is not), marked `aria-hidden="true"` so assistive tech never sees a stray node. This is also why the probe's own literal class name is what earns the utility rule (fact 11): the constant `FILM_GLYPH_COLOR_CLASS = "text-film-glyph"` is the scanned occurrence Tailwind needs.

**Steps:**
- [ ] Write `src/lib/archimedes-film/compositor.test.ts` first, with a fake `GlyphSink` collecting calls. Cover: `containBox(800,600)` → `width` `toBeCloseTo(696, 3)` / `height` `toBeCloseTo(600, 3)`, and `containBox(600,900)` → `width` `toBeCloseTo(600, 3)` / `height` `toBeCloseTo(517.241, 3)` — asserting the FLOATS, not rounded integers (a rounded `517` breaks the aspect assertion even at precision 3). Also assert `width/height` is `toBeCloseTo(FILM_ASPECT, 6)` for both a tall and a wide input; `FILM_ASPECT` `toBeCloseTo(1.16, 6)` (NOT `toBe(1.16)` — fact 5a: the expression yields `1.1599999999999997` and `toBe` fails); `CHAR_RAMP.length === 68`; `bandFor(0)` and `bandFor(0.01)` → `null`; `bandFor(0.9)` in `[0, BAND_COUNT)`; `drawGrid` over an all-zero grid calls the sink **zero times** and returns `0`; `drawGrid` over an all-`0.9` grid of 16×8 returns 128 and issues **strictly fewer** `fillText` calls than 128 (the batching is real); `glyphFor` returns `'/'`-family for a strong horizontal gradient and a ramp character for a flat region; `chooseTier` picks a smaller tier when the box is short (e.g. 464×400 → not the top tier) and the largest when tall, AND that every entry of `GRID_TIERS` satisfies `cols === 2 * rows` (one assertion that makes the whole stretch bug unrepresentable); `resolveTokenColor` returns `"rgb(0, 0, 0)"` for a class with no stylesheet behind it under jsdom and `""` when the DOM APIs are absent; `measureAdvanceRatio` returns a positive finite number for a fake context whose `measureText` returns a fixed width.
- [ ] Run `pnpm test src/lib/archimedes-film/compositor.test.ts`
  - Did it fail with "Cannot find module './compositor'"? Then proceed. A pass here means you wrote no assertions — stop.
- [ ] Implement `compositor.ts`; re-run the same scoped command → green
- [ ] Run `pnpm build` from the repo root → `tsc` green (note: `noUnusedLocals`/`noUnusedParameters` are on — no dead parameters)
- [ ] Assert the probe is attached while measured: in the test, wrap `getComputedStyle` (or spy on `document.body.appendChild`) and assert `el.isConnected === true` at the moment it is read. jsdom gives the same answer either way, so only the connection assertion catches a detached probe — and a detached probe is the bug that paints the light reading under every dark palette (see the probe-attachment note).
- [ ] **Prove the utility RULE is generated by real code and not by this document (fact 11) — this is the step Task 2 used to carry wrongly.** By the end of this task both ingredients exist: Task 2's `@theme` token and this file's `FILM_GLYPH_COLOR_CLASS = "text-film-glyph"`. Tailwind scans `.md` files, so this plan's own prose can also satisfy the grep; run the check with the roadmap doc removed from the build's view:
  ```
  mv docs/roadmap/ascii-film-empty-state.md /tmp/plan.md.bak && pnpm build
  grep -o '\.text-film-glyph{' dist/assets/*.css | wc -l   # then move the doc back
  ```
  - Must print **1** (occurrences, **not** `grep -c` — the minified stylesheet is one line, so `-c` prints 1 for the real rule *and* 1 for the vacuous variable string and distinguishes nothing). `0` means the only thing generating the utility was a markdown file — i.e. this module does not name the class — and the film will paint black-on-black in the app while every jsdom test stays green. Fix `resolveTokenColor`, not the grep.
  - Do NOT grep for `--color-film-glyph:` — `grep -o … | wc -l` counts **5** on a good build (four palette blocks plus the surviving `@theme` copy) and it is nonzero even when the utility was never generated (fact 11), so that gate passes vacuously.
- [ ] Commit: `feat(chat): add the ASCII film compositor (grid tiers, contain fit, band-batched glyphs)`

**Acceptance criteria:**
- [ ] A luminance value below the draw threshold produces **no** `fillText` call — the transparency mechanism, asserted.
- [ ] `containBox` never returns a box whose aspect differs from `FILM_ASPECT` (compared with `toBeCloseTo`, fact 5a), and every `GRID_TIERS` entry has `cols === 2 * rows` so no tier can stretch the render.
- [ ] Row batching demonstrably reduces call count below one-per-cell.
- [ ] `resolveTokenColor` returns a canvas-parsable colour (never a raw `color-mix(...)` string, fact 4); `"rgb(0, 0, 0)"` for a class with no stylesheet behind it under jsdom; and `""` only when the DOM APIs are missing.
- [ ] The probe is attached (`isConnected`) at the moment `getComputedStyle` reads it, asserted — the guard against resolving the light `@theme` reading under a dark palette (see the probe-attachment note).
- [ ] With this roadmap doc moved out of the tree, `grep -o '\.text-film-glyph{' dist/assets/*.css | wc -l` prints **1** — the utility rule comes from real code (this module's class literal + Task 2's token), not from this file's prose (fact 11; Task 7 re-runs it after the doc is deleted).
- [ ] The module imports nothing from three.js, React, or any CSS file, and its test runs without `getContext`.

---

### Task 4: Pin three.js and port the scene

**Parallel:** none — `pnpm add` rewrites `package.json` and `pnpm-lock.yaml` (gates 3 and 5), it consumes Task 3's compositor types (gate 2), and its verification is repo-wide. Runs 4th of 7.

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

**No canvas probe lives in this module.** The keep-`three`-out-of-jsdom probe is Task 5's job and sits on the *caller* side of the dynamic import — by the time `scene.ts` is evaluating, `three` has already been parsed, so a probe inside this file would be pointless. `scene.ts` is plain three.js: no `document`/`window` access at module top level (a module that touches the DOM at import time would run even when the setting is `off`), and `createFilmEngine` throws rather than returning null when the render target cannot be obtained.

`createFilmEngine` creates its own canvas, never appends it, uses `new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" })` **without** `preserveDrawingBuffer`, renders to a `THREE.WebGLRenderTarget` and reads it with `renderer.readRenderTargetPixels`. Do NOT add `renderer.capabilities` probing or `WEBGL_debug_renderer_info` checks — ADR 0070 rejects capability detection because WebKitGTK masks the renderer string and software-backed context creation reports success. Liveness is judged by Task 5 counting drawn cells.

**4d. Public surface** (Task 5 consumes exactly this; the `three` types stay inside the module):

```ts
export interface FilmEngine {
  /** Resize the offscreen target for a drawn box at `dpr`. */
  resize(boxWidth: number, boxHeight: number, dpr: number, tier: { cols: number; rows: number }): void;
  /** Advance the choreography to `elapsedSec` and return COLS*ROWS luminance in [0,1], row-major, y already flipped.
   *  POST-TONE-CURVE: the demo's vignette and `Math.pow(lum, 1.85) * vignette * 0.65` are applied HERE (the scene owns the look), together with the
   *  `lum < 0.04` crushed-black branch, so the compositor receives final luminance and re-applies nothing (Task 3 states the contract). */
  frame(elapsedSec: number, dtSec: number): Float32Array;
  // Buffer ownership: `frame()` returns a buffer allocated in `resize()` for the current tier and REUSED every frame —
  // same array identity between resizes. The caller must finish reading it before the next call. Returning a fresh
  // ~105 KB array per frame is exactly the per-frame allocation this loop exists to avoid.
  /** Free the GL context and GPU buffers. Idempotent. */
  dispose(): void;
  /** Called by the owner on `webglcontextlost`. */
  onContextLost(): void;
}
/** Throws if WebGL2 or the render target cannot be obtained — the caller catches and falls back (ADR 0070). */
export function createFilmEngine(): FilmEngine;
/** Pure, exported for tests: the 10.5 s choreography. */
export function evaluateChoreography(time: number): { t: number; push: number; lift: number; bend: number; strain: number; shake: number; slam: number };
/** Pure, exported for tests: the demo's two-bone IK, VERBATIM in signature and maths
 *  (the demo's `solveLimbIK`, which takes world-space root/target, the two bone
 *  lengths, a bend direction, the two limb-segment records returned by
 *  `createLimbSegment`, and a z offset). */
export function solveLimbIK(
  rootPos: { x: number; y: number },
  targetPos: { x: number; y: number },
  len1: number,
  len2: number,
  bendDir: 1 | -1,
  upper: LimbSegment,
  lower: LimbSegment,
  zOffset: number,
): void;
/** The demo's `createLimbSegment` return shape, re-exported for tests. */
export interface LimbSegment { group: THREE.Group; mesh: THREE.Mesh; len: number }
export const FILM_LOOP_SECONDS = 10.5;
export const FILM_HERO_TIME = 6.5;   // the `static` state's frame
```

**4e. Re-light.** With `useLegacyLights` gone, start from `intensity × Math.PI` on the `SpotLight` (the legacy→physical conversion commonly cited for the ÷π factor) and leave the `DirectionalLight`s unchanged, then compare the composited result against `/tmp/film-ref-6p5s.png` and tune by eye until the boulder reads against the ground and the figure is legible. Record the final intensities in the commit message — the numbers are a judgement call and the reason for them must not live only in the author's head. Do not "fix" this by disabling shadows; the shadowed chiaroscuro is the look.

**4f. Dynamic import.** Task 5 loads this module with `await import("./scene")`, so keep `three` imports static *within* this file (the dynamic boundary is at the module edge) and keep top-level side effects to none.

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

**Parallel:** none — imports Task 3's `compositor` and Task 4's `scene` (gate 2), edits one existing reduced-motion consumer (`QueuedSummaryContent.tsx`; `braille-loader.tsx` is deliberately left alone — see its note), and verifies repo-wide. Runs 5th of 7.

**Context:**
The React shell: it owns the canvas, the `ResizeObserver`, the 24 fps loop, the three idle gates, and the four-state precedence from the design (`off` beats reduced-motion; reduced-motion beats `static`; `static` beats `film`; every failure route lands on `fallback`, which renders today's markup unchanged). Per ADR 0070 liveness is judged **behaviourally** — composite one frame, and if zero cells were drawn, treat the renderer as dead — because no capability query works on the broken platforms.

The engine arrives as an **injected factory** with the real one as the default. This is not test cosmetics: jsdom returns `null` from `getContext` (fact 1), so the real engine cannot be constructed under test at all, and a stub of three.js's `WebGLRenderer` against a fake GL would test our stub rather than our code. Injecting the seam means each half is tested against its own contract.

`prefers-reduced-motion` is read through a new shared hook. The logic already exists **twice** in the repo — an inline `usePrefersReducedMotion` in `QueuedSummaryContent.tsx:60-89` and a private `getPrefersReducedMotion`/`usePrefersReducedMotion` pair in `src/components/ui/braille-loader.tsx:26-49` — so this task extracts the `QueuedSummaryContent` version (the more defensive one, it also handles the legacy `addListener` path) to `src/hooks/` and points `QueuedSummaryContent` at it — and deliberately leaves `braille-loader.tsx` on its own copy (see the extraction note below). Neither existing copy has a dedicated test file, so the new hook gets one.

**Files:**
- Create: `src/hooks/usePrefersReducedMotion.ts`
- Create: `src/hooks/usePrefersReducedMotion.test.ts`
- Create: `src/components/chat/EmptyStateFilm.tsx`
- Test: `src/components/chat/EmptyStateFilm.test.tsx`
- Modify: `src/components/QueuedSummaryContent.tsx` (delete its inline hook, import the shared one)

`src/components/ui/braille-loader.tsx` is deliberately **NOT** in this list — see above.

**What to implement:**

`src/hooks/usePrefersReducedMotion.ts` — export `usePrefersReducedMotion(): boolean`, moving `QueuedSummaryContent.tsx:60-89` verbatim (keep the `typeof window`/`typeof window.matchMedia` guard from fact 2 and the `addListener` fallback). `QueuedSummaryContent.tsx` keeps its call site working via the import; delete the local definition.

**Then keep `braille-loader.tsx` AS IT IS.** Its `getPrefersReducedMotion` is a **synchronous initialiser** (`React.useState(getPrefersReducedMotion)`), whereas the shared hook seeds `false` and learns the truth in an effect. Swapping it is *probably* safe — `braille-loader.test.tsx:105` asserts `span.textContent === frames[0]`, which comes from the JSX body rather than the effect, and the reduced-motion effect would start an interval then have it cleared — but "probably" is not good enough to spend on a refactor nobody asked for, on a component with an accessibility test whose whole point is that it does NOT animate. Leave `braille-loader.tsx` untouched and note in the shared hook's doc comment that the loader keeps its own synchronous-initialiser copy deliberately, because it must know the answer on the first render. Do not count `braille-loader` in this task's `Files:`.

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
  /** Resolved glyph colour; defaults to resolveTokenColor("text-film-glyph"). */
  glyphColor?: string;
}
export default function EmptyStateFilm(props: EmptyStateFilmProps): ReactElement | null;  // NOT JSX.Element — fact 12
```

`resolveFilmMode` precedence, in this exact order: `setting === "off"` → `off`; `engineFailed || !glAvailable || !drewCells` → `fallback`; `reducedMotion` → `static`; `setting === "static"` → `static`; otherwise `film`. Reduced-motion may only *reduce*: it turns `animated`/`null` into `static`, never an `off` into anything else (ADR 0070).

Rendering: `off`/`fallback` render **exactly** the current markup (`<div className="flex h-full items-center justify-center"><p className="text-ui-base text-foreground-subtlest">Send a prompt to start</p></div>` — copy it from lines 191-197 of `src/components/chat/MessageList.tsx` — note that file lives under `chat/`, there is no `src/components/MessageList.tsx` — so the pre-existing assertions keep matching); `static` and `film` render `<div className="absolute inset-0 pointer-events-none" aria-hidden="true"><canvas … /></div>`. The wrapper and canvas are both `aria-hidden="true"` (the convention `braille-loader.tsx:103` follows). Decoration only — no label, no role, no caption (the design removed it).

Engine lifecycle and loop:
- On mount, if the mode could be `film`, **probe for a WebGL2 context FIRST, on this caller side, before importing anything**: `document.createElement("canvas").getContext("webgl2")`. If that is `null` or throws, go straight to `fallback` and never evaluate `await import("./scene")` — that is what keeps 130 KB of three.js out of jsdom and out of a browser with no WebGL at all. This is *not* the capability probe ADR 0070 rejects: ADR 0070 rejects trusting a capability check as the liveness **decision** on a real platform, and the composited zero-cell output check below remains that decision. On WebKitGTK, where a context is handed out and is then silently software-backed or paints nothing, this pre-check passes and the output-based check still does the real work.
- Then `await createEngine()` inside try/catch; a throw sets `engineFailed`.
- After the first composited frame, take `drawGrid`'s return value; `0` sets `drewCells = false` → `fallback`. This is the liveness probe.
- Resize: `ResizeObserver` on the nearest sized ancestor, rAF-coalesced, guarded by `typeof ResizeObserver === "undefined"` (fact 2 — jsdom has none). Compute `containBox`, then `chooseTier`, then `engine.resize(box.width, box.height, Math.min(devicePixelRatio, 2), tier)`; rebuild buffers/font measurement **only when the tier changes**, not on every resize event. Canvas backing store = css size × capped dpr; CSS size = the contain box.
- Loop: `requestAnimationFrame` with a time accumulator advancing at **24 fps** — `FRAME_INTERVAL_MS = 1000 / 24` ≈ 41.67 ms, exported and asserted (`expect(FRAME_INTERVAL_MS).toBeCloseTo(41.667, 2)`). Do not write `1000 / 26`, which is 26 fps. Never free-run.
- Idle: stop the loop and cancel rAF on `document.visibilitychange` with `document.hidden`, on window `blur`, and when an `IntersectionObserver` reports `isIntersecting === false`. Guard `IntersectionObserver` with `typeof` (fact 2). rAF pausing is not reliable in a webview (`wry#204` measured 12% CPU minimised, `SIZE_MINIMIZED` is a no-op in wry), so all three are explicit and each is its own test.
- `static` calls `engine.frame(FILM_HERO_TIME, 0)` once, draws, and never schedules another frame.
- Teardown (cleanup function): cancel rAF, disconnect both observers, remove both listeners, call `engine.dispose()`. Make `dispose` safe to call twice — browsers cap live WebGL contexts near 16 and a remount leak can steal the only GL slot in the app.
- `webglcontextlost` → `preventDefault()`, then set `glAvailable = false` → `fallback`.

**Do NOT** add a click handler (the demo's click-to-invert is out of scope — clicking the empty pane must stay inert), do not add a caption or a play/pause affordance inside the pane, do not render the film when `units.length > 0`, and do not touch `TranscriptFooter`'s behaviour.

**Steps:**
- [ ] Create `src/hooks/usePrefersReducedMotion.test.ts`: with a full `matchMedia` stub (copy the shape from `braille-loader.test.tsx:16-24`) it returns `true` when the query matches and re-renders on the `change` event; with `window.matchMedia` absent (jsdom's real state, fact 2) it returns `false` and does not throw
- [ ] Run `pnpm test src/hooks/usePrefersReducedMotion.test.ts` → fails (module missing) → implement → green
- [ ] Point `QueuedSummaryContent.tsx` at the shared hook, deleting its local copy; leave `braille-loader.tsx` alone
- [ ] Run `pnpm test src/components/ui/braille-loader.test.tsx` → green **with no assertion changed** (`src/lib/braille/` holds only sources — verified, no test file there — so naming it would silently test nothing; `QueuedSummaryContent.tsx` has no test file of its own either, so the shared-hook test added above is what covers it, and the loader suite is the regression net proving the extraction changed no behaviour) 
- [ ] Write `EmptyStateFilm.test.tsx`. Inject a fake engine whose `frame()` returns a deterministic grid and whose `dispose`/`resize` are `vi.fn()`; stub `ResizeObserver` and `IntersectionObserver` on `globalThis` (fact 2 — jsdom has neither) and the `matchMedia` stub for the reduced-motion cases. Cover, one test each: `resolveFilmMode` for all five precedence branches; `off` renders `"Send a prompt to start"`; `fallback` renders it; the fake engine + a non-zero grid yields a canvas and **no** `"Send a prompt to start"`; a grid of all zeros yields `"Send a prompt to start"` (the liveness probe); `createEngine` rejecting yields the text line and logs via `console.error`; reduced-motion renders a canvas, calls `frame` with `FILM_HERO_TIME`, and schedules no further animation frame; `dispose` is called on unmount; each of `visibilitychange` (hidden), `blur`, and `isIntersecting: false` stops the frame callback; the canvas and wrapper carry `aria-hidden="true"`; and `createEngine` is NEVER called when the WebGL2 probe returns null (assert the fake factory was not invoked — that is the keep-three-out-of-jsdom guarantee).
- [ ] Run `pnpm test src/components/chat/EmptyStateFilm.test.tsx` → red → implement → green
- [ ] Run `pnpm test` and `pnpm build` from the repo root → green
- [ ] Commit: `feat(chat): add EmptyStateFilm with off/static/film/fallback states and a shared reduced-motion hook`

**Acceptance criteria:**
- [ ] `resolveFilmMode` precedence is asserted in all five branches, including that `off` wins over `reducedMotion`.
- [ ] Every failure route (no GL, context lost, zero-cell frame, engine throw) lands on the text line, each with its own test.
- [ ] `static` draws exactly one frame and schedules nothing further.
- [ ] Each of the three idle gates independently stops the loop, each with its own test.
- [ ] `dispose()` runs on unmount and is safe twice.
- [ ] `src/components/QueuedSummaryContent.tsx` imports the shared hook and holds no local definition; `braille-loader.tsx` is byte-identical to before this task (check with `git diff`).
- [ ] With no WebGL2 context available, the injected engine factory is never called — `three` is unreachable in that runtime.

---

### Task 6: Mount the film and add the Settings control

**Parallel:** none — shares `src/components/settings/SettingsPage.test.tsx` with Task 1 (gate 1) and mounts Task 5's component (gate 2). Runs 6th of 7.

**Context:**
Two integrations that finish the feature. The **Transcript**'s empty branch gains one child under the existing suppression condition, and Settings → Appearance gains the control that satisfies WCAG 2.2.2. `ChatStream` reads the setting from the existing `useSettings` store and passes it to `MessageList` as a prop; **`MessageList` subscribes to no store** (see the prop section below for why that constraint is load-bearing). `ChatStream` already consumes that store for `spinnerStyle` (`ChatStream.tsx:44` import, `:177` read, `:1620` pass-down), so the reactive path exists and a Settings change lands without a reload — `SettingsPage.tsx`'s `update()` pushes the next document into the store on every commit.

`MessageList` is mounted only by `ChatStream` (`ChatStream.tsx:1565`); `SubagentTranscript` does not use it, so the subagent sheet correctly gets no film. The film must not change scroll behaviour: the existing `emptyRef` effect (`src/components/chat/MessageList.tsx:145-146`) sets `scrollTop`, so the film layer is absolutely positioned and never contributes content height.

**Files:**
- Modify: `src/components/chat/MessageList.tsx`
- Modify: `src/components/ChatStream.tsx` (note: NOT under `chat/`) — read the setting from the store beside `spinnerStyle` at line 177 and pass it at the `<MessageList>` call around line 1565
- Create: `src/components/chat/MessageList.emptyFilm.test.tsx`
- Modify: `src/components/settings/controls.tsx` (add `EmptyStateAnimationPicker`, next to `SpinnerStylePicker` at line 73)
- Modify: `src/components/settings/AppearanceSection.tsx`
- Modify: `src/components/settings/SettingsPage.test.tsx`
- Modify: `src/components/ChatStream.test.tsx` — only if its `AppSettings` fixture (which already carries `spinnerStyle: null`) needs the film to be OFF for its transcript assertions; the prop defaults to `"off"` so it most likely needs nothing. Check, do not assume.

**What to implement:**

In `src/components/chat/MessageList.tsx`, in the `units.length === 0` branch (line 184), make the wrapper `relative` and render the film **in place of** the hint, under the unchanged condition:

```tsx
<div ref={emptyRef} data-testid="transcript-scroll"
     className="relative flex-1 flex flex-col gap-3 overflow-y-auto overflow-x-hidden min-w-0 max-w-full p-4">
  {!hasPendingRequest && !workingOrInTurn && agentState !== "blocked" && (
    <EmptyStateFilm setting={emptyStateAnimation} />
  )}
  <TranscriptFooter … />
</div>
```

**Read the setting in `ChatStream` and pass it down as a prop**, exactly as `spinnerStyle` is handled (`ChatStream.tsx:177-178` reads `useSettings((s) => s.settings?.spinnerStyle ?? "typing")` and passes it at line 1620). So: add `emptyStateAnimation: string | null` to `MessageListProps`, and in `ChatStream` add `const emptyStateAnimation = useSettings((s) => s.settings?.emptyStateAnimation ?? null)` beside the `spinnerStyle` line and pass it to `<MessageList>`.

Do **not** subscribe `MessageList` to the settings store itself. It subscribes to nothing today, and the constraint is load-bearing here for a reason specific to this feature: a store subscription would construct `EmptyStateFilm` in every existing jsdom test that renders an empty transcript, dragging `three` into the graph of tests that never intended to touch it.

**Make the new prop OPTIONAL, defaulting to `"off"`:** `emptyStateAnimation?: string | null`, destructured as `function MessageList({ emptyStateAnimation = "off", … })`. Three consequences, each verified rather than assumed:

1. **No existing test file needs editing.** `src/components/chat/MessageList.test.tsx` has **8** inline `<MessageList …>` renders, `MessageList.gap.test.tsx` builds props in a `renderMessageList` helper at line 46 (3 call sites: 82, 112, 127), and `MessageList.scroll.test.tsx:84` holds the one `makeProps` factory (all three under `src/components/chat/`). A required prop means editing all of them; an optional one with an `"off"` default means none.
2. **The existing `"Send a prompt to start"` assertions keep passing because the film is off** — not because jsdom lacks `getContext`, which is a fact about the test environment rather than about our feature. Count them properly rather than trusting a round number (verified): **2 positive** (`getByText` in `MessageList.test.tsx` and in `ChatStream.test.tsx`) and **7 negative** `queryByText(...).toBeNull()` — one in `MessageList.test.tsx`, six in `ChatStream.test.tsx`. The negatives matter more: each asserts the hint must NOT appear during a pending-gate or working state, and a film that rendered unconditionally would flip several at once.
3. **The `ChatStream`-rendering tests are NOT protected by that default**, because `ChatStream` always passes the prop explicitly (`?? null`, which is `null`, not `"off"`). Make that cost nothing:

**Task 5 owns the fix, and Task 6 must not duplicate it:** `EmptyStateFilm` probes `getContext("webgl2")` on the caller side *before* `await import("./scene")`, so on jsdom `three` is never parsed and the `ChatStream` suite keeps its current cost (see Task 5's engine-lifecycle section for the full rationale and why this is not the capability probe ADR 0070 rejects). Net effect here: the `ChatStream` path in tests resolves to `fallback` — asserted, not hand-waved. Task 6's only obligation is to not undo it: pass the prop, do not add a second engine path, and do not "simplify" by subscribing `MessageList` to the store.

`EmptyStateFilm.test.tsx` renders `EmptyStateFilm` directly and is the only place a fake engine is injected.

In `AppearanceSection.tsx`, add a `SettingsRow` immediately after the "Thinking spinner" row (~line 219), `controlLayout="wide"`, labelled **Empty-session animation** with description "The animation the transcript shows when a session has no messages yet. Reduced-motion settings always stop it." Control: a small radiogroup in `src/components/settings/controls.tsx` (add `EmptyStateAnimationPicker` there — it is where `SpinnerStylePicker` lives, `controls.tsx:73`), `role="radiogroup"`, `aria-label="Empty-session animation"`, three `role="radio"` buttons `aria-checked` for Off / Static / Animated, styled like `SpinnerStylePicker`'s buttons (`border-border hover:bg-muted` unselected, `border-primary bg-primary/10` selected).

Default-sentinel handling: the closed vocabulary is `"off"` / `"static"` / `"animated"`, and the stored default is `null`. Select **Animated** when the stored value is `null`, following `closedSelectValue`'s convention for an off-list value (a hand-edited `"spatial"` reads back as the default and is rendered, not re-saved). **Animated** writes `"animated"` (a non-null write is fine here — unlike `palette`, whose `null` keeps `settings.json` minimal for a dark-only-palette surprise, this setting's default is genuinely animated, and writing it is the user's explicit choice).

In `SettingsPage.test.tsx`, add tests in the style of the existing `spinnerStyle` tests (~line 2122): the row renders with Animated selected while `emptyStateAnimation` is `null`; choosing Static saves `emptyStateAnimation: "static"`; choosing Off saves `"off"`; and the whole saved document still contains every other key (the fixtures already assert this shape).

**Steps:**
- [ ] Write `src/components/chat/MessageList.emptyFilm.test.tsx`. **`vi.mock` the `./EmptyStateFilm` module** with a marker component that renders its props into the DOM (e.g. `<div data-testid="empty-film" data-setting={String(setting)} />`) — `MessageList` owns *delegation*, and Task 5 already tested the film itself, so this file must not try to render a real engine. Assert: (a) with `units: []` and the suppression flags clear the marker renders and its `data-setting` equals the `emptyStateAnimation` passed in — that single assertion proves the prop is threaded; (b) with `emptyStateAnimation` omitted the marker receives `"off"` (the default); (c) with `hasPendingRequest: true`, and separately `workingOrInTurn: true`, and separately `agentState: "blocked"`, the marker does NOT render; (d) the real (unmocked) `MessageList` with `units: []` and no `emptyStateAnimation` still renders `"Send a prompt to start"`, i.e. the shipped default is the text line; (e) with `units` non-empty no marker renders
- [ ] Run `pnpm test src/components/chat/MessageList.emptyFilm.test.tsx` → red (no film yet)
- [ ] Implement the `MessageList` change; re-run → green
- [ ] Run `pnpm test src/components/chat/` → green, with the pre-existing `"Send a prompt to start"` assertions untouched (they pass because the new prop defaults to `"off"` — NOT because jsdom lacks `getContext`)
- [ ] Add `EmptyStateAnimationPicker` to `controls.tsx` and the row to `AppearanceSection.tsx`
- [ ] Add the `SettingsPage.test.tsx` cases; run `pnpm test src/components/settings/SettingsPage.test.tsx` → red → green
- [ ] Run `pnpm test` and `pnpm build` from the repo root → green
- [ ] Commit: `feat(chat): show the ASCII film in the empty transcript, with an Appearance control`

**Acceptance criteria:**
- [ ] An empty session renders the film layer. All 9 `"Send a prompt to start"` assertions (2 positive, 7 `toBeNull`) across `src/components/chat/MessageList.test.tsx` and `src/components/ChatStream.test.tsx` still pass with **no edits to those files at all** — the optional prop's `"off"` default is what preserves them; if you edited any of them, the prop is required by mistake.
- [ ] Coverage stated honestly: `MessageList`-direct tests reach the film via `fallback` because the prop defaults to `"off"`, while the `ChatStream`-rendering tests reach `fallback` via the no-canvas short-circuit. Both routes render the text line; only the first is the shipped default. Verify no test file was edited to make this true.
- [ ] The film is suppressed by exactly the same three conditions the hint was (`hasPendingRequest`, `workingOrInTurn`, `agentState === "blocked"`), asserted for each.
- [ ] `TranscriptFooter` still renders in the empty branch, so a permission or `ask` gate is still visible.
- [ ] The Settings row saves `"off"` / `"static"` / `"animated"`, renders Animated selected for `null`, and a non-empty-session transcript is unaffected.
- [ ] No subagent transcript sheet gains a film.

---

### Task 7: Full validation and the manual passes

**Parallel:** none — a whole-suite run is serial by gate 4, and it is the only thing that can prove the integration. Runs 7th of 7, last.

**Context:**
Nothing so far has run the film inside the real webview, and the design explicitly assumes a platform where GL can fail silently. This task runs the repo's full bar and the two manual passes that automated tests structurally cannot make: jsdom has no canvas, no `ResizeObserver`, no `IntersectionObserver` and no `matchMedia` (fact 2), so every resize/visibility/reduced-motion behaviour proven above is proven against fakes.

**Files:** none (verification only — if anything fails, fix it in the file that owns it)

**Steps:**
- [ ] From the repo root: `pnpm test` → all green
- [ ] From the repo root: `pnpm build` → `tsc` + Vite green. Then confirm the lazy chunk is real: `ls -la dist/assets/ | sort -k5 -n | tail -5` should show a ~500 KB (minified) chunk that is NOT `index-*.js`, and `grep -c "THREE" dist/assets/index-*.js` should be `0` — proving `three` sits behind the dynamic import and a normal session never downloads it (ADR 0070).
  - Then confirm the *import site* survived, with a **quote-agnostic** grep: `grep -Eo 'import\([^)]*scene-[A-Za-z0-9_-]+\.js[^)]*\)' dist/assets/index-*.js` must print exactly one hit, i.e. `` import(`./scene-<hash>.js`) ``. Do **not** grep for the literal `import("./scene-…")`: this build is bundled by **Rolldown**, whose minifier emits the dynamic import with **backticks** — `` import(`./scene-<hash>.js`) `` — so a double-quoted pattern matches nothing even when the code is perfectly correct. The same applies to Task 5's "never evaluate the import" assertions: match the specifier, not the quoting.
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
- [ ] `three` lives in its own chunk and `index-*.js` contains no three.js, and the dynamic import site is present in the Rolldown output — `grep -Eo 'import\([^)]*scene-[A-Za-z0-9_-]+\.js[^)]*\)' dist/assets/index-*.js` prints exactly one hit (backticks, not quotes — see the step above).
- [ ] `grep -o '\.text-film-glyph{' dist/assets/*.css | wc -l` prints 1 (occurrences — **never** `grep -c`, which returns 1 for the vacuous variable string too) in the final build **with this roadmap doc deleted from the tree** (fact 11). This is the run that matters: Task 3 could only prove it by moving the doc aside, and the doc is deleted on ship — a utility generated by this file's prose would go red exactly here. Never use the `--color-film-glyph:` grep; it counts 5 from the palette blocks plus the `@theme` copy and passes vacuously.
- [ ] Resize keeps the figure undistorted across the tier steps, in both themes.
- [ ] All three control values take effect live, and reduced-motion yields a static frame.
- [ ] On the Linux pass a GL failure produces the text line, never a blank pane.

---

## Out of scope

No click-to-toggle on the film (the demo's click-to-invert is dropped — clicking the empty pane stays inert). No interactivity, camera response, or audio. No film in the **Subagent** transcript sheet. No change to the **working indicator** or its `spinnerStyle` setting. No baked/pre-rendered asset (ADR 0070 records why the offline-bake option was rejected).
