import { useState } from "react";
import type { SkillInfo } from "../lib/tauri";
import { isMentionableSkillName } from "../lib/skills";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

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
 * the dialog — unconditionally, so the click is NOT the surface that tells the
 * truth about an untypeable name; the tooltip is (ADR 0036). The search filters
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
   * Insert `$<name> ` into the composer (a decoupled `window`
   * CustomEvent — the composer lives in a different subtree) and close
   * the dialog. The name is LOWERCASED (the case policy: the inserted
   * token must be expandable, and the mention regex is lowercase-only).
   */
  const insertSkill = (name: string) => {
    window.dispatchEvent(
      new CustomEvent("archimedes:insert-skill", {
        detail: "$" + name.toLowerCase() + " ",
      }),
    );
    onClose();
  };

  return (
    <Dialog open onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-h-[70vh] max-w-3xl">
        <DialogHeader>
          <DialogTitle>Skills</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[calc(70vh-7.5rem)] min-w-0 flex-col gap-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills…"
          />
          {skills.length === 0 ? (
            <p className="p-3 text-ui-sm text-foreground-subtlest">
              No skills found.
            </p>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-ui-sm text-foreground-subtlest">
              No skills match "{query}".
            </p>
          ) : (
            <div className="flex min-w-0 flex-col gap-0.5 overflow-y-auto pr-2">
              {filtered.map((skill) => (
                <div
                  key={skill.path}
                  role="button"
                  tabIndex={0}
                  onClick={() => insertSkill(skill.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") insertSkill(skill.name);
                  }}
                  className="group flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1 hover:bg-surface-hover"
                >
                  <div className="flex items-center gap-2">
                    {/* `min-w-0` lets the span shrink below its content
                        width so `truncate` clips it (without it the
                        min-width:auto floor would push the row past the
                        dialog's right edge). */}
                    <span className="min-w-0 flex-1 truncate text-ui-base">
                      {skill.name}
                    </span>
                    {skill.scope === "user" && (
                      <span className="text-ui-xs text-foreground-subtlest">
                        global
                      </span>
                    )}
                    {skill.disableModelInvocation && (
                      <span
                        className="text-ui-xs text-foreground-subtlest"
                        title={manualOnlyTooltip(skill.name)}
                      >
                        manual only
                      </span>
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
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
