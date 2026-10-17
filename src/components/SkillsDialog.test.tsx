import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SkillInfo } from "../lib/tauri";
import SkillsDialog from "./SkillsDialog";

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
    ...overrides,
  };
}

describe("SkillsDialog", () => {
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
    window.addEventListener("archimedes:insert-skill", listener);
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
        (e) => e.type === "archimedes:insert-skill",
      );
      expect(dispatched).toBeDefined();
      expect(dispatched!.detail).toBe("$alpha ");
      // The dialog closes on insert (one pick, one action).
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("archimedes:insert-skill", listener);
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
    window.addEventListener("archimedes:insert-skill", listener);
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
        (e) => e.type === "archimedes:insert-skill",
      );
      expect(dispatched).toBeDefined();
      expect(dispatched!.detail).toBe("$omega ");
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("archimedes:insert-skill", listener);
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
});
