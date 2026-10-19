---
status: approved
issue: https://github.com/danielcherubini/archimedes/issues/55
done-when: In the Side pane, a session whose model advertises no thinking levels shows no Reasoning control of any kind — no disabled `○ Thinking` trigger, no empty line — while the Model line and the context bar are untouched; the same is true with no active session. The frontend test suite is green with the old "the thinking stub always renders" assertions inverted, and `CONTEXT.md`'s **Session config block** entry no longer claims the block is undata-gated.
---

# Hide the Reasoning line when the model has no thinking levels — Spec

## Problem

The Rust harness already omits the thinking selector for a model that advertises
no levels: `synthesize_catalog_config_options`
(`src-tauri/src/agent/session/mod.rs:1846`) pushes the `thought_level` option
only when `!current.thinking_levels.is_empty()`, and
`docs/features/model-selection.md:15` documents that as the design — "the
selector is ABSENT when the model advertises no levels".

The frontend then puts a control back. `SessionConfigBlock.tsx:141-147` renders
the thinking line unconditionally with `option={thinkingOption ?? null}`, and
`SessionConfigSelect` answers a `null` thinking option with a disabled `Button`
(`○` + `Thinking` + a chevron). So a model that cannot think — and a pane with
no session at all — still shows a dropdown that can never open. The backend
contract and the rendered UI disagree.

## The rule

**The Reasoning line renders if and only if the session's config options contain
a `thought_level` select with at least one option.**

No new derivation. `findConfigOption(configOptions, "thought_level",
"thought_level")` (`src/lib/sessionConfig.ts:144`) already returns `undefined`
for every "no thinking level" state, including a `select` whose `options` are
empty. The change is to stop the block from manufacturing a control when that
lookup came back empty.

The rule is deliberately applied to BOTH kinds of "no thinking level":

- **known** — config options are present (live or stored) and hold no
  `thought_level` option: the model genuinely advertises zero levels;
- **unknown** — there is no active session, or the session's config options are
  entirely absent (empty catalog). `findConfigOption` returns `undefined` here
  too, and that is what today paints the stub.

One rule, not two, because a control the user could never open is not worth its
line in either state, and because distinguishing them would mean threading
"do we even know the config" into a component whose whole design is that it
subscribes to one derived value.

## Rendered states

| State | Today | After |
|---|---|---|
| Live session, model has levels | populated, enabled `◑ Medium ⌄` | unchanged |
| Live session, model has **no** levels | disabled `○ Thinking ⌄` stub | **line absent** |
| Stored/archived session, model has no levels | disabled stub | **line absent** |
| Session with levels but not live (`disabled`) | populated + disabled | unchanged |
| No active session / config options absent | disabled stub | **line absent** |
| Model switched to a non-capable model | stub replaces the control | line removed |
| Model line, any of the above | disabled stub where absent | **unchanged** |
| Context bar | always | unchanged |

The block goes from "always three lines" to "two or three lines", still ordered
Model → Reasoning (when present) → Context, one control per line.

The mid-session case needs no new plumbing: a model change already re-synthesizes
and emits `config_option_update` (`session/mod.rs:1516`), so switching to a model
with no levels removes the line by itself.

## The asymmetry against the Model line (intentional)

The Model line keeps its always-rendered disabled stub. A **model** selector is
meaningful for any session — a session can always switch models, and the
picker's catalog comes from settings, not from the session's option list —
whereas a **thinking** selector is meaningless for a model that advertises no
levels. The consequence is stated plainly so it does not read as an oversight:
the block's "always renders" property is now line-specific, not block-wide.

## Diff shape

Two files, both frontend. No Rust change — the omission is already produced and
already tested there.

1. `src/components/SessionConfigBlock.tsx`
   - Wrap the thinking line in `{thinkingOption && ( … )}` so the whole `<div>`
     line is absent, not just its control.
   - Replace `option={thinkingOption ?? null}` with `option={thinkingOption}` —
     the guard makes the `null` path unreachable, so the coercion goes too.
   - Comment the asymmetry against the Model line and the reason for it (above).

2. `src/components/SessionConfigSelect.tsx`
   - Delete the `option === null && isThinking` stub arm (the `Button` carrying
     `○`, the `Thinking` label and the chevron).
   - Drop `kind: "thinking"` from the `option: null` member of
     `SessionConfigSelectProps`, leaving that variant `option: null;
     kind: "model"` only.
   - `SessionConfigBlock` is the ONLY call site left in the app — the config row
     moved out of the composer — which is what makes the arm safely dead.
   - `COMPOSER_THINKING_EDGE` / `thinkingEdge` STAY: they still ride the live
     thinking trigger. The `FULL_WIDTH_TRIGGER` comment's "FOUR sites" count
     drops to three and must be corrected.

## Tests (the exit condition — write these failing first)

- `src/components/SidePane.test.tsx:164-177` — the no-active-session case asserts
  a Thinking button exists and `container.textContent === "Model○Thinking"`.
  Invert: no Thinking control, no `○`, text is `"Model"`.
- `SidePane.test.tsx:1145-1149` (closed/history-only session) — invert to "no
  thinking control at all"; the Model stub's assertions stay.
- `SidePane.test.tsx:1573-1581` (live session, no `configOptions`) — same
  inversion.
- `SidePane.test.tsx:1216-1231` (one-control-per-line geometry) — asserts
  `lines` has length 3. Add a sibling case seeded with a model-only config
  option: `lines` has length 2 and `lines[1]` is the `context-usage-bar`, so the
  ORDER contract survives a missing Reasoning line.
- `src/components/SessionConfigSelect.test.tsx` — delete the four cases rendering
  `kind="thinking" option={null}` (`:107`, `:156`, `:179`, `:356`). The live
  thinking trigger's `w-full` / `max-w-72` contract is pinned separately, so no
  coverage is lost.

Rust: no change; `synthesize_catalog_config_options`'s omission is already pinned
in `session/mod.rs`'s tests.

## Docs

- `CONTEXT.md:227-229` — the **Session config block** entry says "three lines"
  and, under _Avoid_, "they are NOT data-gated — they always render". Both are
  now false. Reword to: two or three lines; the Reasoning line IS data-gated (it
  renders only when the session has a `thought_level` option), the Model line and
  the context bar are not.
- `docs/features/model-selection.md` — no change. Line 15 already states the
  absence rule this brings the frontend into line with.

## Out of scope

- Any Rust-side change to when the option is synthesized.
- Hiding or keeping the Model stub differently (decision: leave it).
- The collapsed pane's rail (already has no access to the block).
- The thinking-level indicator glyph and the `--color-thinking-*` ramp —
  untouched; they render on the live trigger only.
