/**
 * Node's `fs`, reached through a COMPUTED specifier (no `@types/node` in this
 * app — see `src/lib/cssSource.ts` and `src/lib/themeTokens.test.ts:665-675`).
 */
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsIcon } from "lucide-react";
import { cn } from "@/components/lib/utils";
import { badgeVariants } from "@/components/ui/badge";
import {
  SettingsBadge,
  SettingsDataRow,
  SettingsGroupCard,
  SettingsRow,
  SettingsSidebarButton,
  closedSelectValue,
  openSelectItems,
} from "./primitives";

// The primitives wrap Radix primitives (the `SettingsSidebarButton` tooltip).
// The environment it needs — the pointer-capture trio + `matchMedia` +
// `scrollIntoView` — is installed once for the whole suite in
// `src/test/setup.tsx`, so this file's own 12-line `beforeAll` block is gone
// (the rolling migration from B4a: a touched test file drops the stubs the
// shared setup now owns; this file is not one of the four `unstubAllGlobals`
// files that must keep theirs).

describe("the select value helpers (a stored value outside the option list)", () => {
  // The settings document is user-editable and the backend round-trips these
  // fields unvalidated, so any string can reach a picker. Radix renders NO
  // label for a value with no matching item, which blanks the trigger.
  const PALETTE = ["zai", "dracula"] as const;

  it("closedSelectValue keeps an offered value and falls back otherwise", () => {
    expect(closedSelectValue("dracula", PALETTE, "zai")).toBe("dracula");
    expect(closedSelectValue("solarized", PALETTE, "zai")).toBe("zai");
    // Absent AND blank both mean "the default" (the blank `palette` is not a
    // palette, and Radix rejects an empty-valued item anyway).
    expect(closedSelectValue(null, PALETTE, "zai")).toBe("zai");
    expect(closedSelectValue(undefined, PALETTE, "zai")).toBe("zai");
    expect(closedSelectValue("", PALETTE, "zai")).toBe("zai");
    // Case-sensitive: `"Dracula"` is not `"dracula"` — the app would render
    // Zai for it, so the trigger must not claim otherwise.
    expect(closedSelectValue("Dracula", PALETTE, "zai")).toBe("zai");
  });

  it("openSelectItems surfaces an off-list value as its own option", () => {
    const options = [
      { value: "default", label: "Default (Noto Sans)" },
      { value: '"Fira Sans"', label: "Fira Sans" },
    ];
    // An offered value: the list is untouched and no duplicate is added.
    expect(openSelectItems('"Fira Sans"', options)).toEqual({
      value: '"Fira Sans"',
      items: options,
    });
    // An off-list value: selected, and appended as its own item so the trigger
    // has a label to render (the font family really IS applied).
    expect(openSelectItems("Georgia", options)).toEqual({
      value: "Georgia",
      items: [...options, { value: "Georgia", label: "Georgia" }],
    });
    // Absent / blank → the first option (the `"default"` sentinel) and the
    // ORIGINAL list — no empty-valued item.
    expect(openSelectItems(null, options)).toEqual({
      value: "default",
      items: options,
    });
    expect(openSelectItems("", options)).toEqual({ value: "default", items: options });
  });
});

describe("settings primitives (the ZCode port)", () => {
  it("SettingsRow_renders_label_description_and_control", () => {
    const { container } = render(
      <SettingsGroupCard>
        <SettingsRow
          label="Theme"
          description="The app theme"
          control={
            <button type="button" aria-label="theme-control">
              C
            </button>
          }
        />
      </SettingsGroupCard>,
    );
    expect(screen.getByText("Theme")).toBeTruthy();
    expect(screen.getByText("The app theme")).toBeTruthy();
    expect(screen.getByRole("button", { name: "theme-control" })).toBeTruthy();
    // The row is the `border-t` divider row (`first:border-t-0` for the top row).
    const row = container.querySelector(".border-t") as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.className).toContain("first:border-t-0");
  });

  it("SettingsSidebarButton_active_state", () => {
    const onClick = vi.fn();
    render(
      <SettingsSidebarButton
        icon={SettingsIcon}
        label="General"
        active
        onClick={onClick}
      />,
    );
    const button = screen.getByRole("button", { name: "General" });
    // Active = the surface-hover fill; inactive would be `hover:bg-surface-hover`.
    expect(button.className).toContain("bg-surface-hover");
    expect(button.className).not.toContain("hover:bg-surface-hover");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("SettingsGroupCard_renders_children_in_a_card", () => {    const { container } = render(
      <SettingsGroupCard>
        <span>child-content</span>
      </SettingsGroupCard>,
    );
    expect(screen.getByText("child-content")).toBeTruthy();
    const card = container.querySelector('[data-slot="card"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.className).toContain("rounded-xl");
    expect(card.className).toContain("bg-card");
  });
});

describe("SettingsDataRow — the settings LIST row (Finding 6b)", () => {
  /** The shell `ProviderSection.tsx`, `McpSection.tsx` and `SessionsSection.tsx`
   *  each hand-rolled, verbatim. A LITERAL: the row's whole justification is that
   *  this one string stops being spelled three times, so the pin has to be the
   *  string itself and not something recomputed from the component. */
  const HAND_ROLLED_SHELL = "border-t border-border px-4 py-3 first:border-t-0";

  /** The row root, read the way the suite already reads a settings row. */
  const rowRoot = (container: HTMLElement): HTMLElement =>
    container.querySelector(".border-t") as HTMLElement;

  it("renders the hand-rolled shell byte-identically on its root", () => {
    const { container } = render(
      <SettingsGroupCard>
        <SettingsDataRow>
          <span>row-child</span>
        </SettingsDataRow>
      </SettingsGroupCard>,
    );
    expect(rowRoot(container).className).toBe(HAND_ROLLED_SHELL);
    expect(screen.getByText("row-child")).toBeTruthy();
  });

  it("keeps `border-t` ON THE ROOT — the tests that locate rows by that class keep finding the row", () => {
    // `SettingsPage.test.tsx:940,1352,1497` do `document.querySelectorAll(".border-t")`
    // and `SessionsSection.test.tsx:93` does
    // `getByText(path).closest('[class*="border-t"]')`. Both must resolve to the
    // ROW, so the divider may not move to an inner element or a pseudo-element.
    // Asserted through BOTH query shapes, because those are the two in use.
    const { container } = render(
      <SettingsGroupCard>
        <SettingsDataRow>
          <span>/tmp/alpha</span>
        </SettingsDataRow>
      </SettingsGroupCard>,
    );
    const rows = container.querySelectorAll(".border-t");
    expect(rows).toHaveLength(1);
    expect(screen.getByText("/tmp/alpha").closest('[class*="border-t"]')).toBe(
      rows[0],
    );
    // And the divider is a real border in the theme's colour, at the row's own
    // padding — the five utilities the three sections agreed on.
    for (const utility of [
      "border-t",
      "border-border",
      "px-4",
      "py-3",
      "first:border-t-0",
    ]) {
      expect(rows[0]!.className).toContain(utility);
    }
  });

  it("adds NO DOM of its own: the row's children stay direct children of the divider row", () => {
    // The three sections each put their own layout div inside the shell (a
    // `grid` for a provider, a `flex flex-wrap` for the two list rows). A
    // wrapper element here would insert a level between the divider row and that
    // layout, which `SessionsSection.test.tsx`'s row-root reads would then see.
    const { container } = render(
      <SettingsGroupCard>
        <SettingsDataRow>
          <span>row-child</span>
        </SettingsDataRow>
      </SettingsGroupCard>,
    );
    const row = rowRoot(container);
    expect(row.children).toHaveLength(1);
    expect(row.firstElementChild).toBe(screen.getByText("row-child"));
  });

  it("is NOT SettingsRow: no label/control grid, no label or description markup", () => {
    // The report is explicit that a data row must NOT be routed through
    // `SettingsRow`, and this is the pin for it: `SettingsRow` forces
    // `grid-cols-[minmax(0,1fr)_192px]` plus a label/description column, neither
    // of which a list row can carry (each section sizes its own content).
    const { container } = render(
      <SettingsGroupCard>
        <SettingsDataRow>
          <span>row-child</span>
        </SettingsDataRow>
      </SettingsGroupCard>,
    );
    expect(rowRoot(container).className).not.toContain("grid-cols-");
  });

  it("merges a `className` override without dropping the divider", () => {
    // A settings row sometimes needs different padding (`McpSection.tsx:436`'s
    // empty-state variant is exactly that), so the override goes through `cn()`
    // and is allowed to win — the same contract `IpcErrorLine`'s `className` has.
    const { container } = render(
      <SettingsGroupCard>
        <SettingsDataRow className="px-6">
          <span>row-child</span>
        </SettingsDataRow>
      </SettingsGroupCard>,
    );
    const row = rowRoot(container);
    expect(row.className).toContain("border-t");
    expect(row.className).toContain("px-6");
    // `cn()` resolves the horizontal-padding conflict in the caller's favour.
    expect(row.className).not.toContain("px-4");
  });
});

describe("SettingsBadge — `badgeVariants` is the WRONG home (Finding 6c, route (b))", () => {
  /** Today's class, verbatim. A LITERAL: this is the box 20 call sites render
   *  and the box the decision was made against. */
  const SETTINGS_BADGE_CLASS =
    "rounded-md bg-surface px-2.5 py-1 text-ui-base font-medium text-foreground-subtle";

  /** The base of `badgeVariants`, lifted from the shipped primitive's `cva(`
   *  call so this cannot drift from it (the same reader trick
   *  `themeTokens.test.ts` uses; `badgeVariants({})` would NOT do — cva folds
   *  `defaultVariants.variant = "default"` in, so it is base + `default` arm). */
  const badgeSource = readFileSync("src/components/ui/badge.tsx", "utf8");
  const badgeBase = badgeSource
    .slice(badgeSource.indexOf("cva(") + 4)
    .match(/^\s*\n?\s*"([\s\S]*?)",/)![1];

  it("renders its own class and keeps `title` (the tooltip 3 sections rely on)", () => {
    // `WebSearchSection.test.tsx:120` reads `getAttribute("title")` on the error
    // badge, so `title` is not decoration — it is the way a truncated error
    // reaches the user. Any future move of this component must carry it.
    const { container } = render(
      <SettingsBadge title="Invalid API key 401">error</SettingsBadge>,
    );
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toBe(SETTINGS_BADGE_CLASS);
    expect(badge.getAttribute("title")).toBe("Invalid API key 401");
    expect(badge.textContent).toBe("error");
  });

  it("the base geometry a `settings` variant would inherit is exactly the geometry that fights this box", () => {
    // The finding, as a measurement rather than a claim. The report's premise
    // was that `variant: "settings"` makes `SettingsBadge` byte-identical; it is
    // not, because `badgeVariants`' BASE (not the arm) carries all of these, and
    // a cva arm is APPENDED to the base — so every one of them lands on the
    // rendered element unless the arm negates it.
    for (const utility of [
      "h-5",
      "w-fit",
      "rounded-full",
      "px-2",
      "py-0.5",
      "text-ui-xs",
      "overflow-hidden",
      "transition-all",
      "[&>svg]:size-2.5!",
    ]) {
      expect(badgeBase.split(/\s+/), `base lost ${utility}`).toContain(utility);
    }
  });

  it("merging the settings class onto that base does NOT reproduce the settings box", () => {
    // Route (a) was "neutralise the base in the arm, then verify". Measured with
    // the real `cn()` (clsx + tailwind-merge, with the `text-ui-*` font-size
    // extension), the most aggressive neutralising arm still cannot reach parity:
    // the base contributes utilities the settings badge has NO answer for, and
    // every one of them is a behaviour or geometry change on all 20 sites.
    const neutralisingArm =
      "bg-surface text-foreground-subtle h-auto w-auto gap-0 overflow-visible rounded-md border-0 px-2.5 py-1 text-ui-base transition-none [&>svg]:size-auto!";
    // Exactly what `Badge` renders: `cn(badgeVariants({ variant }), className)`.
    const merged = cn(`${badgeBase} ${neutralisingArm}`);
    const mergedTokens = new Set(merged.split(/\s+/));
    const wanted = new Set(SETTINGS_BADGE_CLASS.split(/\s+/));

    // The arm does win every conflict it can name — that half of route (a) works.
    for (const utility of wanted) {
      expect(mergedTokens, `merged dropped ${utility}`).toContain(utility);
    }
    // …but the base survives with utilities a settings badge must not have.
    const extras = [...mergedTokens].filter((t) => !wanted.has(t));
    expect(extras).toEqual(
      expect.arrayContaining([
        // `inline-flex` + `items-center` + `shrink-0`: today's badge is a plain
        // INLINE box in a flex row; this makes it a flex container.
        "inline-flex",
        "items-center",
        "shrink-0",
        // A 1px transparent border the settings badge never had (it changes the
        // box by 2px even when `border-0` is fought — see `border-transparent`).
        "border-transparent",
        // Focus machinery that fires on a badge nothing can focus.
        "focus-visible:border-ring",
        "focus-visible:ring-[3px]",
        // An `!important` icon resize the base keeps alongside the negation.
        "[&>svg]:pointer-events-none",
        // A selector arm for `<a>` badges, which a settings badge never is.
        "group/badge",
      ]),
    );
    // The `defaultVariants` half of that trap, measured on the real cva: asking
    // for no variant is NOT asking for the base, it is asking for base + default.
    expect(badgeVariants({}).split(/\s+/)).toContain("[a]:hover:bg-primary/80");
    expect(badgeVariants({}).split(/\s+/)).toContain("bg-primary");
    // So the rendered class string is NOT the settings badge's, and the utility
    // SET differs too (the C3 lesson: "byte-identical" has to mean the set).
    expect(merged).not.toBe(SETTINGS_BADGE_CLASS);
    expect(extras.length).toBeGreaterThan(10);
  });

  it("records the decision: no `settings` variant exists, and `SettingsBadge` stays the owner", () => {
    // The guard against a later iteration "finishing" Finding 6c by adding the
    // variant. Route (b) is the recorded answer, and this pins it so the finding
    // cannot be re-litigated by someone who has not re-run the measurement above.
    expect(badgeSource).not.toMatch(/\bsettings\s*:/);
    expect(badgeSource).toContain("recorded decision, not an omission");
    // `SettingsBadge` is still the component the 20 sites render, and it is still
    // the only place the settings badge's box is spelled.
    const primitives = stripJsComments(readFileSync("src/components/settings/primitives.tsx", "utf8"));
    expect(primitives).toContain(SETTINGS_BADGE_CLASS);
  });
});

/** The comment-stripping reader `src/lib/themeTokens.test.ts:697` documents and
 *  for the documented reason: a class name that appears only in a doc-comment is
 *  PROSE, not a consumer, and the source gates below count consumers. Block
 *  comments and whole-line `//` comments only — a trailing `// note` is not
 *  stripped (telling one from a `"https://…"` string needs a parser this repo
 *  does not ship). */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

describe("the settings data-row shell is spelled once (Finding 6b's acceptance)", () => {
  /** Every file that once hand-rolled the shell, plus the primitive that now
   *  owns it. Listed (not walked) because the claim is about THESE files.
   *
   *  `GeneralSection.tsx` and `UpdateSection.tsx` joined this list in Task C8.
   *  C2 folded the three rows that carried `first:border-t-0` and left these two
   *  open precisely because they do NOT — see the test below for why that turned
   *  out not to block the fold. */
  const FILES = [
    "src/components/settings/primitives.tsx",
    "src/components/settings/ProviderSection.tsx",
    "src/components/settings/McpSection.tsx",
    "src/components/settings/SessionsSection.tsx",
    "src/components/settings/GeneralSection.tsx",
    "src/components/settings/UpdateSection.tsx",
  ];

  it("only primitives.tsx spells the row shell; every section imports it", () => {
    // Vacuity guard first (an empty list would make the filter below pass for the
    // wrong reason — the lesson `themeTokens.test.ts` records).
    expect(FILES).toHaveLength(6);
    const spellers = FILES.filter((file) =>
      // The shell minus `first:border-t-0`, so the gate also catches a section
      // that keeps the padding and drops the first-row reset.
      stripJsComments(readFileSync(file, "utf8")).includes(
        "border-t border-border px-4 py-3",
      ),
    );
    expect(spellers).toEqual(["src/components/settings/primitives.tsx"]);
    // And each section really reaches the primitive — a section that deleted its
    // row markup entirely would satisfy the gate above for the wrong reason.
    for (const file of FILES.slice(1)) {
      expect(stripJsComments(readFileSync(file, "utf8"))).toContain(
        "SettingsDataRow",
      );
    }
  });

  it("the two rows C2 left open render through SettingsDataRow with no override", () => {
    // C2's follow-up note recorded these two hand-rolled shells as "not drop-in
    // `SettingsDataRow` users" because they lack `first:border-t-0`. C8 checked
    // WHY, rather than assuming the difference was load-bearing, and found it is
    // INERT at both sites:
    //   · `GeneralSection`'s enabled-tools row is the LAST child of its
    //     `SettingsGroupCard`, after three `PolicyRow`s and eight `SettingsRow`s;
    //   · `UpdateSection`'s progress row is rendered AFTER its two `SettingsRow`s
    //     and is the card's last child.
    // `first:` is CSS `:first-child`, so on a row that is never first the utility
    // can never match. Adopting the primitive's shell therefore changes no
    // rendered border in any reachable state — and it makes the reset correct by
    // construction if a future section ever does put one of these first.
    //
    // Asserted on the SOURCE because neither file has a test of its own and
    // `SettingsPage.test.tsx` locates rows positionally, not by class list.
    for (const file of [
      "src/components/settings/GeneralSection.tsx",
      "src/components/settings/UpdateSection.tsx",
    ]) {
      const source = stripJsComments(readFileSync(file, "utf8"));
      // The primitive is used…
      expect(source, file).toContain("<SettingsDataRow>");
      // …and NOT with a `className` override: an override here would be a
      // same-group fight (`px-4`/`py-3` are already the base's) with nothing to
      // win, and a `first:border-t` override would be the one way to RE-ADD the
      // top border these rows never had, silently.
      expect(source, file).not.toMatch(/<SettingsDataRow\s+className/);
    }
  });
});
