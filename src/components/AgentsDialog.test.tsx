import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentConfigDto,
  AgentOverrides,
  AppSettings,
  ModelDto,
  ShadowedAgent,
} from "../lib/tauri";
import AgentsDialog from "./AgentsDialog";

/**
 * The dialog is PROP-DRIVEN (the fetch lives in `useAgentCatalog`, the save
 * lives in the mount), so this file needs NO IPC mock — the same shape
 * `SkillsDialog.test.tsx` has, including its local `skill()` / `shadow()`
 * factory pattern.
 */

function row(overrides: Partial<AgentConfigDto> = {}): AgentConfigDto {
  return {
    name: "scout",
    description: "Fast recon",
    scope: "space",
    path: "/p/.agents/agents/scout.md",
    // Every column `null` = nothing below the explicit `subagent` param speaks.
    file: { model: null, thinking: null, tools: null },
    override: { model: null, thinking: null, tools: null },
    effective: { model: null, thinking: null, tools: null },
    source: { model: "parent", thinking: "parent", tools: "parent" },
    shadowed: [],
    ...overrides,
  };
}

/** One `ShadowedAgent` fixture: an entry the row above it EXCLUDED (ADR 0065).
 *  Its `name` EQUALS its winner's by construction (the name is the dedupe key),
 *  so a fixture must never invent an "unrelated" loser name. */
function shadow(overrides: Partial<ShadowedAgent> = {}): ShadowedAgent {
  return {
    name: "scout",
    path: "/u/.pi/agent/agents/scout.md",
    scope: "user",
    ...overrides,
  };
}

const MODELS: ModelDto[] = [
  {
    id: "Qwen3.8",
    provider: "tama",
    contextWindow: 200_000,
    supportsThinking: true,
    thinkingLevels: ["high", "medium", "low"],
  },
  {
    id: "GPT-5",
    provider: "openai",
    contextWindow: 400_000,
    supportsThinking: false,
    thinkingLevels: [],
  },
];

const TOOLS = ["read_file", "grep"];

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    theme: "dark",
    palette: null,
    paneLayout: {},
    defaultTrustNewSpaces: false,
    defaultModel: "tama/Qwen3.8",
    defaultThinkingLevel: null,
    enabledTools: [],
    providers: [
      {
        id: "tama",
        name: "Tama",
        baseUrl: "https://example.test",
        apiKey: "",
        api: "openai-completions",
      },
    ],
    mcpServers: {},
    font: { sizePx: 14, uiFamily: null, codeFamily: null },
    defaultThinkingLevels: {},
    agentOverrides: {},
    spinnerStyle: null,
    filePolicy: { reads: "allow", writes: "allow", shell: "allow" },
    web: {
      braveApiKey: "",
      tavilyApiKey: "",
      perplexityApiKey: "",
      searxngUrl: "",
      defaultProvider: "auto",
      proxy: "",
    },
    mcpMentionsEnabled: false,
    sessionNamingEnabled: true,
    sessionNamingModel: null,
    sessionNamingReasoning: null,
    attentionAlertsEnabled: true,
    attentionAlertDelaySecs: 15,
    ...overrides,
  };
}

/**
 * A stand-in for the MOUNT: it holds the settings document in state and applies
 * the dialog's `onPatch` the way `SpacesList` does (save + `setSettings`), so the
 * dialog re-renders with what it just wrote. Needed for the tests that assert a
 * LABEL changes as a side effect of a write (ADR 0067's "Inherits parent tools"
 * after the last tick goes away) — the dialog itself is prop-driven and holds no
 * write state, so no single-`render` test can see that transition.
 */
function renderControlled(props: {
  rows: AgentConfigDto[];
  agentOverrides: AgentOverrides;
}): { patches: AgentOverrides[] } {
  const patches: AgentOverrides[] = [];
  function Harness() {
    const [overrides, setOverrides] = useState<AgentOverrides>(
      props.agentOverrides,
    );
    return (
      <AgentsDialog
        rows={props.rows}
        noSpaceOpen={false}
        settings={settings({ agentOverrides: overrides })}
        models={MODELS}
        tools={TOOLS}
        onPatch={(next) => {
          patches.push(next);
          setOverrides(next);
        }}
        onClose={() => {}}
      />
    );
  }
  render(<Harness />);
  return { patches };
}

/** Open a dialog-opened-inside-the-dialog (the model picker) — the LAST
 *  `[data-slot=dialog-content]` node, since Radix mounts it after the Agents
 *  dialog's own content. */
function innerDialog(): HTMLElement {
  const nodes = document.querySelectorAll("[data-slot=dialog-content]");
  return nodes[nodes.length - 1] as HTMLElement;
}

function openDialog(props: {
  rows?: AgentConfigDto[];
  agentOverrides?: AgentOverrides;
  noSpaceOpen?: boolean;
} = {}) {
  // The spies are always created here (the callers only ever want a fresh one),
  // which also keeps the return type a `Mock` rather than a union with a bare
  // function — `onPatch.mock.calls` needs the `Mock` half.
  const onPatch = vi.fn();
  const onClose = vi.fn();
  render(
    <AgentsDialog
      rows={props.rows ?? [row()]}
      noSpaceOpen={props.noSpaceOpen ?? false}
      settings={settings({ agentOverrides: props.agentOverrides ?? {} })}
      models={MODELS}
      tools={TOOLS}
      onPatch={onPatch}
      onClose={onClose}
    />,
  );
  return { onPatch, onClose };
}

beforeEach(() => {
  // jsdom has no layout, so Radix's `Select` throws on the focus-first-option
  // scroll. The repo-wide convention for this in every file that mounts a
  // `Select` (`SettingsPage.test.tsx`, `SessionConfigSelect.test.tsx`, …).
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = "";
});

describe("AgentsDialog", () => {
  it("renders_one_row_per_definition_with_name_and_description", async () => {
    openDialog({
      rows: [
        row(),
        row({
          name: "builder",
          description: "",
          path: "/p/.agents/agents/builder.md",
        }),
      ],
    });
    expect(await screen.findByText("scout")).toBeTruthy();
    expect(screen.getByText("Fast recon")).toBeTruthy();
    expect(screen.getByText("builder")).toBeTruthy();
  });

  it("a_user_scope_row_carries_the_global_cue_and_a_space_scope_row_does_not", async () => {
    // TWO SEPARATE renders (as in `SkillsDialog.test.tsx`): one render with
    // both scopes makes `queryByText("global")` ambiguous.
    const user = render(
      <AgentsDialog
        rows={[row({ scope: "user" })]}
        noSpaceOpen={false}
        settings={settings()}
        models={MODELS}
        tools={TOOLS}
        onPatch={vi.fn()}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("global")).toBeTruthy();
    user.unmount();
    render(
      <AgentsDialog
        rows={[row({ scope: "space" })]}
        noSpaceOpen={false}
        settings={settings()}
        models={MODELS}
        tools={TOOLS}
        onPatch={vi.fn()}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("scout")).toBeTruthy();
    expect(screen.queryByText("global")).toBeNull();
  });

  it("each_field_prints_the_layer_that_supplied_it", async () => {
    // ADR 0068: the layer comes from the Rust resolver (`source`), and the
    // `parent` rung reads `Inherits parent` — NOT "the child will inherit",
    // because a dispatch that passes `model:` still overrides this row.
    openDialog({
      agentOverrides: { scout: { model: "tama/Qwen3.8" } },
      rows: [
        row({
          override: { model: "tama/Qwen3.8", thinking: null, tools: null },
          file: { model: "openai/GPT-5", thinking: "low", tools: null },
          effective: {
            model: "tama/Qwen3.8",
            thinking: "low",
            tools: null,
          },
          source: { model: "override", thinking: "file", tools: "parent" },
        }),
      ],
    });
    await screen.findByText("scout");
    // Each of the three fields prints its OWN value and the layer that supplied
    // it — read off the field's own line, because "which layer" is a per-field
    // fact (a row can take its model from the override and its thinking from the
    // file). The source labels are queried EXACT, and the component's CONTEXT
    // columns are deliberately worded `runs …` / `in the file …` rather than
    // `override:` / `file:` — otherwise a column header would satisfy these
    // queries on its own and the test could not fail.
    const modelLine = screen.getByText("Model").closest("div")!;
    expect(modelLine.textContent).toContain("tama/Qwen3.8");
    expect(within(modelLine as HTMLElement).getByText("override")).toBeTruthy();
    const thinkingLine = screen.getByText("Thinking").closest("div")!;
    expect(thinkingLine.textContent).toContain("low");
    expect(
      within(thinkingLine as HTMLElement).getByText("file"),
    ).toBeTruthy();
    // ADR 0068's `parent` rung, worded for what it means: nothing below the
    // explicit `subagent` param spoke — NOT "the child will inherit". ADR 0067
    // requires this one be a labelled sentence, not a silent empty picker.
    expect(screen.getByText("Inherits parent tools")).toBeTruthy();
    // And the two labels above are NOT satisfied by a column header: the same
    // row's Tools line reports the `parent` layer for a field nothing speaks.
    const toolsLine = screen.getByText("Tools").closest("div")!;
    expect(
      within(toolsLine as HTMLElement).queryByText("override"),
    ).toBeNull();
  });

  it("picking_a_model_calls_onPatch_with_only_that_entry_changed", async () => {
    const { onPatch } = openDialog({
      agentOverrides: { plan: { thinking: "high" } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Model for scout" }));
    fireEvent.click(await screen.findByText("GPT-5"));
    expect(onPatch).toHaveBeenCalledWith({
      plan: { thinking: "high" },
      scout: { model: "openai/GPT-5" },
    });
  });

  it("picking_Inherits_DELETES_the_model_key", async () => {
    // ADR 0067: "clear this override" means the key is ABSENT — not `null`, not
    // an `undefined`-valued key that only looks absent until something else
    // serialises it.
    const { onPatch } = openDialog({
      agentOverrides: { scout: { model: "tama/Qwen3.8" } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Model for scout" }));
    fireEvent.click(within(innerDialog()).getByText("Inherits"));
    const next = onPatch.mock.calls[0][0] as AgentOverrides;
    expect(next.scout).toBeUndefined();
    expect("scout" in next).toBe(false);
    expect(JSON.stringify(next)).toBe("{}");
  });

  it("clearing_the_last_field_removes_the_agent_entry_entirely", async () => {
    // The entry holds ONLY a thinking level; clearing it must not leave
    // `{ scout: {} }` behind — an entry that claims to be an override while
    // saying nothing (ADR 0067).
    const { onPatch } = openDialog({
      agentOverrides: { scout: { thinking: "high" } },
    });
    fireEvent.click(
      await screen.findByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Inherits" }));
    const next = onPatch.mock.calls[0][0] as AgentOverrides;
    expect(next).toEqual({});
    expect("scout" in next).toBe(false);
  });

  it("unticking_every_tool_renders_Inherits_parent_tools_and_writes_NO_tools_key", async () => {
    // ADR 0067's UI consequence: with nothing ticked the row reads
    // `Inherits parent tools`, because writing no key is what unticking
    // everything DOES. An empty picker that read "no tools" would be a lie
    // users act on — no override can give a child zero tools.
    //
    // Rendered through `renderControlled`, because the LABEL half of this name
    // is a transition: the row can only read `Inherits parent tools` AFTER the
    // write has landed in the document it is handed, and the dialog is
    // prop-driven (no write state of its own).
    const { patches } = renderControlled({
      rows: [
        row({
          override: { model: null, thinking: null, tools: ["read_file", "grep"] },
          effective: { model: null, thinking: null, tools: ["read_file"] },
          source: { model: "parent", thinking: "parent", tools: "override" },
        }),
      ],
      agentOverrides: { scout: { tools: ["read_file", "grep"] } },
    });
    expect(screen.queryByText("Inherits parent tools")).toBeNull();
    // Unticking ONE of two leaves the other (the picker edits the override's
    // list, so a narrowing write is a plain set).
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Override tool read_file for scout" }),
    );
    expect(patches[0]).toEqual({ scout: { tools: ["grep"] } });
    // The LAST one goes: no `tools` key is written at all (ADR 0067 — an empty
    // list contributes nothing, so "no key" and "no tools" are the same fact and
    // the row must say the first one).
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Override tool grep for scout" }),
    );
    expect(patches[1]).toEqual({});
    // …and the row now says what that means.
    expect(await screen.findByText("Inherits parent tools")).toBeTruthy();
  });

  it("a_pinned_model_missing_from_the_catalog_renders_as_a_disabled_item", async () => {
    // The `staleOverride` rule: a pinned model no longer in the catalog matches
    // no item, so Radix would show the placeholder and misrepresent the saved
    // state. It becomes its own DISABLED item instead.
    openDialog({
      agentOverrides: { scout: { model: "gone/m1" } },
      rows: [
        row({
          override: { model: "gone/m1", thinking: null, tools: null },
          effective: { model: "openai/GPT-5", thinking: null, tools: null },
          source: { model: "override", thinking: "parent", tools: "parent" },
        }),
      ],
    });
    const trigger = await screen.findByRole("button", {
      name: "Model for scout",
    });
    // The trigger shows the STORED value, not the placeholder.
    expect(trigger.textContent).toContain("gone/m1");
    expect(trigger.textContent).not.toContain("Inherits");
    fireEvent.click(trigger);
    const stale = innerDialog().querySelector("[aria-disabled=true]");
    expect(stale).toBeTruthy();
    expect(stale?.textContent).toContain("gone/m1");
  });

  it("the_thinking_select_offers_the_union_of_the_models_levels_plus_Inherits", async () => {
    openDialog();
    fireEvent.click(
      await screen.findByRole("combobox", { name: "Thinking for scout" }),
    );
    const options = await screen.findAllByRole("option");
    // FIRST-SEEN order across the models (the `thinkingLevelUnion` rule — not
    // lexicographic), with the `Inherits` row.
    expect(options.map((o) => o.textContent)).toEqual([
      "Inherits",
      "high",
      "medium",
      "low",
    ]);
  });

  it("a_stored_thinking_level_outside_the_union_renders_as_its_own_disabled_option", async () => {
    // The per-row analogue of `SettingsPage`'s `storedLevelOutsideUnion`: a
    // STORED level no model still advertises must render, or Radix shows the
    // placeholder and the row lies about the saved state. (The control keys on the
    // STORED value — the picker shows what was PINNED, which is not necessarily
    // what runs; the `runs` column carries the other half.)
    //
    // DISABLED, symmetric with the stale MODEL item: clicking an item whose value
    // the control already holds re-fires `onValueChange` with the same value and
    // rewrites the same level — a control that looks like it does something and
    // does a pointless save.
    //
    // The fixture is a state the resolver CAN produce: an override level the
    // winning model does not advertise is DEMOTED, and this one is advertised by
    // NO model at all, so nothing runs it and the source falls to the parent rung.
    openDialog({
      agentOverrides: { scout: { thinking: "max" } },
      rows: [
        row({
          override: { model: null, thinking: "max", tools: null },
          effective: { model: null, thinking: null, tools: null },
          source: { model: "parent", thinking: "parent", tools: "parent" },
        }),
      ],
    });
    const trigger = await screen.findByRole("combobox", {
      name: "Thinking for scout",
    });
    expect(trigger.textContent).toContain("max");
    fireEvent.click(trigger);
    const stale = await screen.findByRole("option", { name: "max" });
    expect(stale.getAttribute("aria-disabled")).toBe("true");
  });

  it("a_demoted_thinking_level_still_shows_the_pin_and_the_runs_column_shows_the_demotion", async () => {
    // The state the resolver produces when a stored level is not one the winning
    // model advertises: the pin is NOT dropped and NOT reported as effective —
    // `effective.thinking` is `null` and `source.thinking` names the parent rung
    // (`commands::agents::tests::an_override_thinking_the_winning_model_lacks_is_
    // demoted` is the Rust half of this pair). The row therefore has to say BOTH
    // things at once: the picker still shows the pinned level (it shows what the
    // user saved), and the `runs` column says nothing runs it.
    //
    // `max` is outside EVERY model's advertised set here (the fixture's union is
    // `high`/`medium`/`low`), so the DISABLED stale item is what carries the pin in
    // the opened list — the same item the test above pins, doing the same job for a
    // level the winning model demoted. It is not decoration: drop `disabled` and the
    // assertion below fails, so this pair of columns disagreeing honestly is pinned
    // through a control that cannot re-commit the value.
    openDialog({
      agentOverrides: { scout: { model: "openai/GPT-5", thinking: "max" } },
      rows: [
        row({
          override: { model: "openai/GPT-5", thinking: "max", tools: null },
          effective: { model: "openai/GPT-5", thinking: null, tools: null },
          source: { model: "override", thinking: "parent", tools: "parent" },
        }),
      ],
    });
    const trigger = await screen.findByRole("combobox", {
      name: "Thinking for scout",
    });
    // The pin is still visible (not silently dropped, not the placeholder)…
    expect(trigger.textContent).toContain("max");
    expect(trigger.textContent).not.toContain("Inherits");
    // …and it is not offered as a live choice the click could re-commit.
    fireEvent.click(trigger);
    expect(
      (await screen.findByRole("option", { name: "max" })).getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
    // The runs column tells the other half: nothing runs the pinned level.
    const thinkingLine = screen.getByText("Thinking").closest("div")!;
    expect(thinkingLine.textContent).toContain("runs —");
    expect(within(thinkingLine as HTMLElement).getByText("Inherits parent")).toBeTruthy();
  });

  it("the_search_filters_rows_by_case_insensitive_name_substring", async () => {
    openDialog({
      rows: [
        row(),
        row({ name: "planner", path: "/p/.agents/agents/planner.md" }),
      ],
    });
    await screen.findByText("planner");
    fireEvent.change(screen.getByPlaceholderText("Search agents…"), {
      target: { value: "PLAN" },
    });
    expect(screen.queryByText("scout")).toBeNull();
    expect(screen.getByText("planner")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // The orphan rows — PORTED from the deleted `SettingsPage.test.tsx` with the
  // affordance itself (ADR 0023's AMENDED consequence: an orphaned override is
  // inert, and a remove button on its row is the ONLY cleanup path; this modal
  // is where that button lives now). The two the deletion notice named plus the
  // four sibling behaviours it took with them.
  // -------------------------------------------------------------------------

  it("an_orphaned_override_renders_with_a_remove_button", async () => {
    // PORTED. A stored key matching no discovered definition (its file was
    // removed or renamed): a muted row with a remove button, ADDITIONAL to the
    // discovered rows.
    const { onPatch } = openDialog({ agentOverrides: { ghost: { model: "p/m1" } } });
    expect(await screen.findByText("ghost")).toBeTruthy();
    expect(
      screen.getByText("No longer discovered (stale override)"),
    ).toBeTruthy();
    // The discovered agent is still listed (the orphan is ADDITIONAL).
    expect(screen.getByText("scout")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove ghost override" }));
    const next = onPatch.mock.calls[0][0] as AgentOverrides;
    expect("ghost" in next).toBe(false);
    expect(next).toEqual({});
  });

  it("a_case_variant_key_is_not_treated_as_an_orphan", async () => {
    // PORTED. The orphan filter matches through the ASCII fold, so a
    // hand-edited `"Ghost"` beside a discovered `ghost` IS that agent's stored
    // override — calling it stale would invite the user to delete a live
    // override.
    openDialog({
      rows: [row({ name: "ghost", path: "/u/.agents/agents/ghost.md" })],
      agentOverrides: { Ghost: { model: "tama/Qwen3.8" } },
    });
    expect(screen.queryByText("Ghost")).toBeNull();
    expect(
      screen.queryByText("No longer discovered (stale override)"),
    ).toBeNull();
    // And the row shows the stored value (the fold-matched lookup), not the
    // placeholder.
    const trigger = await screen.findByRole("button", {
      name: "Model for ghost",
    });
    expect(trigger.textContent).toContain("Qwen3.8");
    expect(trigger.textContent).not.toContain("Inherits");
  });

  it("a_stale_override_value_renders_as_its_own_option", async () => {
    // PORTED (the disabled-item half, alongside
    // `a_pinned_model_missing_from_the_catalog…`): a stored key the catalog no
    // longer resolves must show as its own DISABLED item — not fall back to the
    // placeholder — and clicking it saves NOTHING.
    const { onPatch } = openDialog({
      agentOverrides: { scout: { model: "gone/m1" } },
    });
    const trigger = await screen.findByRole("button", {
      name: "Model for scout",
    });
    fireEvent.click(trigger);
    const stale = innerDialog().querySelector("[aria-disabled=true]");
    expect(stale).toBeTruthy();
    expect(stale?.textContent).toContain("gone/m1");
    fireEvent.click(stale!);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("a_mixed_case_stored_override_renders_in_the_row", async () => {
    // PORTED. The backend resolves the map's keys case-insensitively
    // (`eq_ignore_ascii_case`), so a hand-edited `"Scout"` for `scout` IS the
    // stored override — an exact-case lookup would show the placeholder, a
    // false claim about the saved state.
    openDialog({
      agentOverrides: { Scout: { model: "gone/m1" } },
    });
    const trigger = await screen.findByRole("button", {
      name: "Model for scout",
    });
    expect(trigger.textContent).toContain("gone/m1");
    expect(trigger.textContent).not.toContain("Inherits");
    fireEvent.click(trigger);
    const stale = innerDialog().querySelector("[aria-disabled=true]");
    expect(stale?.textContent).toContain("gone/m1");
  });

  it("saving_drops_case_variant_twin_keys", async () => {
    // PORTED. `"Scout"` alongside `"scout"` (a pre-fix write can create one): a
    // save must leave EXACTLY ONE key — the canonical name — or the backend's
    // case-insensitive `.find` picks between twins in nondeterministic HashMap
    // order. The helper owns the rule (`agentOverrides.test.ts`); this pins that
    // the dialog routes through it rather than hand-spreading.
    const { onPatch } = openDialog({
      agentOverrides: { Scout: { model: "gone/m1" }, scout: { model: "p/m1" } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Model for scout" }));
    fireEvent.click(await screen.findByText("GPT-5"));
    const next = onPatch.mock.calls[0][0] as AgentOverrides;
    expect(Object.keys(next)).toEqual(["scout"]);
    expect("Scout" in next).toBe(false);
    expect(next.scout).toEqual({ model: "openai/GPT-5" });
  });

  it("a_non_ascii_case_variant_key_is_not_matched", async () => {
    // PORTED. The fold is ASCII-only, mirroring the backend: a hand-edited
    // `"É-claude"` does NOT match the discovered `é-claude`, so the row shows
    // the placeholder (a Unicode `toLowerCase()` fold would wrongly show the
    // stored value) and the key surfaces as an orphan — the only place its
    // remove button can be reached.
    openDialog({
      rows: [row({ name: "é-claude", path: "/u/.agents/agents/é-claude.md" })],
      agentOverrides: { "\u00C9-claude": { model: "tama/Qwen3.8" } },
    });
    const trigger = await screen.findByRole("button", {
      name: "Model for é-claude",
    });
    expect(trigger.textContent).toContain("Inherits");
    expect(await screen.findByText("\u00C9-claude")).toBeTruthy();
    expect(
      screen.getByText("No longer discovered (stale override)"),
    ).toBeTruthy();
  });

  it("noSpaceOpen offers NO remove button for an undiscovered key (the modal cannot prove it stale)", async () => {
    // The false-positive this pins. With no Space open the LIST above is the
    // user-level set only, so an override for a definition some PROJECT defines is
    // "undiscovered" here while being live in every project that defines it — and
    // this modal is ADR 0023's ONLY cleanup path, so a working trash button on that
    // row invites deleting data that is not stale. The modal cannot know whether a
    // name is discovered in SOME project, so it does not offer the removal at all.
    const { onPatch } = openDialog({
      noSpaceOpen: true,
      rows: [row({ scope: "user", path: "/u/.agents/agents/scout.md" })],
      agentOverrides: { ghost: { model: "p/m1" } },
    });
    // The stored map still drives the discovered row (nothing about editing broke).
    expect(await screen.findByText("scout")).toBeTruthy();
    // The orphan row is not offered: no "stale override" claim, and crucially no
    // destructive control aimed at a key the modal cannot prove stale.
    expect(
      screen.queryByText("No longer discovered (stale override)"),
    ).toBeNull();
    expect(screen.queryByText("ghost")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Remove ghost override" }),
    ).toBeNull();
    // …and nothing can be written from the block that would have removed it.
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("a Space open still offers the remove button for an orphan", async () => {
    // The other half of the trade-off: with a Space the discovery is the real
    // catalog for that `cwd`, so "not discovered" means what the label says and the
    // removal stays available. Pinning this keeps the fix above from being widened
    // into deleting ADR 0023's cleanup path.
    const { onPatch } = openDialog({
      noSpaceOpen: false,
      agentOverrides: { ghost: { model: "p/m1" } },
    });
    expect(
      await screen.findByRole("button", { name: "Remove ghost override" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove ghost override" }));
    expect(onPatch.mock.calls[0][0]).toEqual({});
  });

  // -------------------------------------------------------------------------
  // The stored-pin disagreement cue (`row.override` vs the store-side map).
  // -------------------------------------------------------------------------

  it("a row whose stored pin differs from the picker says so and names the wire value", async () => {
    // `row.override` is the stored entry as the BACKEND's selector read it; the
    // picker is bound to the live settings document, which the dialog looks up
    // through its own fold scan. The two selectors can land on different entries —
    // the hand-edited case-fold twin is the shipped case (Rust picks between
    // `"Scout"` and `scout` by HashMap order, the picker takes the first key in
    // document order) — and a Rust-side write can also beat the store's last read.
    // The row then shows one pin while the dispatch resolves the other, so the
    // difference gets a line of plain text naming what the backend sees.
    openDialog({
      agentOverrides: { scout: { model: "tama/Qwen3.8" } },
      rows: [
        row({
          override: { model: "openai/GPT-5", thinking: null, tools: null },
          effective: { model: "openai/GPT-5", thinking: null, tools: null },
          source: { model: "override", thinking: "parent", tools: "parent" },
        }),
      ],
    });
    const cue = await screen.findByText(/stored pin the last fetch saw differs/);
    // It NAMES the value, or it would be a warning the user cannot act on.
    expect(cue.textContent).toContain("openai/GPT-5");
    // And it names WHICH field, because three fields can disagree independently.
    expect(cue.textContent).toContain("model");
    // Plain text, not a control (the shadowing report's rule — nothing here is
    // clickable, and the user resolves it by editing the picker).
    expect(cue.closest('[role="button"]')).toBeNull();
  });

  it("a row whose stored pin matches the picker shows no disagreement cue", async () => {
    // The ordinary case, pinned so the cue cannot degrade into a line every row
    // carries: the wire column and the store-side entry agree, so there is nothing
    // to warn about.
    openDialog({
      agentOverrides: { scout: { model: "tama/Qwen3.8", thinking: "high" } },
      rows: [
        row({
          override: { model: "tama/Qwen3.8", thinking: "high", tools: null },
          effective: { model: "tama/Qwen3.8", thinking: "high", tools: null },
          source: { model: "override", thinking: "override", tools: "parent" },
        }),
      ],
    });
    await screen.findByText("scout");
    expect(screen.queryByText(/differs/)).toBeNull();
  });

  it("a pin the user just changed in this modal raises no disagreement cue", async () => {
    // The cue's one false positive, pinned away. `row.override` is a FETCH-time
    // value (the same lag the `runs` columns carry), so the moment the user picks a
    // different model the wire column differs from the store-side map ON PURPOSE.
    // Calling that "the pin the last fetch saw differs" would be a lie — the save is
    // in flight, and the backend already has the new value. The disagreement worth
    // naming is the one this dialog did not cause: two selectors reading one map
    // differently (the case-fold twin), or a file something else wrote (and the
    // failed-save case, which the harness here cannot show because it never fails a
    // write — `SpacesList.test.tsx`'s `a failed save re-arms the stored-pin cue…`
    // covers that direction).
    //
    // Rendered through `renderControlled`, because the false positive needs the
    // write to land in the document the dialog is handed while the rows stay the
    // ones the mount fetched — exactly the live shape.
    renderControlled({
      rows: [
        row({
          override: { model: "openai/GPT-5", thinking: null, tools: null },
          effective: { model: "openai/GPT-5", thinking: null, tools: null },
          source: { model: "override", thinking: "parent", tools: "parent" },
        }),
      ],
      agentOverrides: { scout: { model: "openai/GPT-5" } },
    });
    // Before the edit the two agree, so there is no cue to begin with…
    expect(screen.queryByText(/differs/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Model for scout" }));
    fireEvent.click(within(innerDialog()).getByText("Qwen3.8"));
    // The picker now shows the new pin (the write landed in the harness's copy).
    expect(
      screen.getByRole("button", { name: "Model for scout" }).textContent,
    ).toContain("Qwen3.8");
    // …and the edit does not manufacture one.
    expect(screen.queryByText(/differs/)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The shadowing report (ADR 0065 — disclosed, never listed).
  // -------------------------------------------------------------------------
  it("a_shadowed_row_reports_the_loser_as_text_and_never_as_a_control", async () => {
    openDialog({ rows: [row({ shadowed: [shadow()] })] });
    const path = await screen.findByText("/u/.pi/agent/agents/scout.md");
    // The loser's name and path are READABLE…
    expect(path.parentElement?.textContent).toContain("scout");
    // …and the winner stays the ONLY row for that name, so the loser is never a
    // control: `queryByRole("button", …)` is the absence assertion ADR 0065 asks
    // for (a row for a loser is a control that names a definition resolving to
    // the WINNER's file).
    expect(screen.queryByRole("button", { name: "scout" })).toBeNull();
    expect(path.closest('[role="button"]')).toBeNull();
    expect(path.getAttribute("tabindex")).toBeNull();
    // The clause names the WINNER's scope (the cause), not the loser's: two
    // roots per level and two user roots mean a `user` loser can lose to a
    // `user` winner, so wording keyed on the loser is false in shipped
    // configurations.
    expect(
      screen.getByText("1 agent is hidden by a project agent with the same name"),
    ).toBeTruthy();
  });

  it("a_shadow_report_under_a_global_winner_says_global", async () => {
    openDialog({
      rows: [
        row({
          scope: "user",
          path: "/u/.agents/agents/scout.md",
          shadowed: [shadow({ path: "/u/.pi/agent/agents/scout.md" })],
        }),
      ],
    });
    expect(
      await screen.findByText(
        "1 agent is hidden by a global agent with the same name",
      ),
    ).toBeTruthy();
  });

  it("the_search_needle_filters_the_shadow_report_with_the_rows", async () => {
    // The block can never contradict the list above it: filter the losers by
    // the SAME needle the rows use.
    openDialog({
      rows: [
        row({ shadowed: [shadow()] }),
        row({
          name: "planner",
          path: "/p/.agents/agents/planner.md",
          shadowed: [
            shadow({ name: "planner", path: "/u/.pi/agent/agents/planner.md" }),
          ],
        }),
      ],
    });
    await screen.findByText("/u/.pi/agent/agents/planner.md");
    fireEvent.change(screen.getByPlaceholderText("Search agents…"), {
      target: { value: "scout" },
    });
    expect(screen.queryByText("/u/.pi/agent/agents/planner.md")).toBeNull();
    expect(screen.getByText("/u/.pi/agent/agents/scout.md")).toBeTruthy();
  });

  it("noSpaceOpen_states_the_rows_are_the_global_set_and_leaves_everything_editable", async () => {
    // The override map is GLOBAL, so with no Space there is still exactly one
    // correct thing to write: the rows are the user-level set (what the deleted
    // Settings section offered). This flag changes the COPY only — a disabled
    // control would imply the settings are read-only, and they are not.
    openDialog({
      noSpaceOpen: true,
      rows: [row({ scope: "user", path: "/u/.agents/agents/scout.md" })],
    });
    expect(
      await screen.findByText(
        "No Space open — showing your global Agent definitions",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Model for scout" }).hasAttribute(
        "disabled",
      ),
    ).toBe(false);
    expect(
      screen.getByRole("checkbox", {
        name: "Override tool read_file for scout",
      }).hasAttribute("disabled"),
    ).toBe(false);
  });
});
