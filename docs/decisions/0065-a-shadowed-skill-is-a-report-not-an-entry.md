---
status: accepted
date: 2026-10-19
superseded-by:
---

# A shadowed Skill is a report, not an entry

When several **Skill** discovery roots contribute the same **name**, the nearest root wins (Space before user, innermost project level before outer — unchanged, and pi-parity) and the excluded Skills are **Shadowed**: disclosed in the Skills dialog as a count plus each loser's name, path and scope, rather than listed as entries of their own. **Name** — not path — stays a Skill's identity, so a shadowed Skill stays unaddressable.

**Why:** every model-facing seam resolves a Skill by name — `read_skill` takes a `name` param, `list_skills` prints `name (scope): description`, the `<available_skills>` prompt section's only handle for the Agent is `<name>`, and `$name` **Mention** expansion looks up `name.toLowerCase()`. Advertising two entries under one name would give the Agent a handle that resolves to whichever the harness happens to pick first, and it would break the byte-for-byte parity `prompt.rs` is built to hold against pi. The dialog makes the same fact decisive from the other side: a row's click inserts `$<name>`, so a row for a loser is a button that loads a *different file* than the one the user is reading. Disclosure is the only shape that is true in both directions.

**Considered Options**

- **Path as identity** (both Skills advertised, both loadable, `read_skill` disambiguates by scope-qualified name or a dir param): rejected — two identical `<name>` entries is a name the model cannot address, and it abandons pi parity in the prompt text.
- **Both survive and an ambiguous name refuses**, listing both candidates: rejected — a collision the user does not know about would turn every `$name` and every `read_skill` into a failure, so a cloned repo's Skill could disable the user's own global one. That inverts the harm: today a shadow is invisible, and this would make it disabling.
- **Annotate the winning row** ("hiding 1 global"): rejected as the sole surface — the fact is about the loser, and one winner can shadow losers from several roots, so the annotation describes a set the row cannot hold.

**Consequences**

- **A shadowed Skill has no `$` route and no tool route in that Space** — it is reachable only by opening the Space that owns it, or by renaming. The dialog says so by naming the winner's root, and this is the intended behavior, not a gap.
- **Silent ≠ shadowed.** Two exclusions stay silent and are *not* shadows: the same file reached through two roots (already collapsed by the canonical path in `walk`'s shared `seen` set) and a byte-identical `SKILL.md` present in two roots. Only a genuinely different file under the same name is reported.
- **The report is recorded after the validity checks**, not at the dedupe point. The reorder moved the dedupe BELOW the tag-safety guard — the `"`/control-character check on a Skill's `path`/`dir` — which was the ONLY rejection that had been sitting above it; the other two rejections the code performs, an unparseable name and a `description` over 1024 chars, live inside `parse_skill_file`, which already ran ahead of the dedupe. So recording a loser at the old dedupe point would report as "hidden" a Skill that was never eligible to be listed, and would surface a path discovery deliberately refuses to surface.
- **The same reporting applies to Agent definitions**, which shadow identically (`agents.rs`): the rule and the `Shadowed<T>` shape are shared with `skills.rs`, and the line-ending normalization has ONE owner (`skills::normalize_line_endings`) rather than a second copy. It is computed on `AgentDefinition` and **NOT carried on `AgentDefinitionDto`** — the DTO deliberately excludes the fields the UI doesn't need, `path` among them, and the report is BUILT of loser paths, so carrying it would re-introduce exactly what the DTO drops. It is also NOT rendered yet, and cannot be rendered where it is computed today: **Settings → Subagents** calls `discover_agents(None)` — user-level roots only — and the Settings page is app-global, with no active Space to pass as `cwd`, so it structurally cannot see a Space-shadowing-user collision. The surface is a per-Space Agents popup modelled on the Skills dialog, at which the report block moves over unchanged; until it exists the agent-side data is computed and unused. (`agents.rs` needs no reorder of its own for this: it has no tag-safety skip, because an agent file's `path` is never interpolated unescaped into a prompt tag.)
