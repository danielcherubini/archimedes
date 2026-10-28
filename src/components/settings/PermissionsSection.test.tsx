import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import SettingsPage from "./SettingsPage";
import {
  getSettings,
  saveSettings,
  shellSandboxAvailable,
  type AppSettings,
} from "@/lib/tauri";
import { getAppInfo } from "@/lib/version";

// The permissions section is exercised THROUGH THE PAGE (there is no
// `GeneralSection.test.tsx` precedent — the posture rows were always tested
// through `SettingsPage.test.tsx`, and `settings` only reaches a section
// through the page's document hook). So this file carries the SAME mock
// scaffold as its predecessor: the `getSettings` fixture (a full
// `AppSettings` document, `filePolicy` WITHOUT a `rules` key — the wire
// reality: `skip_serializing_if = "Vec::is_empty"` makes empty and absent
// byte-identical), the Linux `getAppInfo` default, the available-Landlock
// `shellSandboxAvailable` default, and `saveSettings` as the save spy.
const baseSettings: AppSettings = {
  theme: "dark",
  palette: null,
  paneLayout: {},
  defaultTrustNewSpaces: false,
  defaultModel: null,
  defaultThinkingLevel: null,
  enabledTools: [],
  providers: [
    {
      id: "tama",
      name: "Tama",
      baseUrl: "https://tama.wizards.town/v1",
      apiKey: "k",
      api: "openai-completions",
      keyUrl: "https://keys.test/get",
    },
  ],
  mcpServers: {
    tama: { url: "https://tama/mcp" },
  },
  font: { sizePx: 14, uiFamily: null, codeFamily: null },
  defaultThinkingLevels: {},
  agentOverrides: {},
  spinnerStyle: null,
  emptyStateAnimation: null,
  // NO `rules` key (the decision the plan records): the two
  // complete-document `toEqual(baseSettings.filePolicy)` pins in
  // `SettingsPage.test.tsx` compare against exactly this three-key shape.
  // Seeding rules is per-test via `mockResolvedValueOnce`.
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
};

vi.mock("@/lib/version", () => ({
  // The OS the app runs on (the Shell `Sandboxed` tier is Linux-only). Linux
  // by default so the option is offered; the non-Linux tests override it with
  // `mockResolvedValueOnce` IN THEIR OWN BODIES (the scaffold default does NOT
  // relieve a moved test of its override).
  getAppInfo: vi
    .fn()
    .mockResolvedValue({ version: "0.1.0", platform: "linux" }),
}));

vi.mock("../../lib/tauri", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("../../lib/tauri");
  return {
    ...actual,
    // Inlined (NOT the `baseSettings` const): the factory is hoisted above
    // the const's initializer (a TDZ reference would throw at import time).
    getSettings: vi.fn().mockResolvedValue({
      theme: "dark",
      palette: null,
      paneLayout: {},
      defaultTrustNewSpaces: false,
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledTools: [],
      providers: [
        {
          id: "tama",
          name: "Tama",
          baseUrl: "https://tama.wizards.town/v1",
          apiKey: "k",
          api: "openai-completions",
          keyUrl: "https://keys.test/get",
        },
      ],
      mcpServers: {
        tama: { url: "https://tama/mcp" },
      },
      font: { sizePx: 14, uiFamily: null, codeFamily: null },
      defaultThinkingLevels: {},
      agentOverrides: {},
      spinnerStyle: null,
      emptyStateAnimation: null,
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
    }),
    // (ADR 0030) Whether THIS kernel can confine a shell (Landlock).
    // AVAILABLE by default so the tier is offered; the grey-out test
    // overrides with `mockResolvedValueOnce(false)`.
    shellSandboxAvailable: vi.fn().mockResolvedValue(true),
    listSessions: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue([
      {
        id: "Qwen3.8",
        provider: "tama",
        contextWindow: 128000,
        supportsThinking: true,
        thinkingLevels: ["high", "medium", "low"],
      },
      {
        id: "GPT-5",
        provider: "openai",
        contextWindow: 400000,
        supportsThinking: true,
        thinkingLevels: ["medium", "high", "xhigh"],
      },
    ]),
    listKnownProviders: vi.fn().mockResolvedValue([]),
    listTools: vi
      .fn()
      .mockResolvedValue(["bash", "read", "write", "edit", "subagent"]),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    testMcpServer: vi.fn().mockResolvedValue(0),
    authMcpServer: vi.fn().mockResolvedValue("authenticated"),
  };
});

// The page's selects are the Radix `ui/select` port — opening one in jsdom
// throws `hasPointerCapture is not a function` without the pointer-capture
// stubs (the `SettingsPage.test.tsx` beforeAll, verbatim) + `matchMedia`.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Wait for the page's `getSettings` load to land in state (General's marker
 * row — it still exists because General still renders). The Permissions
 * section's own marker is the trust switch, awaited via `go("Permissions")`. */
async function loaded(): Promise<void> {
  await screen.findByText("Default model");
}

/** Navigate to a section (click its sidebar button) and wait for it. */
async function go(
  section: "Appearance" | "Providers" | "MCP" | "Web search" | "Permissions",
): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: section }));
  if (section === "Appearance") await screen.findByText("Theme");
  else if (section === "Providers")
    await screen.findByRole("button", { name: "Add provider" });
  else if (section === "Web search")
    await screen.findByText(
      "Configure Search providers and proxy for web_search and fetch_content tools.",
    );
  // BEFORE the MCP `else` (the same fallthrough trap `SettingsPage.test.tsx`
  // names: a `"Permissions"` arm after the `else` would await "Add server").
  else if (section === "Permissions")
    await screen.findByRole("switch", {
      name: "Trust new Spaces by default",
    });
  else await screen.findByRole("button", { name: "Add server" });
}

/** The `SettingsRow` hosting the named control (label + description +
 * control share one row element). */
function rowOf(controlName: string): HTMLElement {
  const trigger = screen.getByRole("combobox", { name: controlName });
  const row = trigger.closest(".border-t");
  expect(row).toBeTruthy();
  return row as HTMLElement;
}

/** Open the named select and return its trigger. */
async function openSelect(controlName: string): Promise<HTMLElement> {
  const trigger = await screen.findByRole("combobox", { name: controlName });
  fireEvent.click(trigger);
  await screen.findAllByRole("option");
  return trigger;
}

/** Close the open Radix select (one at a time — an open select
 * `aria-hidden`s the rest of the document, so the trigger must be the
 * element reference captured BEFORE it opened). */
async function closeSelect(trigger: HTMLElement): Promise<void> {
  fireEvent.keyDown(trigger, { key: "Escape" });
  await new Promise((resolve) => setTimeout(resolve, 0)); // let Radix un-`aria-hide`
}

/** The labels of the currently open select's options. */
function optionLabels(): string[] {
  return screen.getAllByRole("option").map((o) => o.textContent ?? "");
}

describe("PermissionsSection (the moved posture rows — ADR 0030)", () => {
  // The file-access policy moved out of General with its rows: three selects —
  // Reads / Writes / Shell — above the Trust switch, in one card. All three
  // DEFAULT to `allow` ("Don't ask me"), so the row copy is the safety story:
  // it must state the free pass plainly (never phrase the default as a
  // restriction).

  it("the_three_file_access_selects_default_to_don_t_ask_me", async () => {
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    for (const name of ["Reads", "Writes", "Shell"]) {
      const trigger = await screen.findByRole("combobox", { name });
      // The trigger DISPLAYS the selected policy (a fresh install is
      // all-`allow` — nothing may fall back to a placeholder).
      expect(
        trigger.querySelector("[data-slot=select-value]")?.textContent,
      ).toBe("Don't ask me");
    }
    // The PERMISSIONS-card layout (the row-order pin moved with the rows):
    // Reads < Writes < Shell < the Trust switch, all four in one card.
    // ("above default model etc." no longer applies — Default model no longer
    // shares a card with the posture rows.)
    const rows = document.querySelectorAll(".border-t");
    const index = (label: string): number =>
      [...rows].findIndex((r) =>
        [...r.querySelectorAll("div")].some((d) => d.textContent === label),
      );
    expect(index("Reads")).toBeGreaterThanOrEqual(0);
    expect(index("Reads")).toBeLessThan(index("Writes"));
    expect(index("Writes")).toBeLessThan(index("Shell"));
    expect(index("Shell")).toBeLessThan(index("Trust new Spaces by default"));
  });

  it("the_file_access_rows_state_the_honest_default (the copy carries the all-allow posture)", async () => {
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    // Writes + Shell: the default is a FREE PASS — the copy must name
    // "anywhere" and the absence of a prompt (a user who only ever sees
    // the default must not mistake it for a restriction).
    for (const name of ["Writes", "Shell"]) {
      const text = rowOf(name).textContent ?? "";
      expect(text).toContain("anywhere");
      expect(text).toContain("with no prompt");
    }
    // Writes also names the ONE carve-out that survives every policy.
    expect(rowOf("Writes").textContent ?? "").toContain("agent-definition");
    // Reads: `Don't ask me` means no prompt AND no log.
    expect(rowOf("Reads").textContent ?? "").toContain("no prompt and no log");
    // The boundary-relative promise for `Ask me` / `Sandboxed` (the
    // policy decides ONLY the beyond-boundary case).
    expect(rowOf("Reads").textContent ?? "").toContain("outside the boundary");
  });

  it("the_writes_row_discloses_the_carve_out_is_a_guard_rail_not_a_boundary (the copy is the only disclosure surface)", async () => {
    // Issue #92 Bug 1. The protected-dir REFUSAL is forbidden from naming the
    // route that bypasses it (issue #33), so this row is the one place a human
    // learns the carve-out is not absolute. It used to say the opposite — and
    // NO test pinned it, which is how. This test pins the MEANING, not the
    // punctuation: tolerant matchers, so rewording is free and an absolute is
    // not. (The row moved here with the re-worded copy: the refusal is now
    // scoped to "while … and no deny rule covers it", and the copy states the
    // ask a matching rule creates — the matchers below are UNCHANGED, which is
    // the proof the re-word preserved the meaning.)
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    const text = rowOf("Writes").textContent ?? "";

    // (a) It names what the carve-out IS, in ADR 0030's words.
    expect(text).toMatch(/guard.?rail/i);
    // (b) It says, in as many words, that it is NOT the thing a user will
    //     assume it is. (`.*?` so "not a security boundary" and "not a hard
    //     security boundary" both pass; a bare `not a boundary` would not.)
    expect(text).toMatch(/not a .*boundary/i);
    // (c) It names the two routes the carve-out does not govern — the whole
    //     content of the disclosure. `sudo_exec` in lowercase is the tool's
    //     own name as the Shell row already spells it.
    expect(text).toMatch(/shell/i);
    expect(text).toContain("sudo_exec");
    // (d) The overclaim is dead: no absolute survives. This is the pin's
    //     teeth, and it is TIGHTENED from the first draft of this plan. The
    //     draft vetoed only /can ?not|never rewrite|always (refuse|protect)|
    //     cannot be rewritten/, which PASSED the plan's own replacement
    //     sentence ("… refuse to rewrite them under any policy") — a pin that
    //     passes on the copy it exists to police is worse than no pin, so the
    //     "under any policy" / "in every policy" family is now in here too.
    //     THREE-WAY CHECK, and all three legs are mandatory: (d) must FAIL on
    //     the OLD copy (it matches "never rewrite"), must FAIL on the
    //     overclaiming DRAFT (it matches "under any policy"), and must PASS on
    //     the FINAL copy below (it matches nothing). A change to (d) that
    //     breaks any leg makes the matcher decorative — re-run all three.
    expect(text).not.toMatch(
      /can ?not|never rewrite|cannot be rewritten|always (refuse|protect)|(under|in|for) (any|every|all) (the )?polic|every (single )?polic|whatever (the )?polic|regardless of (any |the )?polic/i,
    );
    // (e) Descriptive, not instructional (#33's rule, moved to the UI): no
    //     second-person permission, no invitation. These two are kept — they
    //     are well-scoped to how a human addresses a human, and the copy
    //     passes them. The third matcher the draft carried, the command/path
    //     needle /\bcp\b|rm -rf|~\/\.(agents|pi)\b/, is DROPPED: see "Ruling
    //     on matcher (e)" below the rules — it cannot catch the real hazard
    //     (a residual absolute) and would reject a future disclosure that has
    //     to name a real path. Rule 2's ban on command and path examples
    //     still binds the copy; it is simply not policed by a regex here.
    expect(text).not.toMatch(/\byou (can|could|should|may)\b/i);
    expect(text).not.toMatch(/\b(just|simply|if needed|to work around)\b/i);

    // CONTRAST so (a)-(c) cannot pass vacuously on some unrelated sentence:
    // the Reads row keeps its own story and is NOT the disclosure surface.
    expect(rowOf("Reads").textContent ?? "").not.toMatch(/guard.?rail/i);
  });

  it("the_shell_sandboxed_option_is_hidden_off_linux", async () => {
    // The per-test override is LOAD-BEARING: this file's scaffold pins
    // `platform: "linux"`, and this test asserts the off-Linux behaviour.
    vi.mocked(getAppInfo).mockResolvedValueOnce({
      version: "0.1.0",
      platform: "windows",
    });
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    // Reads still offers all three tiers…
    const reads = await openSelect("Reads");
    expect(optionLabels()).toEqual(["Sandboxed", "Ask me", "Don't ask me"]);
    await closeSelect(reads);
    // …the Shell row offers only two (there is no sandbox to choose —
    // Landlock is Linux-only).
    const shell = await openSelect("Shell");
    expect(optionLabels()).toEqual(["Ask me", "Don't ask me"]);
    expect(screen.queryByRole("option", { name: "Sandboxed" })).toBeNull();
    await closeSelect(shell);
    // Nothing was saved by merely looking.
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("the_shell_sandboxed_option_is_greyed_out_when_the_kernel_has_no_landlock", async () => {
    // Linux (so the tier IS offered — hiding it would hide a real choice)
    // but the kernel cannot confine: the option stays VISIBLE and greyed,
    // with the reason stated in one line. A silently-selectable tier whose
    // commands all fail closed is the failure mode this guards.
    // (The per-test override is load-bearing: the scaffold default is
    // `shellSandboxAvailable → true`.)
    vi.mocked(shellSandboxAvailable).mockResolvedValueOnce(false);
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    // The row is captured BEFORE the select opens (an open Radix select
    // `aria-hidden`s the rest of the document, so the trigger is
    // unqueryable while it is open).
    const shellRow = rowOf("Shell");
    const shell = await openSelect("Shell");
    const option = await screen.findByRole("option", { name: "Sandboxed" });
    expect(option.getAttribute("data-disabled")).not.toBeNull();
    expect(option.getAttribute("aria-disabled")).toBe("true");
    // The reason is in the row (not only in the disabled option).
    expect(shellRow.textContent ?? "").toContain("Landlock");
    // Clicking the greyed option changes nothing.
    fireEvent.click(option);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveSettings).not.toHaveBeenCalled();
    await closeSelect(shell);
  });

  it("the_shell_sandboxed_option_is_selectable_when_the_kernel_can_confine", async () => {
    // CONTRAST (so the grey-out above cannot pass vacuously): with the
    // probe reporting Landlock ( the suite default), the tier is enabled.
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    const shellRow = rowOf("Shell");
    const shell = await openSelect("Shell");
    const option = await screen.findByRole("option", { name: "Sandboxed" });
    // The probe has to have SETTLED before this is meaningful (the page's
    // pre-probe state is deliberately "not supported"), hence `waitFor`.
    await waitFor(() =>
      expect(option.getAttribute("data-disabled")).toBeNull(),
    );
    expect(option.getAttribute("aria-disabled")).not.toBe("true");
    expect(shellRow.textContent ?? "").not.toContain("cannot run");
    fireEvent.keyDown(shell, { key: "Escape" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("a_stored_sandboxed_shell_on_non_linux_does_not_render_an_empty_select", async () => {
    // Off Linux the `Sandboxed` item is HIDDEN, but a stored
    // `shell: "sandboxed"` value survives the platform change — the trigger
    // must never render blank for a value whose option is gone (a
    // placeholder stands in; the value itself is preserved on save).
    // (The per-test override is LOAD-BEARING: this file's scaffold pins
    // `platform: "linux"`.)
    vi.mocked(getAppInfo).mockResolvedValueOnce({
      version: "0.1.0",
      platform: "windows",
    });
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...baseSettings,
      filePolicy: { reads: "allow", writes: "allow", shell: "sandboxed" },
    });
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    const trigger = await screen.findByRole("combobox", { name: "Shell" });
    const value = trigger
      .querySelector("[data-slot=select-value]")
      ?.textContent?.trim();
    expect(value).toBe("Sandboxed (unavailable here)");
    // NOT the freer-sounding label: a stored `sandboxed` fails every
    // command closed, and "Don't ask me" would hide that.
    expect(value).not.toBe("Don't ask me");
  });

  it("a_pre_feature_document_without_file_policy_renders_don_t_ask_me (never an empty select)", async () => {
    // A `settings.json` written before ADR 0030 has no `filePolicy` key;
    // the backend fills the default, but the UI must not render an empty
    // select if the key is ever absent.
    const preFeature = { ...baseSettings } as Partial<AppSettings>;
    delete preFeature.filePolicy;
    vi.mocked(getSettings).mockResolvedValueOnce(preFeature as AppSettings);
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    for (const name of ["Reads", "Writes", "Shell"]) {
      const trigger = await screen.findByRole("combobox", { name });
      expect(
        trigger.querySelector("[data-slot=select-value]")?.textContent,
      ).toBe("Don't ask me");
    }
  });

  it("the trust copy states the self-modification implication", async () => {
    // The spec's approved replacement copy (VERBATIM): trusting a Space now
    // ALSO silences the self-modification guard, so the old "for
    // bash/edit/write … existing Spaces are unaffected" promise is a lie.
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    const toggle = await screen.findByRole("switch", {
      name: "Trust new Spaces by default",
    });
    const row = toggle.closest(".border-t");
    expect(row).toBeTruthy();
    const text = row!.textContent ?? "";
    expect(text).toContain("write its own instruction directories without asking");
    expect(text).toContain("deny those paths with a rule above");
    // The moved toggle still saves the TOP-LEVEL key (a UI move only — no
    // wire change: `defaultTrustNewSpaces` is not a `FilePolicy` key).
    fireEvent.click(toggle);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(saveSettings).mock.calls[0][0] as AppSettings;
    expect(saved.defaultTrustNewSpaces).toBe(true);
  });

  it("the scope copy states bash is not covered (the spec's honesty)", async () => {
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    // The bolded sentence is one element (`<b>`), so the exact-text query
    // resolves uniquely; the em-dash is part of the pinned copy.
    expect(
      screen.getByText(
        "bash runs with your own user's OS permissions — it is not covered here.",
      ),
    ).toBeTruthy();
    // The two flanking sentences of the same pinned block.
    expect(
      screen.getByText(
        /These rules apply to the file tools \(`read`, `write`, `edit`, `grep`, `glob`\)\./,
      ).textContent,
    ).toContain("bash runs with your own user's OS permissions");
    expect(
      screen.getByText(/To stop the agent reaching something with `bash`, remove your user's access to it\./),
    ).toBeTruthy();
  });
});

describe("PermissionsSection (the rules list — add / edit / remove)", () => {
  it("a posture save keeps an existing rule list (changing the reads select preserves rules)", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...baseSettings,
      filePolicy: {
        reads: "allow",
        writes: "allow",
        shell: "allow",
        rules: [{ path: "~/.pi/agent", direction: "read", decision: "deny" }],
      },
    });
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    fireEvent.click(await screen.findByRole("combobox", { name: "Reads" }));
    fireEvent.click(await screen.findByRole("option", { name: "Ask me" }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(saveSettings).mock.calls[0][0] as AppSettings;
    expect(saved.filePolicy.reads).toBe("ask");
    expect(saved.filePolicy.rules).toEqual([
      { path: "~/.pi/agent", direction: "read", decision: "deny" },
    ]);
  });

  it("an empty rules list renders the default-rules offer with the honest copy", async () => {
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    // The offer's anchor sentence + the honesty the spec's own table carries:
    // two of the three defaults change nothing at the default posture, and
    // the `deny` one is labelled a default the user can delete.
    expect(screen.getByText("No rules yet.")).toBeTruthy();
    const copy = screen.getByText(/Three starter rules exist for a clean install/);
    expect(copy.textContent).toContain("change nothing at the default open posture");
    expect(copy.textContent).toContain("document how open it is");
    expect(copy.textContent).toContain("the one real restriction");
    expect(copy.textContent).toContain("The deny rule is a default you can delete.");
    // ONE button, and it pre-fills the DRAFT (the deny rule — the only
    // default that matters). No automatic write: opening the page and reading
    // the offer saves nothing.
    expect(
      screen.getByRole("button", { name: "Add default rule" }),
    ).toBeTruthy();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("the default-rules offer pre-fills the deny draft and writes nothing until the dialog saves", async () => {
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    fireEvent.click(screen.getByRole("button", { name: "Add default rule" }));
    // The draft pre-fills the deny rule; NOTHING is persisted by the click.
    expect(await screen.findByRole("dialog")).toBeTruthy();
    // (No jest-dom in this repo — the draft value is read off the DOM.)
    expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe(
      "~/.pi/agent",
    );
    expect(saveSettings).not.toHaveBeenCalled();
    // Cancel writes nothing either — the rule exists only once Save is clicked.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("add_rule_saves_the_triple_and_closes_the_dialog", async () => {
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Path"), {
      target: { value: "/tmp/build" },
    });
    // Save is gated on a non-blank path (and the path is non-blank here).
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(saveSettings).mock.calls[0][0] as AppSettings;
    // The defaults the dialog opens with: direction `read`, decision `deny`.
    expect(saved.filePolicy.rules).toEqual([
      { path: "/tmp/build", direction: "read", decision: "deny" },
    ]);
    // The row renders (path + direction + decision) with Edit / Remove, and
    // the dialog closed.
    expect(await screen.findByText("/tmp/build")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Edit rule /tmp/build" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove rule /tmp/build" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a_rule_row_shows_path_direction_and_decision", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...baseSettings,
      filePolicy: {
        reads: "allow",
        writes: "allow",
        shell: "allow",
        rules: [
          { path: "~/.cache", direction: "readWrite", decision: "allow" },
        ],
      },
    });
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    const row = (await screen.findByText("~/.cache")).closest(
      ".border-t",
    ) as HTMLElement;
    expect(row).toBeTruthy();
    // The path, the direction as the badge (the WIRE value, like the MCP
    // badge shows the wire kind), and the decision as text.
    expect(row.textContent).toContain("~/.cache");
    expect(row.textContent).toContain("readWrite");
    expect(row.textContent).toContain("allow");
    // NO Test action (the spec: "simpler: three fields, no Test action").
    expect(screen.queryByRole("button", { name: /Test rule/ })).toBeNull();
  });

  it("edit_rule_replaces_the_triple", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...baseSettings,
      filePolicy: {
        reads: "allow",
        writes: "allow",
        shell: "allow",
        rules: [{ path: "~/.pi/agent", direction: "read", decision: "deny" }],
      },
    });
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit rule ~/.pi/agent" }),
    );
    // The form is pre-filled from the rule (the EDIT case's title names it).
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe(
      "~/.pi/agent",
    );
    fireEvent.change(screen.getByLabelText("Path"), {
      target: { value: "~/.pi/agents" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(saveSettings).mock.calls[0][0] as AppSettings;
    // EXACTLY ONE rule — the edit REPLACED the pre-edit rule (there is no
    // rule id; the pre-edit triple is the replacement key).
    expect(saved.filePolicy.rules).toEqual([
      { path: "~/.pi/agents", direction: "read", decision: "deny" },
    ]);
  });

  it("remove_rule_confirms_then_saves", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...baseSettings,
      filePolicy: {
        reads: "allow",
        writes: "allow",
        shell: "allow",
        rules: [{ path: "~/.pi/agent", direction: "read", decision: "deny" }],
      },
    });
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove rule ~/.pi/agent" }),
    );
    // The AlertDialog confirm (the `McpSection` shape), with the one sentence
    // about what removal means.
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(saveSettings).mock.calls[0][0] as AppSettings;
    // The rules list is EMPTY — and the three postures rode along (the rules
    // write composes over `...settings.filePolicy`).
    expect(saved.filePolicy.rules).toEqual([]);
    expect(saved.filePolicy.reads).toBe("allow");
    expect(saved.filePolicy.writes).toBe("allow");
    expect(saved.filePolicy.shell).toBe("allow");
  });

  it("the default-rules offer re-appears after the last rule is removed (an empty list is the offer's only gate)", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...baseSettings,
      filePolicy: {
        reads: "allow",
        writes: "allow",
        shell: "allow",
        rules: [{ path: "~/.pi/agent", direction: "read", decision: "deny" }],
      },
    });
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    // Seeded with one rule: no offer.
    expect(screen.queryByText("No rules yet.")).toBeNull();
    // Remove the rule (Trash → AlertDialog → Remove → immediate save).
    fireEvent.click(
      screen.getByRole("button", { name: "Remove rule ~/.pi/agent" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    // After the delete, the offer is BACK — the predicate is
    // `(rules ?? []).length === 0`, which cannot tell "never seeded" from
    // "user deleted all rules". This is the decided (a)-behaviour, pinned.
    expect(await screen.findByText("No rules yet.")).toBeTruthy();
  });
});
