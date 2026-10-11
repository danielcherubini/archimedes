---
status: approved
done-when: "A SKILL.md carrying `disable-model-invocation: true` is absent from the `<skills>` system-prompt section, absent from `list_skills`, and refused by name by `read_skill` (with the `$name` route named back to the model) — while the Skills dialog still lists it, marked `manual only`, and `$name` still expands its body byte-identically."
---

# Model-hidden Skills: the flag that makes a Skill user-only

## Problem

`SKILL.md` files may carry the Agent Skills frontmatter key `disable-model-invocation: true` to ask that the **Agent** not pull a skill in on its own. pi honors it (`skills.js::formatSkillsForPrompt` filters `visibleSkills`). The desktop advertised every discovered skill on every surface: `SkillInfo` (`src-tauri/src/skills.rs:25`) never carried the key, so discovery parsed it away and the request was silently ignored. `prompt.rs:244-247` documented this as "no `disableModelInvocation` field, so no filtering in v1".

Decision record: **ADR 0036** (`docs/decisions/0036-model-hidden-skills.md`). Glossary: `CONTEXT.md` → **model-hidden / model-visible**, and the amended **Skill** entry.

## Language

- **model-hidden** — a Skill whose frontmatter says `disable-model-invocation: true`.
- **model-visible** — every other Skill.
- Three **model-facing surfaces**: the `<skills>` **advertisement** in the system prompt, `list_skills`, `read_skill`.
- One **user route**: the `$name` **Mention** (ADR 0031), which expands the body on send. Do not call it "invocation" — in this repo a Skill is *invoked* by a Mention.

## Behavior contract

| surface | model-hidden Skill | model-visible Skill |
|---|---|---|
| `<skills>` section | absent | advertised (name/description/location) |
| `list_skills` | absent | listed |
| `read_skill { name }` | refused: `read_skill: "<name>" is model-hidden — the Agent may not load it; ask the user to send $<name>` | body returned |
| `read_skill { name, path }` | refused identically, **before any `FsBackend` exists** | bundled file returned |
| Skills dialog | listed, marked `manual only` | listed |
| `$name` Mention | **expands, byte-identical** | expands |

Invariant: **to the Agent, a model-hidden Skill is not in the catalog.**

### The ceiling (stated, not closed)

A model-hidden Skill is unadvertised and unresolvable **by name**. It is **not confidential**: `boundary::read_roots` grants the **Boundary** the Skill discovery roots themselves (ADR 0030, so that a skill still loads at `Reads = Sandboxed`), and inside the Boundary every **Beyond-boundary policy** allows — so `read` / `grep` / `find` on the skill's `SKILL.md` stay in bounds and silent, and `ls ~/.agents/skills` prints the directory NAME regardless. The flag controls the Agent's attention, not the filesystem. Do not "fix" this by making `read` reject skill paths.

### Truthiness

`disable-model-invocation` counts as hidden **only** as the unquoted lowercase literal `true` (`rest.trim() == "true"`). `yes` / `True` / `1` / `"true"` / empty leave the Skill model-visible. This is pi parity: pi YAML-parses the frontmatter and tests `=== true`. The key must be a top-level (non-indented) frontmatter key, like `name` and `description`.

## Design

**Discovery — `src-tauri/src/skills.rs` (total, unfiltered, always).**
`SkillInfo` gains `disable_model_invocation: bool` (IPC: `disableModelInvocation`), plus an inherent `pub fn model_visible(&self) -> bool`. `parse_skill_file` gains a 4th tuple element `(name, description, body, hidden)`, recognized in the same top-level key scan that already handles `name:`/`description:`. Roots, first-wins dedupe, `is_tag_safe_name`, the 1024-char description skip rule, and totality are unchanged. `discover_skills` / `discover_in_roots` / the `list_skills` IPC command (`commands/skills.rs`) stay **unfiltered** — they are the Client's source and the `$` route's source.

**Seam 1 — `src-tauri/src/agent/harness/prompt.rs`.**
`format_skills_for_prompt` filters first and returns `String::new()` when nothing is visible (mirroring pi's early `return ""` before the header lines), then formats the remaining skills exactly as today. Because the filter lands inside the port, `build_main_prompt` must also adopt **pi's second guard**: push the `<skills>` section only when the formatted body is non-empty, replacing today's pre-filter `!ctx.skills.is_empty()` test. pi has both guards (`system-prompt.js:105` and `:107`); we have only the outer one, so without this an all-hidden Space ships an empty `<available_skills>` block — violating the promise that an omitted section leaves no trace. Delete the stale comment at `prompt.rs:244-247`.

**Seam 2 — `src-tauri/src/agent/tools/exec.rs`.**
Keep `skills_for(ctx)` as the single discovery seam (it owns the `ToolCtx::skill_roots` test seam) and add `model_skills_for(ctx) = skills_for(ctx).filter(model_visible)`.
`exec_list_skills` → `model_skills_for` (all-hidden ⇒ the existing `"none"` result).
`exec_read_skill` → `skills_for` (unfiltered), then per hit: no match → the existing `unknown skill` message unchanged; match but hidden → the route message; visible → unchanged. One discovery call serves both the lookup and the reason. The message names ONLY what the model sent — ADR 0029's path-disclosure rule (never echo a canonicalized path) applies to the new branch exactly as to `PathEscape`.

Because both tools resolve through the same `skills_for`, ADR 0029's "the tool's catalog cannot drift from the prompt's catalog" still holds — both seams now filter on the one predicate.

**Doc rot fixed in the same change.**
`prompt.rs:244-247` (the "no filtering in v1" note). `loop.rs:1965` — the `read_skill` `ToolSpec.description` claims `read` on a skill path "always fails with `path escapes the session sandbox`", which ADR 0030 made false. It is printed into every session's `<tools>` section and the model acts on it (it avoids a `read` that would succeed).

**Client — three files, one behavior.**
`src/lib/tauri.ts`: `SkillInfo` gains `disableModelInvocation: boolean`.
`src/components/SkillsDialog.tsx`: a second trailing marker span beside `global`, same classes —

```tsx
{skill.disableModelInvocation && (
  <span className="text-ui-xs text-foreground-subtlest"
        title="Not offered to the Agent — send it yourself with $name">
    manual only
  </span>
)}
```

The row stays clickable and still dispatches `archimedes:insert-skill` with `$name ` — a click on a model-hidden Skill IS the sanctioned route. The composer's `$` picker is unchanged (picking there is already deliberate). No filter toggle, no dimming.
The three fixture factories (`skills.test.ts`, `MessageBubble.test.tsx`, `SkillsDialog.test.tsx`) gain `disableModelInvocation: false` in their base literals.

## Explicitly not changed

`boundary::read_roots` · `POLICIED_TOOLS` · the Beyond-boundary policy · discovery roots/dedupe/tag-safety · `expandMentions`, the `<skill>` block, `mergeDedupeKey`, `MessageBubble` · the `StartEnv` envelope, `settings.json`, SQLite (the Worker discovers in-process at `agent/worker/core.rs:241`, so nothing crosses ADR 0025's protocol or DB) · **Agent definitions** (no analogous flag exists; none invented).

**Subagent children inherit the filter** for free: a child gets no `<skills>` section at all (ADR 0017's reduced message — ADR 0029 records the missing advertisement as an open gap) but does get both skill tools, which filter. Closing the child-catalog gap is a separate feature.

**Resume semantics.** A session's prompt is persisted at seq 0 and replayed verbatim (ADR 0017), so the flag takes effect on a **new** session in both directions; `read_skill` re-discovers on every call, so a session born before the flag will refuse a name its own `<skills>` section still advertises. Transient and accepted — mid-session section diffing is the work ADR 0017 deferred.

## Coverage required

Rust, `skills.rs`: `true` sets the flag · `yes`/`True`/`"true"`/`1`/empty do not · an indented occurrence inside a `description` block scalar is ignored · `discover_in_roots` still returns hidden skills · `SkillInfo` serializes the `disableModelInvocation` key.

Rust, `prompt.rs`: a hidden skill is absent from the `<skills>` block · all-hidden produces **no `<skills>` section and no `\n\n\n`** anywhere in the prompt · `skills_format_matches_pi_golden` stays green.

Rust, `agent/tools/exec.rs` + `tests/skill_tools_boundary.rs`: `list_skills` omits hidden and prints `none` when all are hidden · the hidden branch's message contains no path · `{ name, path }` on a hidden name fails before any `FsBackend` exists · the existing adversarial suite (traversal, absolute paths, symlinks, sibling skills, name-is-the-allowlist) stays green.

Frontend: `SkillsDialog.test.tsx` renders `manual only` and still dispatches the insert event with `$name ` · `skills.test.ts` asserts `expandMentions` output is byte-identical for a model-hidden skill, and the `$`-oracle parity test still holds. This is the guard against a later "make the flag consistent everywhere" change that would remove the only route to a hidden skill.

Green bar (`AGENTS.md`): `pnpm test` + `pnpm build` at the root; `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check` in `src-tauri/`.
