import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ShadowedSkill, SkillInfo } from "../lib/tauri";
import { IPC_EVENTS } from "../lib/ipc/events";
import SkillsDialog, { UNMENTIONABLE_ROW_REASON } from "./SkillsDialog";

/**
 * The inert row's reason, spelled VERBATIM so a reader of this file sees the
 * sentence the user sees. `UNMENTIONABLE_ROW_REASON` (exported from
 * `SkillsDialog.tsx`) is the ONE owner of the string; the equality pin below is
 * what makes the literal here a real pin instead of a second copy that can
 * drift — drop the `— rename the Skill to give it one` clause from the
 * component and both this literal and the assertions that use it go red.
 */
const REASON =
  "This name can't be typed as a mention — rename the Skill to give it one";

// The dialog is PROP-DRIVEN (it does not fetch — the fetch lives in
// `useSkillCatalog` in `SpacesList`, covered by `useSkillCatalog.test.ts`),
// so the catalog rows are passed as a prop and no `listSkills` mock is
// needed (the only tauri import is the type).
function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: "alpha",
    description: "Alpha skill",
    path: "/p/.agents/skills/alpha/SKILL.md",
    dir: "/p/.agents/skills/alpha",
    scope: "space",
    body: "B",
    disableModelInvocation: false,
    shadowed: [],
    ...overrides,
  };
}

/** One `ShadowedSkill` fixture: an entry the row above it EXCLUDED by shadowing.
 *  Its `name` is EQUAL to its winner's by construction (the name is the dedupe
 *  key — ADR 0065), so a fixture must never invent an "unrelated" loser name:
 *  that is a shape discovery can never emit. */
function shadow(overrides: Partial<ShadowedSkill> = {}): ShadowedSkill {
  return {
    name: "alpha",
    path: "/u/.pi/agent/skills/alpha/SKILL.md",
    scope: "user",
    ...overrides,
  };
}

describe("SkillsDialog", () => {
  it("the test's literal reason IS the component's one owned string", () => {
    // Single-ownership pin: the literal above is what the user reads, and this
    // asserts it is byte-identical to the component's const, so the two cannot
    // drift (the reason line, the tooltip that repeats it and these assertions
    // all come from ONE place).
    expect(REASON).toBe(UNMENTIONABLE_ROW_REASON);
    // The `$`-free rule is a property of the STRING, so it is pinned on the
    // string too — every surface that renders it inherits it.
    expect(UNMENTIONABLE_ROW_REASON).not.toMatch(/\$/);
  });

  it("renders_one_row_per_skill_with_name_and_description", async () => {
    render(
      <SkillsDialog
        skills={[
          skill(),
          skill({
            name: "beta",
            description: "Beta skill",
            path: "/p/.agents/skills/beta/SKILL.md",
            dir: "/p/.agents/skills/beta",
          }),
        ]}
        onClose={() => {}}
      />,
    );
    await screen.findByText("alpha");
    await screen.findByText("Alpha skill");
    await screen.findByText("beta");
    await screen.findByText("Beta skill");
  });

  it("user_scope_rows_carry_the_global_cue", async () => {
    // TWO SEPARATE renders — a single render with both skills would make
    // a global `queryByText("global")` ambiguous (the user row's badge
    // matches).
    const user = render(
      <SkillsDialog skills={[skill({ scope: "user" })]} onClose={() => {}} />,
    );
    await screen.findByText("global");
    user.unmount();
    const space = render(
      <SkillsDialog skills={[skill({ scope: "space" })]} onClose={() => {}} />,
    );
    expect(screen.queryByText("global")).toBeNull();
    space.unmount();
  });

  it("clicking_a_row_dispatches_the_insert_event_and_closes", async () => {
    const events: CustomEvent[] = [];
    const listener = (e: Event) => {
      events.push(e as CustomEvent);
    };
    window.addEventListener(IPC_EVENTS.insertSkill, listener);
    const onClose = vi.fn();
    try {
      // Uppercase name: the case policy lowercases the INSERTED token
      // (the mention regex is lowercase-only).
      render(<SkillsDialog skills={[skill({ name: "Alpha" })]} onClose={onClose} />);
      const row = (await screen.findByText("Alpha")).closest(
        '[role="button"]',
      );
      expect(row).not.toBeNull();
      fireEvent.click(row!);
      const dispatched = events.find(
        (e) => e.type === IPC_EVENTS.insertSkill,
      );
      expect(dispatched).toBeDefined();
      expect(dispatched!.detail).toBe("$alpha ");
      // The dialog closes on insert (one pick, one action).
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(IPC_EVENTS.insertSkill, listener);
    }
  });

  it("marks_a_model_hidden_skill_as_manual_only_but_still_inserts_the_mention", async () => {
    // ADR 0036: a model-hidden skill stays in this dialog (discovery is
    // total) and is MARKED so the user learns the flag took effect — and the
    // row keeps its behavior, because clicking it is the SANCTIONED route to
    // a hidden skill (it inserts `$name `, which `expandMentions` expands on
    // send, ADR 0031).
    const events: CustomEvent[] = [];
    const listener = (e: Event) => {
      events.push(e as CustomEvent);
    };
    window.addEventListener(IPC_EVENTS.insertSkill, listener);
    const onClose = vi.fn();
    try {
      render(
        <SkillsDialog
          skills={[skill({ name: "Omega", disableModelInvocation: true, body: "B" })]}
          onClose={onClose}
        />,
      );
      // The marker (terse, like the `global` scope cue in the same slot — the
      // glossary bans *hidden* / *disabled* in prose).
      const marker = await screen.findByText("manual only");
      expect(marker).toBeTruthy();
      // The `global` cue is a SCOPE marker and is untouched by the flag: this
      // row is space-scoped, so it shows `manual only` and NOT `global`.
      expect(screen.queryByText("global")).toBeNull();
      // The row is still clickable and still inserts the LOWERCASED token.
      fireEvent.click(screen.getByText("Omega"));
      const dispatched = events.find(
        (e) => e.type === IPC_EVENTS.insertSkill,
      );
      expect(dispatched).toBeDefined();
      expect(dispatched!.detail).toBe("$omega ");
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(IPC_EVENTS.insertSkill, listener);
    }
  });

  it("the_manual_only_tooltip_promises_no_\$mention_a_name_cannot_carry", async () => {
    // ADR 0031: a `$` token is `[a-z0-9]+(-[a-z0-9]+)*`, while discovery only
    // screens a name for tag-safety — so `has space` IS a discovered skill yet
    // `$has space` expands NOTHING. The tooltip must not promise that route
    // (the twin of `read_skill`'s refusal, which branches on the same rule).
    //
    // BOTH timing halves are asserted because they belong to DIFFERENT
    // surfaces and only one of them is deferred: the `<skills>` PROMPT SECTION
    // is what a session already running keeps (persisted at seq 0, replayed
    // verbatim on resume — ADR 0017/0036), so THAT is the half "new sessions"
    // governs; `read_skill` re-discovers on EVERY call, so the refusal is LIVE
    // and the current session loses the skill immediately. MUTATION-CHECKED:
    // drop either clause from `manualOnlyTooltip` and this test reddens.
    render(
      <SkillsDialog
        skills={[skill({ name: "has space", disableModelInvocation: true })]}
        onClose={() => {}}
      />,
    );
    const marker = await screen.findByText("manual only");
    expect(marker.getAttribute("title")).not.toMatch(/\$/);
    // Still honest about WHAT happened, and still actionable.
    expect(marker.getAttribute("title")).toContain("new sessions");
    expect(marker.getAttribute("title")).toMatch(/read_skill refuses it now/i);
    expect(marker.getAttribute("title")).toMatch(/can't be typed/i);
  });

  it("the_manual_only_tooltip_offers_the_\$mention_and_says_the_refusal_is_live", async () => {
    // A mentionable name keeps the token offer (lowercased — the insert does the
    // same), and BOTH shapes say the two different timings: the PROMPT SECTION
    // changes for NEW sessions only (a running/resumed session keeps the
    // listing it was born with — ADR 0017), while the `read_skill` refusal is
    // live because the tool re-discovers per call (ADR 0036).
    render(
      <SkillsDialog
        skills={[skill({ name: "Omega", disableModelInvocation: true })]}
        onClose={() => {}}
      />,
    );
    const marker = await screen.findByText("manual only");
    expect(marker.getAttribute("title")).toBe(
      "Hidden from the Agent — the prompt listing updates on new sessions; " +
        "read_skill refuses it now. Send it yourself with $omega",
    );
  });

  // ---------------------------------------------------------------------------
  // The inert row (issue #10, amending ADR 0036). A `$` Mention token is
  // `[a-z0-9]+(?:-[a-z0-9]+)*` (ADR 0031) while discovery screens a name merely
  // for tag-safety, so `has space` IS discovered yet NO token can ever equal it
  // — and `expandMentions` leaves an unmatched token VERBATIM. Inserting
  // `$has space ` therefore put dead text into the SENT message, while the
  // tooltip one node away already said the name can't be typed as a mention.
  // Two rules the tests below own:
  //
  // 1. The row is LISTED and INERT. The `$` catalog stays total (ADR 0036 — it
  //    feeds model-facing discovery), so the fix is the row's AFFORDANCE, not
  //    its presence: `aria-disabled="true"`, out of the tab order, click and
  //    Enter both inert, and the dialog stays open.
  // 2. The reason carries NO `$` glyph — the badge tooltip's rule, extended to
  //    the new surface, because a lie one node from the truth is this bug.
  // ---------------------------------------------------------------------------

  it("an unmentionable name is listed but its row is inert", async () => {
    // Model-VISIBLE on purpose: the flag is irrelevant to the defect (the bug
    // predates ADR 0036), and the `manual only` badge does not exist for this
    // row — a fixture with the flag set would let the fix lean on the badge.
    const events: CustomEvent[] = [];
    const listener = (e: Event) => {
      events.push(e as CustomEvent);
    };
    window.addEventListener(IPC_EVENTS.insertSkill, listener);
    const onClose = vi.fn();
    try {
      render(
        <SkillsDialog
          skills={[skill({ name: "has space", disableModelInvocation: false })]}
          onClose={onClose}
        />,
      );
      // Still LISTED — discovery stays total (ADR 0036), so the fix may not
      // delete a row the user owns. Asserted as presence, not absence.
      const name = await screen.findByText("has space");
      expect(screen.getAllByRole("button")).toContain(
        name.closest('[role="button"]'),
      );
      const row = name.closest('[role="button"]');
      expect(row).not.toBeNull();
      // The affordance is OFF: `aria-disabled` + out of the tab order (the
      // same pair `RowButton` emits for the Model picker's stale override).
      expect(row!.getAttribute("aria-disabled")).toBe("true");
      expect(row!.getAttribute("tabindex")).toBe("-1");
      // Neither activation path dispatches anything, and neither closes the
      // dialog — the guard sits in `insertSkill`, which owns the `onClose()`
      // too, not only in the click handler.
      fireEvent.click(row!);
      fireEvent.keyDown(row!, { key: "Enter" });
      expect(
        events.find((e) => e.type === IPC_EVENTS.insertSkill),
      ).toBeUndefined();
      expect(onClose).not.toHaveBeenCalled();
      // NOT merely styled away: the click-shaped classes are GONE and the
      // not-allowed cue is present, so the row does not look clickable.
      const tokens = row!.className.split(/\s+/);
      expect(tokens).toContain("cursor-not-allowed");
      expect(tokens).not.toContain("cursor-pointer");
      expect(tokens).not.toContain("hover:bg-surface-hover");
      // The truncation chain still holds (the row is still a flex item of the
      // scroll container — `SkillsDialog.test.tsx`'s other layout pin).
      expect(tokens).toContain("min-w-0");
    } finally {
      window.removeEventListener(IPC_EVENTS.insertSkill, listener);
    }
  });

  it("the inert row says why without emitting a $ glyph", async () => {
    // The hard constraint, applied to the node this task adds: the row explains
    // itself in prose that carries NO `$`, because a tooltip that reads
    // `$has space` is the exact dead token the row just stopped inserting.
    //
    // The reason is now VISIBLE TEXT (the row's second line), not a native
    // `title` only. The reason: an inert row is `tabIndex={-1}`, so a
    // keyboard-only user can never focus it, and a `title` is not reliably
    // exposed to assistive technology either — a `title`-only reason is
    // reachable with a MOUSE and with nothing else, which makes the dialog's
    // accessibility claim true for pointer users only. Visible text in the row
    // is read by everyone: it participates in the row's accessible name (the
    // `textContent` assertion below is that claim, not decoration) and needs no
    // ARIA gymnastics. The `$`-free rule applies to BOTH surfaces — the visible
    // sentence and the tooltip that carries it in full when the line truncates.
    const first = render(
      <SkillsDialog
        skills={[skill({ name: "has space", disableModelInvocation: false })]}
        onClose={() => {}}
      />,
    );
    const row = (await screen.findByText("has space")).closest(
      '[role="button"]',
    );
    expect(row).not.toBeNull();
    // VISIBLE, and INSIDE the row — a caption parked outside the row would be
    // prose the AT tree attaches to nothing in particular.
    const reason = screen.getByText(REASON);
    expect(row!.contains(reason)).toBe(true);
    // The programmatic half: the row's own text content (what the accessible
    // name computation walks for a `role="button"` with no explicit label) now
    // carries the reason, so a screen reader reads it without a hover.
    expect(row!.textContent).toMatch(/can't be typed/i);
    // Neither channel emits a `$`.
    expect(reason.textContent).not.toMatch(/\$/);
    // The tooltip survives ON THE LINE THAT NEEDS IT: this line is `truncate`d
    // (the row's pinned truncation chain), so at a narrow dialog width the
    // visible sentence clips and the full text is one hover away. The ROW no
    // longer carries a `title` of its own — the sentence is in its accessible
    // name already, and a row-level `title` would have AT say it twice.
    expect(reason.getAttribute("title")).toBe(REASON);
    expect(reason.getAttribute("title")).not.toMatch(/\$/);
    expect(row!.getAttribute("title")).toBeNull();
    // It reads as an explanation, not as a second clickable thing: no role, no
    // tabindex, no affordance classes (the shadow report's non-row lines are
    // pinned the same way).
    expect(reason.getAttribute("role")).toBeNull();
    expect(reason.getAttribute("tabindex")).toBeNull();
    first.unmount();

    // Model-hidden AND unmentionable: BOTH tooltips in the tree are `$`-free —
    // the badge's (pinned elsewhere) and the reason line's (pinned here). This
    // is what stops a future edit from folding the explanation into a
    // `$`-carrying string for the flagged shape only.
    const second = render(
      <SkillsDialog
        skills={[skill({ name: "has space", disableModelInvocation: true })]}
        onClose={() => {}}
      />,
    );
    const badge = await screen.findByText("manual only");
    expect(badge.getAttribute("title")).not.toMatch(/\$/);
    const flaggedRow = badge.closest('[role="button"]');
    // The row itself carries NO tooltip now (the sentence is in its text), and
    // the reason LINE's does — both `$`-free, and the badge's own tooltip too.
    expect(flaggedRow!.getAttribute("title")).toBeNull();
    const flaggedReason = screen.getByText(REASON);
    expect(flaggedReason.getAttribute("title")).not.toMatch(/\$/);
    expect(flaggedRow!.textContent).toMatch(/can't be typed/i);
    // The reason line is INSIDE the flagged row too (the badge's tooltip is not
    // a substitute: it is a `title` on a badge inside a row that cannot be
    // focused, i.e. the same mouse-only channel this task removes).
    expect(
      flaggedRow!.contains(screen.getByText(REASON)),
    ).toBe(true);
    second.unmount();

    // The mentionable arm is UNCHANGED — the regression pin for every row that
    // works today (no `aria-disabled` attribute at all, focusable, no tooltip
    // stealing the row's own click affordance, and NO reason line — a row that
    // can act has nothing to apologise for).
    const third = render(
      <SkillsDialog skills={[skill({ name: "Omega" })]} onClose={() => {}} />,
    );
    const activeRow = (await screen.findByText("Omega")).closest(
      '[role="button"]',
    );
    expect(activeRow).not.toBeNull();
    expect(activeRow!.hasAttribute("aria-disabled")).toBe(false);
    expect(activeRow!.getAttribute("tabindex")).toBe("0");
    expect(activeRow!.getAttribute("title")).toBeNull();
    expect(activeRow!.textContent).not.toMatch(/can't be typed/i);
    const tokens = activeRow!.className.split(/\s+/);
    expect(tokens).toContain("cursor-pointer");
    expect(tokens).toContain("hover:bg-surface-hover");
    expect(tokens).not.toContain("cursor-not-allowed");
    third.unmount();
  });

  it("the reason line coexists with the description line and never replaces it", async () => {
    // The row already explains itself with a second line (the description). The
    // reason is an ADDITIONAL line, and the description keeps its own node, its
    // own `title` and its truncation classes — the pinned truncation-chain test
    // walks those leaves by text, so folding the reason into the description
    // span (or dropping the description) would break it.
    render(
      <SkillsDialog
        skills={[
          skill({
            name: "has space",
            description: "Alpha skill",
            disableModelInvocation: false,
          }),
        ]}
        onClose={() => {}}
      />,
    );
    const row = (await screen.findByText("has space")).closest(
      '[role="button"]',
    );
    const description = await screen.findByText("Alpha skill");
    expect(row!.contains(description)).toBe(true);
    expect(description.getAttribute("title")).toBe("Alpha skill");
    const reason = screen.getByText(REASON);
    expect(row!.contains(reason)).toBe(true);
    // Both lines truncate (`min-w-0` + `truncate`) — the row's pinned chain.
    for (const line of [description, reason]) {
      expect(line.className).toContain("min-w-0");
      expect(line.className).toContain("truncate");
    }
    // The reason reads at the ROW'S explanation tone, not the app's quietest
    // caption token: the inert arm's `opacity-50` composes with
    // `text-foreground-subtlest` (foreground at 40%) into text nobody can read,
    // and the reason is the one sentence this row must deliver. MUTATION-CHECKED
    // — swap this span for a `MutedCaption` and this reddens.
    expect(reason.className).toContain("text-foreground-subtle");
    expect(reason.className.split(/\s+/)).not.toContain("text-foreground-subtlest");
    expect(reason.className).toContain("text-ui-sm");
  });


  it("a_model_visible_skill_carries_no_manual_only_marker", async () => {
    // The default (`disableModelInvocation: false`) renders no marker.
    const visible = render(
      <SkillsDialog
        skills={[skill({ name: "alpha", scope: "user" })]}
        onClose={() => {}}
      />,
    );
    await screen.findByText("alpha");
    expect(screen.queryByText("manual only")).toBeNull();
    // The scope cue still renders for a user-scope visible row.
    expect(screen.getByText("global")).toBeTruthy();
    visible.unmount();

    // And a row that genuinely LACKS the field over IPC renders none either
    // (`undefined` → falsy, the conservative default). `skill()` cannot express
    // that — it fills `disableModelInvocation: false` — so this payload is
    // built WITHOUT the key. `SkillInfo` declares the field REQUIRED because
    // the Rust DTO always fills it, so the omission is asserted on the object
    // and cast once at the prop, rather than widening the shared type to
    // optional to make a test compile.
    const legacyRow: Omit<SkillInfo, "disableModelInvocation"> = {
      name: "legacy",
      description: "Legacy skill",
      path: "/p/.agents/skills/legacy/SKILL.md",
      dir: "/p/.agents/skills/legacy",
      scope: "user",
      body: "B",
      // `shadowed` IS present — the `Omit` above is keyed on
      // `disableModelInvocation` alone (that omission is this test's subject), so
      // widening it to cover `shadowed` would defeat the test, and making the
      // field optional to dodge it would defeat the DTO.
      shadowed: [],
    };
    expect("disableModelInvocation" in legacyRow).toBe(false);
    render(
      <SkillsDialog
        skills={[legacyRow as SkillInfo]}
        onClose={() => {}}
      />,
    );
    await screen.findByText("legacy");
    expect(screen.queryByText("manual only")).toBeNull();
  });

  it("renders_the_empty_state", async () => {
    render(<SkillsDialog skills={[]} onClose={() => {}} />);
    await screen.findByText("No skills found.");
  });

  it("the_search_filters_by_name", async () => {
    render(
      <SkillsDialog
        skills={[
          skill({
            name: "debug",
            description: "Debug skill",
            path: "/p/.agents/skills/debug/SKILL.md",
            dir: "/p/.agents/skills/debug",
          }),
          skill({
            name: "beta",
            description: "Beta skill",
            path: "/p/.agents/skills/beta/SKILL.md",
            dir: "/p/.agents/skills/beta",
          }),
        ]}
        onClose={() => {}}
      />,
    );
    const search = screen.getByPlaceholderText("Search skills…");
    // Case-insensitive NAME substring: `debug` stays, `beta` is filtered out.
    fireEvent.change(search, { target: { value: "de" } });
    expect(screen.getByText("debug")).toBeTruthy();
    expect(screen.queryByText("beta")).toBeNull();
    // Nothing matches → no rows, and a muted no-match cue.
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.queryByText("debug")).toBeNull();
    expect(screen.queryByText("beta")).toBeNull();
    expect(screen.getByText('No skills match "zzz".')).toBeTruthy();
  });

  it("the dialog content is bounded (sm:max-w-3xl — not the full-width default)", async () => {
    render(<SkillsDialog skills={[skill()]} onClose={() => {}} />);
    const title = await screen.findByText("Skills");
    const content = title.closest("[data-slot=dialog-content]");
    // Token-set membership, BOTH halves, never `toContain`: `"… sm:max-w-3xl"`
    // contains the substring `max-w-3xl`, so a substring assertion cannot tell
    // a migrated caller from an unmigrated one. The bare form must be GONE:
    // `tailwind-merge` puts `max-w-3xl` and the base `sm:max-w-md` in
    // different groups, so both reach CSS and the later `sm:` rule wins above
    // 640px — this dialog would become 28rem with no test noticing.
    const classTokens = (content?.className ?? "").split(/\s+/);
    expect(classTokens).toContain("sm:max-w-3xl");
    expect(classTokens).not.toContain("max-w-3xl");
    expect(classTokens).not.toContain("sm:max-w-md");
  });

  it("the truncation chain is bounded (min-w-0 on the wrapper, the scroll container, and the row — the text cannot escape the right edge)", async () => {
    render(
      <SkillsDialog
        skills={[
          skill({
            name: "long-desc",
            description: "x".repeat(400),
            path: "/p/.agents/skills/long-desc/SKILL.md",
            dir: "/p/.agents/skills/long-desc",
          }),
        ]}
        onClose={() => {}}
      />,
    );
    const desc = await screen.findByText("x".repeat(400));
    // The leaf spans: `min-w-0` lets them shrink below their (nowrap)
    // content width so `truncate` can clip them.
    expect(desc.className).toContain("min-w-0");
    expect(desc.className).toContain("truncate");
    const name = screen.getByText("long-desc");
    expect(name.className).toContain("min-w-0");
    // AND the whole item chain between the dialog box and the spans must
    // be shrinkable: the wrapper (a grid item of the dialog), the scroll
    // container (a flex item of the wrapper), and the row (a flex item of
    // the scroll container). Without `min-w-0` at EACH level, the
    // `min-width: auto` floor (the min-content width) lets the nowrap
    // text push every ancestor past the dialog's right edge.
    const row = desc.closest("[role=button]");
    expect(row?.className).toContain("min-w-0");
    const scroll = row?.parentElement;
    expect(scroll?.className).toContain("min-w-0");
    expect(scroll?.className).toContain("overflow-y-auto");
    // Right padding keeps the row content clear of the scrollbar (which
    // sits in the container's right edge and would otherwise overlap the
    // rows' right side).
    expect(scroll?.className).toContain("pr-2");
    const wrapper = scroll?.parentElement;
    expect(wrapper?.className).toContain("min-w-0");
  });

  // ---------------------------------------------------------------------------
  // The shadowing report (ADR 0065: name is a Skill's identity, so a later root
  // contributing an existing name EXCLUDES that entry — it gets no `$` route and
  // no `read_skill` route in this Space). Two rules the tests below own:
  //
  // 1. It is NEVER a row. A row's onClick inserts `$<name> `, which resolves to
  //    the WINNER — a row for the loser is a button that loads a different file
  //    than the one you are reading. So: a non-clickable block, and the winner
  //    stays the only row for that name.
  // 2. The "hidden by" clause comes from the WINNER's scope, never the loser's.
  //    `space_roots()` contributes two roots per level (`.agents/skills`, then
  //    `.pi/skills`) and `user_roots()` returns TWO User roots
  //    (`~/.agents/skills`, then `~/.pi/agent/skills`), so a `user` loser CAN
  //    lose to a `user` winner, and a `space` loser to a same-level `space`
  //    winner in the other vendor directory — wording keyed on the loser is
  //    FALSE in shipped configurations (including the symlink farm this feature
  //    exists to serve).
  // ---------------------------------------------------------------------------

  it("renders_no_shadow_report_when_nothing_is_shadowed", async () => {
    // The "a clean install's DOM is unchanged" pin: with no shadows there is
    // NOTHING new in the tree. Passes before the implementation too — that is
    // the point of the test, not an accident of it.
    render(
      <SkillsDialog
        skills={[
          skill(),
          skill({
            name: "beta",
            scope: "user",
            path: "/u/.agents/skills/beta/SKILL.md",
            dir: "/u/.agents/skills/beta",
            shadowed: [],
          }),
        ]}
        onClose={() => {}}
      />,
    );
    await screen.findByText("alpha");
    expect(screen.queryByText(/hidden by/)).toBeNull();
  });

  it("reports_a_skill_shadowed_by_a_project_skill_with_its_path", async () => {
    // A `space` winner (`<space>/.agents/skills`) excluded a `user` entry of the
    // same name (`~/.pi/agent/skills` — the SECOND User root, which loses to
    // everything). The CAUSE says "project" because it names the WINNER.
    render(
      <SkillsDialog
        skills={[skill({ shadowed: [shadow()] })]}
        onClose={() => {}}
      />,
    );
    await screen.findByText(
      "1 skill is hidden by a space skill with the same name",
    );
    // The loser's own line carries its name AND the path the user can check.
    const path = await screen.findByText("/u/.pi/agent/skills/alpha/SKILL.md");
    const line = path.parentElement ?? path;
    expect(line.textContent).toContain("alpha");
  });

  it("pluralises_the_shadow_count", async () => {
    // Two same-named losers under one winner (the two extra roots a name can
    // lose to: the space `.pi/skills` copy and the second User root).
    render(
      <SkillsDialog
        skills={[
          skill({
            shadowed: [
              shadow({ path: "/p/.pi/skills/alpha/SKILL.md", scope: "space" }),
              shadow(),
            ],
          }),
        ]}
        onClose={() => {}}
      />,
    );
    await screen.findByText(
      "2 skills are hidden by a space skill with the same name",
    );
    expect(screen.queryByText(/1 skill is hidden/)).toBeNull();
  });

  it("a_shadow_whose_winner_is_a_global_skill_says_global", async () => {
    // THE case a loser-keyed wording gets wrong: a `user` winner
    // (`~/.agents/skills`, the FIRST User root) excluded a `user` loser
    // (`~/.pi/agent/skills`, the second). Nothing about this pair involves the
    // project, so a wording that hardcodes "hidden by a project skill" (the
    // plausible reading of "the winner is always closer") is a lie a user acts
    // on. MUTATION-CHECKED: pinning the loser's scope instead of the winner's
    // reddens `reports_a_skill_shadowed_by_a_project_skill_with_its_path`,
    // `pluralises_the_shadow_count` and `the_search_query_filters_the_shadow_report`
    // (a `user` loser under a `space` winner — the root order makes a `space`
    // loser under a `user` winner impossible); pinning "project" always reddens
    // THIS one.
    render(
      <SkillsDialog
        skills={[
          skill({
            scope: "user",
            path: "/u/.agents/skills/alpha/SKILL.md",
            dir: "/u/.agents/skills/alpha",
            shadowed: [shadow()],
          }),
        ]}
        onClose={() => {}}
      />,
    );
    await screen.findByText(
      "1 skill is hidden by a global skill with the same name",
    );
    expect(screen.queryByText(/hidden by a space skill/)).toBeNull();
  });

  it("the_shadow_report_is_not_clickable", async () => {
    // A loser has NO route in this Space: a clickable line would insert
    // `$<name> ` and therefore load the WINNER's file (the bug this task fixes).
    const events: CustomEvent[] = [];
    const listener = (e: Event) => {
      events.push(e as CustomEvent);
    };
    window.addEventListener(IPC_EVENTS.insertSkill, listener);
    const onClose = vi.fn();
    try {
      render(
        <SkillsDialog skills={[skill({ shadowed: [shadow()] })]} onClose={onClose} />,
      );
      const path = await screen.findByText("/u/.pi/agent/skills/alpha/SKILL.md");
      // Not a row, not a button, not focusable, and not STYLED as one either
      // (no hover fill, no pointer cursor) — checked on the leaf, the line and
      // the report container, because a stray wrapper is exactly the shape that
      // would reintroduce the affordance.
      const line = path.parentElement ?? path;
      for (const node of [path, line, line.parentElement ?? line]) {
        expect(node.getAttribute("role")).not.toBe("button");
        expect(node.getAttribute("tabindex")).toBeNull();
        expect(node.className.split(/\s+/)).not.toContain("hover:bg-surface-hover");
        expect(node.className.split(/\s+/)).not.toContain("cursor-pointer");
      }
      fireEvent.click(path);
      fireEvent.click(line);
      expect(events.find((e) => e.type === IPC_EVENTS.insertSkill)).toBeUndefined();
      expect(onClose).not.toHaveBeenCalled();
      // The winner is still the ONE clickable route for this name: every row
      // dispatches `$alpha `, which resolves to the winner, so a second row
      // would be a second button pointing at a file this name cannot reach.
      const routes = screen
        .getAllByRole("button")
        .filter((b) => b.textContent?.includes("alpha"));
      expect(routes).toHaveLength(1);
      // Two visible "alpha" texts — the winner's row and the report line — and
      // only ONE of them is a button.
      expect(screen.getAllByText("alpha")).toHaveLength(2);
    } finally {
      window.removeEventListener(IPC_EVENTS.insertSkill, listener);
    }
  });

  it("the_search_query_filters_the_shadow_report", async () => {
    // TWO winner+shadow pairs, because a loser's name EQUALS its winner's (the
    // dedupe key) — an "unrelated" loser name is a shape discovery cannot emit.
    // Typing `alpha` must drop beta's line along with beta's row, or the block
    // contradicts the list above it.
    render(
      <SkillsDialog
        skills={[
          skill({ shadowed: [shadow()] }),
          skill({
            name: "beta",
            path: "/p/.agents/skills/beta/SKILL.md",
            dir: "/p/.agents/skills/beta",
            shadowed: [shadow({ name: "beta", path: "/u/.pi/agent/skills/beta/SKILL.md" })],
          }),
        ]}
        onClose={() => {}}
      />,
    );
    await screen.findByText("/u/.pi/agent/skills/alpha/SKILL.md");
    await screen.findByText("/u/.pi/agent/skills/beta/SKILL.md");
    fireEvent.change(screen.getByPlaceholderText("Search skills…"), {
      target: { value: "alpha" },
    });
    expect(screen.queryByText("/u/.pi/agent/skills/beta/SKILL.md")).toBeNull();
    expect(screen.getByText("/u/.pi/agent/skills/alpha/SKILL.md")).toBeTruthy();
    // The COUNT follows the filter too (beta's group is gone, not hidden).
    expect(
      screen.getByText("1 skill is hidden by a space skill with the same name"),
    ).toBeTruthy();
  });

  it("an_empty_catalog_renders_no_shadow_report", async () => {
    // The empty state is a SIBLING branch, never a container the block can leak
    // into — a shadow riding along under "No skills found." would be absurd.
    render(<SkillsDialog skills={[]} onClose={() => {}} />);
    await screen.findByText("No skills found.");
    expect(screen.queryByText(/hidden by/)).toBeNull();
  });

  it("the_no_match_state_renders_no_shadow_report", async () => {
    render(
      <SkillsDialog
        skills={[skill({ shadowed: [shadow()] })]}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Search skills…"), {
      target: { value: "zzz" },
    });
    await screen.findByText('No skills match "zzz".');
    expect(screen.queryByText(/hidden by/)).toBeNull();
    expect(screen.queryByText("/u/.pi/agent/skills/alpha/SKILL.md")).toBeNull();
  });

  it("a_row_without_the_shadowed_key_does_not_crash_the_dialog", async () => {
    // The same IPC tolerance `legacyRow` above pins for
    // `disableModelInvocation`: a row that genuinely LACKS `shadowed` must not
    // take the dialog down (a bare `flatMap` over it yields `undefined` entries
    // that throw on the first property access). `skill()` cannot express it — it
    // fills `shadowed: []` — so the payload is built WITHOUT the key and cast
    // once at the prop, rather than widening the shared type to optional.
    const unshadowedRow: Omit<SkillInfo, "shadowed"> = {
      name: "unshadowed",
      description: "Unshadowed skill",
      path: "/p/.agents/skills/unshadowed/SKILL.md",
      dir: "/p/.agents/skills/unshadowed",
      scope: "user",
      body: "B",
      disableModelInvocation: false,
    };
    expect("shadowed" in unshadowedRow).toBe(false);
    render(
      <SkillsDialog
        skills={[unshadowedRow as SkillInfo, skill()]}
        onClose={() => {}}
      />,
    );
    await screen.findByText("unshadowed");
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.queryByText(/hidden by/)).toBeNull();
  });
});
