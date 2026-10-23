import { useState } from "react";
import type { ShadowedSkill, SkillInfo } from "../lib/tauri";
import { IPC_EVENTS } from "../lib/ipc/events";
import { isMentionableSkillName } from "../lib/skills";
import { CatalogSearchDialog } from "./CatalogSearchDialog";
import { MutedCaption } from "./MutedCaption";
import { RowButton } from "./RowButton";
import { cn } from "./lib/utils";

/**
 * The `manual only` tooltip for a model-hidden row (ADR 0036). Two honesty
 * rules, both cheap to lose:
 *
 * 1. BOTH timings, because the flag lands on THREE surfaces at TWO different
 *    times and saying only one of them is a lie users act on (ADR 0036 owns
 *    the rule):
 *    - the `<skills>` PROMPT SECTION is what changes on NEW sessions — a
 *      session's system prompt is persisted at seq 0 and replayed verbatim on
 *      resume (ADR 0017), so a session already running keeps the listing it
 *      was born with;
 *    - BOTH skill tools re-discover on EVERY call, so they go LIVE together:
 *      set the flag mid-session and this session's next `read_skill` already
 *      refuses the name and its next `list_skills` already omits it.
 *    The old copy said only "Not offered to new sessions", which reads as "this
 *    session keeps working", and the very next `read_skill` contradicts it.
 * 2. Only promise a `$` route the grammar can actually carry (ADR 0031): a `$`
 *    token is `[a-z0-9]+(-[a-z0-9]+)*` while discovery screens a name merely
 *    for tag-safety, so a legal name like `has space` is TYPEABLE NOWHERE — the
 *    old copy told the user to send `$has space`, which expands NOTHING.
 *    `read_skill`'s refusal branches on the same rule (the Rust twin of
 *    `isMentionableSkillName` is `crate::skills::is_mentionable_name`), and the
 *    unmentionable shape carries NO `$` glyph at all, so a tooltip can never
 *    even look like a token. The `$name` offered here is LOWERCASED exactly as
 *    `insertSkill` lowercases the token it inserts.
 *
 * These TWO are the only places the rule is enforced for Skills: the composer's
 * `$` picker does NOT filter on it, because the Client's skill catalog must stay
 * total (ADR 0036) — so that picker can still offer a name this tooltip (and
 * the tool) will not promise. See ADR 0036's consequence bullet.
 */
function manualOnlyTooltip(name: string): string {
  const effect =
    "Hidden from the Agent — the prompt listing updates on new sessions; " +
    "read_skill refuses it now.";
  return isMentionableSkillName(name)
    ? `${effect} Send it yourself with $${name.toLowerCase()}`
    : `${effect} This name can't be typed as a mention`;
}

/**
 * Why a row is inert, in the row's own native tooltip (issue #10, amending ADR
 * 0036). Two wording rules, both inherited from `manualOnlyTooltip`:
 *
 * 1. NO `$` glyph anywhere. A tooltip spelling `$has space` would print the
 *    exact dead token the row just stopped inserting — and the bug this fixes
 *    was a lie one node from the truth, so the new surface obeys the same rule
 *    as the old one.
 * 2. TRUE FOR A MODEL-VISIBLE ROW TOO. The `manual only` badge (and its
 *    tooltip) renders only for a `disableModelInvocation` row, while the defect
 *    is older than and independent of that flag, so the reason must stand on
 *    its own: the first half repeats the badge's phrase VERBATIM (so the two
 *    surfaces cannot drift) and the second half names the user's own one-line
 *    fix — the frontmatter `name`, else the directory name it falls back to
 *    (ADR 0036).
 *
 * (The `manualOnlyTooltip` header above still closes with "These TWO are the
 * only places the rule is enforced for Skills". That block is pinned, so the
 * correction lives HERE and in `skills.ts`'s "WHERE it is applied" paragraph:
 * this row affordance is the third frontend site.)
 */
const UNMENTIONABLE_ROW_REASON =
  "This name can't be typed as a mention — rename the Skill to give it one";

/** The row shell, shared by both arms (geometry only — nothing cursor- or
 *  hover-shaped, so the arm below decides the entire affordance cue). */
const SKILL_ROW_BASE =
  "group flex min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-1";
/** A row that inserts something: the pointer and the hover fill it has always had. */
const SKILL_ROW_ACTIVE = "cursor-pointer hover:bg-surface-hover";
/** A row that inserts NOTHING: not allowed, and dimmed. Deliberately the ONLY
 *  cursor class on this arm — unlike `ModelPickerDialog`, which spells
 *  `cursor-pointer` AND `cursor-not-allowed` in one tailwind-merge group and so
 *  shows a POINTER on a disabled row (its own comment calls that a behaviour
 *  nobody owns). Here, dropping `cursor-pointer` is the point. */
const SKILL_ROW_INERT = "cursor-not-allowed opacity-50";

/**
 * The shadowing report's heading — and the ONE place its wording is decided.
 *
 * The clause names the WINNER's scope (the CAUSE), never the excluded entry's.
 * Keying it on the loser is FALSE in shipped configurations: `space_roots()`
 * contributes two roots per level (`.agents/skills`, then `.pi/skills`) and
 * `user_roots()` returns two User roots (`~/.agents/skills`, then
 * `~/.pi/agent/skills`), so a `user` entry can be excluded by a `user` winner
 * (`~/.pi` losing to `~/.agents`) and a `space` entry by a same-level `space`
 * winner in the other vendor directory — the symlink farm this feature exists to
 * serve is exactly that shape (ADR 0065).
 */
function shadowHeading(winnerScope: "space" | "user", count: number): string {
  return `${count} ${count === 1 ? "skill is" : "skills are"} hidden by a ${
    winnerScope === "space" ? "project" : "global"
  } skill with the same name`;
}

/**
 * The Skills modal (ZCode parity: the left pane has NO skill list — the
 * skills UI is a searchable list). One row per (filtered) skill: name
 * (primary) + description (secondary, one-line truncated, full text in a
 * `title` tooltip); user-level rows carry a subtle "global" cue, and a
 * model-hidden row carries a "manual only" cue (ADR 0036: the flag is set, so
 * the Agent is not offered this skill — the PROMPT LISTING changes for new
 * sessions while BOTH skill tools drop it live — and the USER is the one who
 * sends it; see `manualOnlyTooltip` for why both halves are stated and why the
 * cue may not promise every name).
 * Clicking a row inserts `$name ` into the composer via the
 * `archimedes:insert-skill` CustomEvent (the composer listens) and closes
 * the dialog — for a name the `$` mention grammar CAN carry. A row whose name
 * it cannot carry is LISTED BUT INERT (issue #10, amending ADR 0036): the row
 * is `disabled`, so click and Enter do nothing, the dialog stays open, and a
 * `$`-free `title` says why. The row and the tooltip therefore finally agree;
 * the catalog is still not filtered, because it stays total for model-facing
 * discovery (ADR 0036). The search filters
 * by case-insensitive NAME substring (v1: name only — the same policy as the
 * composer's skill picker).
 *
 * PROP-DRIVEN: the catalog fetch lives in `useSkillCatalog` in
 * `SpacesList` (the modal and the composer share the same hook key → one
 * fetch); the dialog receives the rows.
 */
export default function SkillsDialog({
  skills,
  onClose,
}: {
  skills: SkillInfo[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered =
    needle === ""
      ? skills
      : skills.filter((s) => s.name.toLowerCase().includes(needle));

  /**
   * The shadowing report (ADR 0065: a Skill's NAME is its identity, so when two
   * roots contribute the same name the later one is EXCLUDED — it gets no `$`
   * mention route and no `read_skill` route in this Space). The fact belongs
   * HERE because this dialog is the one surface that sees the merged catalog
   * (`SpacesList` passes `useSkillCatalog(activeSpacePath)`), so it is the only
   * place a user can learn an entry they wrote is dead.
   *
   * `?? []` is the same IPC tolerance `legacyRow` pins in the tests (a row that
   * genuinely lacks a field), NOT defensive noise: a bare `flatMap` over such a
   * row yields `undefined` entries that throw on the first property access and
   * take the whole dialog down.
   *
   * Filtered by the SAME needle the rows use, so the block can never
   * contradict the list above it.
   */
  const shadows = skills
    .flatMap((s) => s.shadowed ?? [])
    .filter((s) => needle === "" || s.name.toLowerCase().includes(needle));

  /**
   * Grouped by the WINNER's scope, because the clause names the CAUSE. The
   * loser's scope says nothing usable: `space_roots()` contributes TWO roots per
   * level (`.agents/skills`, then `.pi/skills`) and `user_roots()` returns TWO
   * User roots (`~/.agents/skills`, then `~/.pi/agent/skills`), so a `user`
   * loser can lose to a `user` winner and a `space` loser to a same-level
   * `space` winner in the other vendor directory — "hidden by a project skill"
   * keyed on the LOSER would be false in shipped configurations, including the
   * symlink farm this feature exists to serve.
   *
   * The winner lookup resolves for every shape discovery emits: a loser's name
   * is EQUAL to its winner's by construction (the name is the dedupe key), and
   * the winner is a row in this same catalog.
   */
  const shadowGroups: { scope: "space" | "user"; losers: ShadowedSkill[] }[] = [];
  for (const loser of shadows) {
    const winner = skills.find(
      (s) => s.name.toLowerCase() === loser.name.toLowerCase(),
    );
    const scope = winner?.scope ?? loser.scope;
    const group = shadowGroups.find((g) => g.scope === scope);
    if (group) group.losers.push(loser);
    else shadowGroups.push({ scope, losers: [loser] });
  }

  /**
   * Insert `$<name> ` into the composer (a decoupled `window`
   * CustomEvent — the composer lives in a different subtree) and close
   * the dialog. The name is LOWERCASED (the case policy: the inserted
   * token must be expandable, and the mention regex is lowercase-only).
   *
   * GUARDED, and deliberately so (issue #10). A name the `$` grammar cannot
   * carry expands to NOTHING — `expandMentions` leaves an unmatched token
   * VERBATIM — so inserting one records dead text in the SENT message. The
   * guard is TWO deep: `RowButton` refuses a click/Enter on a `disabled` row,
   * and this is the same check, kept because this function OWNS the side effect
   * (the dispatch AND the `onClose()`) and must not depend on its only caller
   * having filtered — the exact reason `ModelPickerDialog`'s `select` keeps its
   * own `if (item.disabled) return`. Deleting either half is safe today and a
   * trap the day a second caller appears. The early return skips `onClose()`
   * too: an inert row leaves the dialog OPEN, because such a row is listed for
   * discovery and not for action.
   */
  const insertSkill = (name: string) => {
    if (!isMentionableSkillName(name)) return;
    window.dispatchEvent(
      new CustomEvent(IPC_EVENTS.insertSkill, {
        detail: "$" + name.toLowerCase() + " ",
      }),
    );
    onClose();
  };

  return (
    <CatalogSearchDialog<SkillInfo>
      open
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      title="Skills"
      searchPlaceholder="Search skills…"
      query={query}
      onQueryChange={setQuery}
      rows={filtered}
      keyOf={(skill) => skill.path}
      emptyMessage={
        skills.length === 0
          ? "No skills found."
          : filtered.length === 0
            ? `No skills match "${query}".`
            : null
      }
      renderRow={(skill) => {
        // The row's OWN mentionability, decided once and used twice: for the
        // affordance (`RowButton`'s `disabled`, which emits
        // `aria-disabled="true"` + `tabIndex={-1}` and makes click AND Enter
        // inert) and for the reason tooltip. The row stays LISTED either way —
        // the `$` catalog is deliberately total (ADR 0036: the same catalog
        // feeds model-facing discovery), so the honest seam is the row's
        // affordance, not its presence. Do not hand-write any of those three
        // attributes here, and do not add a second `role="button"` anywhere in
        // a row: the whole suite reaches rows through
        // `.closest('[role="button"]')`.
        const mentionable = isMentionableSkillName(skill.name);
        return (
          <RowButton
            onClick={() => insertSkill(skill.name)}
            disabled={!mentionable}
            title={mentionable ? undefined : UNMENTIONABLE_ROW_REASON}
            className={cn(
              SKILL_ROW_BASE,
              mentionable ? SKILL_ROW_ACTIVE : SKILL_ROW_INERT,
            )}
          >
            <div className="flex items-center gap-2">
              {/* `min-w-0` lets the span shrink below its content
                  width so `truncate` clips it (without it the
                  min-width:auto floor would push the row past the
                  dialog's right edge). */}
              <span className="min-w-0 flex-1 truncate text-ui-base">
                {skill.name}
              </span>
              {skill.scope === "user" && <MutedCaption>global</MutedCaption>}
              {skill.disableModelInvocation && (
                <MutedCaption title={manualOnlyTooltip(skill.name)}>
                  manual only
                </MutedCaption>
              )}
            </div>
            {skill.description !== "" && (
              <span
                className="min-w-0 truncate text-ui-sm text-foreground-subtle"
                title={skill.description}
              >
                {skill.description}
              </span>
            )}
          </RowButton>
        );
      }}
    >
      {/* The shadowing report — a SIBLING of the three-branch ternary above,
          never inside the rows branch, and gated on its OWN non-empty
          condition so it can never ride along under either empty state.

          Deliberately NOT a row: a row's onClick inserts `$<name> `, and
          that token resolves to the WINNER — a row for an excluded entry is
          a button that loads a different file than the one you are reading.
          So this is plain text (no `role="button"`, no `tabIndex`, no
          `onClick`, no hover affordance) and the winner stays the only row
          for the name. Existing tokens only. */}
      {shadowGroups.length > 0 && (
        <div className="flex min-w-0 flex-col gap-0.5 overflow-y-auto">
          {shadowGroups.map((group) => (
            <div key={group.scope} className="flex min-w-0 flex-col gap-0.5">
              {/* The CAUSE names the WINNER's scope (see `shadowGroups`). */}
              <p className="text-ui-sm text-foreground-subtlest">
                {shadowHeading(group.scope, group.losers.length)}
              </p>
              {group.losers.map((loser) => (
                <div
                  key={loser.path}
                  className="flex min-w-0 items-center gap-2 text-ui-xs text-foreground-subtlest"
                >
                  <span className="min-w-0 truncate">{loser.name}</span>
                  <span className="min-w-0 truncate" title={loser.path}>
                    {loser.path}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </CatalogSearchDialog>
  );
}
