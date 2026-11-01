import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import {
  ArrowLeftIcon,
  DownloadIcon,
  FolderXIcon,
  GlobeIcon,
  PackageIcon,
  PaletteIcon,
  ServerIcon,
  Settings2Icon,
  ShieldIcon,
} from "lucide-react";

import { getAppInfo } from "@/lib/version";
import {
  getProviderBudget,
  listKnownProviders,
  listModels,
  listSessions,
  listTools,
  shellSandboxAvailable,
  type AccessRule,
  type AppSettings,
  type AgentOverrides,
  type McpServerEntry,
  type ModelDto,
  type ProviderBudgetRowDto,
  type ProviderConfig,
  type WireApi,
  type KnownProvider,
} from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { SettingsSidebarButton } from "./primitives";
import { useSettingsDocument } from "@/hooks/useSettingsDocument";
import { useSessions } from "@/store/sessions";
import { useModelCatalog } from "@/store/modelCatalog";
import GeneralSection from "./GeneralSection";
import AppearanceSection from "./AppearanceSection";
import ProviderSection from "./ProviderSection";
import UpdateSection from "./UpdateSection";
import McpSection, { type McpDraft } from "./McpSection";
import PermissionsSection, { type RuleDraft } from "./PermissionsSection";
import WebSearchSection from "./WebSearchSection";
import SessionsSection from "./SessionsSection";

/**
 * The section discriminator. `"sessions"` is the SHORT slug and it is never
 * rendered — the nav label is `Detached sessions`, which is what the user reads
 * (the section lists only sessions with no open Space, so a nav entry called
 * `Sessions` would promise the full list and show a partial one; and a button
 * whose text were exactly `Sessions` would collide with `App.test.tsx`'s pin
 * that the workspace UNMOUNTS while Settings is open).
 */
type Section =
  | "general"
  | "appearance"
  | "providers"
  | "mcp"
  | "permissions"
  | "sessions"
  | "web-search"
  | "updates";

/** A ZCode-style slug: lowercase alphanumeric + `-`. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A slug de-duped against the taken ids (a `-2` / `-3` suffix). */
function uniqueSlug(slug: string, taken: Set<string>): string {
  let id = slug;
  let n = 2;
  while (taken.has(id)) {
    id = `${slug}-${n}`;
    n += 1;
  }
  return id;
}

/**
 * Remap a settings-level model reference (the `defaultModel` composed key —
 * `"<providerId>/<modelId>"`) from a provider's old id to its new one (a
 * name commit re-identifies the provider — the reference must not orphan).
 * A `null` / non-matching key is untouched.
 *
 * The parameter stays `string | null` (NOT `string | null | undefined`): the
 * `agentOverrides` walk below handles an ABSENT `.model` before calling this,
 * because absence is ADR 0067's "this override does not speak" — a third state
 * a model reference cannot hold, and folding it into this signature would let a
 * `null` reach the store, where `null` is forbidden.
 */
function remapModelRef(
  key: string | null,
  oldId: string,
  newId: string,
): string | null {
  if (key === null || !key.startsWith(`${oldId}/`)) return key;
  return `${newId}${key.slice(oldId.length)}`;
}

/** Remap the `defaultThinkingLevels` keys (the same `"<providerId>/<modelId>"` composed keys). */
function remapModelRefs(
  refs: Record<string, string>,
  oldId: string,
  newId: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(refs)) {
    next[remapModelRef(key, oldId, newId) as string] = value;
  }
  return next;
}

/**
 * The settings page (the approved ZCode-parity design, spec §1/§4): a full
 * content-area view — a 268px section sidebar (back button + General /
 * Appearance / Providers / MCP / Updates) + the active section's content. Immediate save:
 * a control change → `saveSettings` with the COMPLETE document (text
 * fields commit on blur/Enter; no save button, no dirty state).
 */
export default function SettingsPage({ onBack }: { onBack: () => void }): ReactElement {
  // THE settings document, from its one owner (`useSettingsDocument`): the store,
  // loaded on mount, saved + re-applied by `patch`. The page used to keep a second
  // copy of it in `useState` and mirror it into the store by hand at two sites, so
  // within this screen two things owned one document (finding 13a).
  const { settings, patch: update } = useSettingsDocument();
  const [section, setSection] = useState<Section>("general");
  const [models, setModels] = useState<ModelDto[]>([]);
  // The known-providers catalog (ADR 0024 — the Providers section's picker
  // data source; `[]` = not loaded / the load failed).
  const [knownProviders, setKnownProviders] = useState<KnownProvider[]>([]);
  // The picker's selected template id ("" = nothing selected — the
  // placeholder; the Add button is disabled until one is picked).
  const [selectedKnown, setSelectedKnown] = useState("");
  /**
   * The spend/budget rows by PROVIDER id (issue #132). `get_provider_budget` is
   * a BULK read — it answers EVERY provider's rows in one call, so this map is
   * built from that single response by `providerId`. An id with no entry means
   * not fetched / fetch failed / that provider has no rows, and the row renders
   * NOTHING (a missing figure is never `$0.00` — `moneyOf`'s rule).
   */
  const [budgets, setBudgets] = useState<
    Record<string, ProviderBudgetRowDto[] | undefined>
  >({});
  // The native harness's tool names (the enabled-tools checkbox list).
  const [tools, setTools] = useState<string[]>([]);
  // (ADR 0030) The OS the app runs on — the Shell `Sandboxed` tier is
  // Landlock, i.e. Linux only, so the option is hidden elsewhere. `null`
  // until the load lands (treated as "not offered": an option is never
  // shown on an assumption).
  const [platform, setPlatform] = useState<string | null>(null);
  // (ADR 0030 Task 5) Whether THIS kernel can confine a shell (the
  // `shell_sandbox_available` probe). On Linux `false` greys the tier out
  // with the reason (confined commands fail closed here — offering it as a
  // live choice would be a lie). `null` until the load lands, treated as
  // unsupported: never advertise a capability on an assumption.
  const [sandboxSupported, setSandboxSupported] = useState<boolean | null>(null);
  // The MCP add/edit dialog draft (`null` = closed — a fresh draft per open
  // so a Cancel never leaks the draft into the next open).
  const [mcpDialog, setMcpDialog] = useState<McpDraft | null>(null);
  // The rules add/edit dialog draft (`null` = closed — a fresh draft per open,
  // the MCP dialog's pattern).
  const [rulesDialog, setRulesDialog] = useState<RuleDraft | null>(null);

  useEffect(() => {
    // The page's own picker data — NOT the settings document, which
    // `useSettingsDocument` loads through the store. Each fetch degrades to its
    // own empty/not-offered value: a section is never built on an assumption.
    listModels()
      .then(setModels)
      .catch(() => {});
    listTools()
      .then(setTools)
      .catch(() => {});
    void getAppInfo()
      .then((info) => setPlatform(info.platform))
      .catch(() => setPlatform(null));
    void shellSandboxAvailable()
      .then(setSandboxSupported)
      .catch(() => setSandboxSupported(false));
    listKnownProviders()
      .then(setKnownProviders)
      .catch((error) => {
        console.error("loading the known-providers catalog failed", error);
        setKnownProviders([]);
      });
    // The spend/budget ledger (issue #132) — a PAGE-level fetch, deliberately NOT
    // an App boot fetch. `src/App.test.tsx` mocks the barrel by spreading
    // `vi.importActual`, so a boot fetch it does not mock resolves to the REAL
    // wrapper, rejects, and reddens tests that have nothing to do with budgets (the
    // AGENTS.md trap). This call is id-less — `get_provider_budget` answers the
    // WHOLE ledger, so it needs no `providers` dependency — and the `.catch` is
    // synchronous and total: an absent ledger (or a rejected read) leaves the map
    // empty and every row renders no figure. The background poller
    // (`BUDGET_POLL_INTERVAL_MILLIS`) keeps the ledger warm, so a plain read at
    // mount is the right call — no forced tick.
    getProviderBudget()
      .then((all) =>
        setBudgets(Object.fromEntries(all.map((dto) => [dto.providerId, dto.rows]))),
      )
      .catch(() => {});
  }, []);

  /**
   * The Default-thinking-level select's options (the union of the
   * `thinkingLevels` arrays across the `listModels` results, deduped in
   * FIRST-SEEN order — each model's advertised order, consistent with the
   * in-session thinking-level picker; a `Set` preserves insertion order,
   * so no `.sort()`): a model's live `thinkingLevels` is the source of
   * truth — a level no model advertises is not offered.
   */
  const thinkingLevelUnion = useMemo(() => {
    const levels = new Set<string>();
    for (const model of models) {
      for (const level of model.thinkingLevels) levels.add(level);
    }
    return [...levels];
  }, [models]);

  /**
   * The stored `defaultThinkingLevel` when it is NON-NULL, NON-BLANK and NOT
   * in the union (a provider removed it / the level sets changed): offered
   * as its own raw option — otherwise Radix's `SelectValue` falls back to the
   * placeholder and the UI DISPLAYS "Model default" while sessions still
   * start with the stored level (a false representation of the saved state).
   * A blank stored value (a hand-edited file — the frontend never SAVES
   * `""`) is treated as absent: `""` is the `value` of the "Model default"
   * option, so offering it again would give Radix two items with the same
   * value.
   */
  const storedLevel = settings?.defaultThinkingLevel ?? null;
  const storedLevelOutsideUnion =
    storedLevel !== null &&
    storedLevel !== "" &&
    !thinkingLevelUnion.includes(storedLevel)
      ? storedLevel
      : null;

  /**
   * A provider field commit (immediate save): `update` (the document hook's
   * `patch`) + re-run the changed
   * provider's discovery (Task 2's `force_refresh` bypasses its cache).
   * The id is derived from the name: a committed name (a non-blank slug)
   * that differs from the current id re-identifies the provider — the
   * settings-level model references (the `defaultModel` composed key + the
   * `defaultThinkingLevels` keys, both `"<providerId>/<modelId>"`) are
   * remapped old → new so they don't orphan (the in-memory discovery cache
   * entries for the old id are simply unused — the new id gets a fresh
   * discovery; a BLANK name keeps the current id).
   */
  const commitProviderField = (index: number, patch: Partial<ProviderConfig>) => {
    if (settings === null) return;
    const current = settings.providers[index];
    const next = { ...current, ...patch };
    const slug = slugify(next.name);
    let id = next.id;
    if (slug !== "") {
      const taken = new Set(
        settings.providers
          .map((p, i) => (i === index ? null : p.id))
          .filter((v): v is string => v !== null),
      );
      id = uniqueSlug(slug, taken);
    }
    const nextSettings: Partial<AppSettings> = {
      providers: settings.providers.map((p, i) =>
        i === index ? { ...next, id } : p,
      ),
    };
    if (id !== current.id) {
      nextSettings.defaultModel = remapModelRef(
        settings.defaultModel,
        current.id,
        id,
      );
      nextSettings.defaultThinkingLevels = remapModelRefs(
        settings.defaultThinkingLevels,
        current.id,
        id,
      );
      // (ADR 0066) `agentOverrides` is `agent name → override`: the model ref is
      // the entry's `.model` VALUE (the agent names are the KEYS —
      // `remapModelRefs` remaps map KEYS and would be a no-op here). A
      // non-matching ref stays untouched, and an entry whose `.model` is ABSENT
      // is copied VERBATIM: absence is ADR 0067's only meaning of "this override
      // does not speak", so the rename must never turn it into `null` — NOR into
      // `""` (the same violation in a different literal: a value that was not
      // there before, which the resolver reads as "no opinion" at best).
      const remappedOverrides: AgentOverrides = {};
      for (const [name, override] of Object.entries(settings.agentOverrides)) {
        if (override.model === undefined) {
          // A silent entry gains NO `model` key at all — not even one holding
          // `undefined`. Such a key does serialize away (`JSON.stringify` drops
          // it, and that IS Tauri's IPC message serializer), but it still shows
          // up in the in-memory document, where `"model" in entry` flips to
          // true — so the key is simply never added.
          remappedOverrides[name] = { ...override };
          continue;
        }
        // A `null` can never come back from `remapModelRef` for a non-null key
        // (it either renames or returns the key), so the fallback is the type's
        // proof that absence never enters this branch; should it ever change,
        // the entry keeps its own value instead of gaining a `null`.
        remappedOverrides[name] = {
          ...override,
          model: remapModelRef(override.model, current.id, id) ?? override.model,
        };
      }
      nextSettings.agentOverrides = remappedOverrides;
    }
    update(nextSettings);
    void listModels(id).then(setModels).catch(() => {});
  };

  /**
   * Add provider: append an editable row. No template → an empty row with
   * a placeholder id (`provider-N` — a name commit derives the real id
   * from the name, de-duped with a `-2` / `-3` suffix). A template (the
   * known-providers picker, ADR 0024) → a pre-filled row (name / base URL
   * / wire / key URL; the key is ALWAYS empty — the user pastes it; the id
   * is the template name's slug, de-duped the same way).
   */
  const addProvider = (template?: {
    name?: string;
    baseUrl?: string;
    api?: WireApi;
    keyUrl?: string;
  }) => {
    if (settings === null) return;
    const name = template?.name ?? "";
    const slug = slugify(name);
    const base = slug !== "" ? slug : `provider-${settings.providers.length + 1}`;
    const existing = new Set(settings.providers.map((p) => p.id));
    update({
      providers: [
        ...settings.providers,
        {
          id: uniqueSlug(base, existing),
          name,
          baseUrl: template?.baseUrl ?? "",
          apiKey: "",
          api: template?.api ?? "openai-completions",
          keyUrl: template?.keyUrl ?? null,
        },
      ],
    });
  };

  const removeProvider = (id: string) => {
    if (settings === null) return;
    update({ providers: settings.providers.filter((p) => p.id !== id) });
  };

  /** Toggle one tool in the enabled-tools list (immediate save — the CHECKED
   * names are the saved list; `[]` = all tools). */
  const toggleTool = (name: string) => {
    if (settings === null) return;
    const current = settings.enabledTools;
    const next = current.includes(name)
      ? current.filter((n) => n !== name)
      : [...current, name];
    update({ enabledTools: next });
  };

  /** Save an MCP server (the dialog's Save — immediate save, the provider pattern). */
  const saveMcpServer = (name: string, entry: McpServerEntry) => {
    if (settings === null) return;
    update({ mcpServers: { ...settings.mcpServers, [name]: entry } });
    setMcpDialog(null);
  };

  const removeMcpServer = (name: string) => {
    if (settings === null) return;
    const mcpServers = { ...settings.mcpServers };
    delete mcpServers[name];
    update({ mcpServers });
  };

  /** Save one rule (the dialog's Save — immediate save, the provider pattern).
   * Always composes over `settings.filePolicy` (spread), so an existing `rules`
   * list is never dropped by an add/edit/remove. (Composes over the RENDERED
   * `settings`, not a ref — the two-write interleave pin in
   * `SettingsPage.test.tsx` makes that window observable.)
   *
   * `replaces` is the rule an EDIT started from (the store's own object,
   * carried on the draft — there is no rule id, and the dialog's Save builds a
   * FRESH `{path, direction, decision}`, so the fresh triple cannot locate the
   * rule it replaces). An add omits it and appends. */
  const saveRule = (rule: AccessRule, replaces?: AccessRule) => {
    if (settings === null) return;
    const rules = settings.filePolicy?.rules ?? [];
    const index = replaces === undefined ? -1 : rules.indexOf(replaces);
    update({
      filePolicy: {
        ...settings.filePolicy,
        rules:
          index === -1
            ? [...rules, rule]
            : rules.map((r, i) => (i === index ? rule : r)),
      },
    });
    setRulesDialog(null);
  };

  const removeRule = (rule: AccessRule) => {
    if (settings === null) return;
    const rules = settings.filePolicy?.rules ?? [];
    update({
      filePolicy: {
        ...settings.filePolicy,
        rules: rules.filter((r) => r !== rule),
      },
    });
  };

  /**
   * Ask for a fresh budget read for ONE provider (issue #132).
   * `get_provider_budget`'s `forceRefresh` parameter carries a PROVIDER ID, not
   * a boolean — passing the id runs one bounded budget tick for that provider
   * and then answers the WHOLE ledger, which is re-mapped by `providerId`.
   * Deliberately fire-and-forget with its own total `.catch`: the row refresh's
   * contract is the model catalog + the session windows, and a budget hop that
   * fails must not fail the refresh the user asked for.
   */
  const refreshBudgetFor = (id: string): void => {
    getProviderBudget(id)
      .then((all) =>
        setBudgets(
          Object.fromEntries(all.map((dto) => [dto.providerId, dto.rows])),
        ),
      )
      .catch(() => {});
  };

  const refreshProvider = (id: string): Promise<void> => {
    // The budget ledger rides the same refresh (fire-and-forget, own `.catch` —
    // see `refreshBudgetFor`), so it never joins this promise's outcome.
    refreshBudgetFor(id);
    return listModels(id)
      .then(setModels)
      .then(() =>
        // (#85) The refreshed window must reach STORED sessions too, not just
        // this page's list: a closed session's bar reads the row's
        // `contextUsage`, and `listSessions` is fetched once at boot, so without
        // this the corrected window would not appear until a restart. The merge
        // action deliberately touches only the per-id maps (never membership).
        listSessions(true).then((rows) =>
          useSessions.getState().mergeRefreshedSessionRows(rows),
        ),
      )
      .then(() =>
        // …and the shared catalog, which is what the subagent card's context %
        // reads. `forceRefresh` keeps the backend's own bypass in play (it is
        // what pushes the corrected window to LIVE sessions).
        useModelCatalog.getState().loadModels(id),
      )
      .catch(() => {});
  };

  const generalSection = (
    <GeneralSection
      settings={settings}
      models={models}
      tools={tools}
      thinkingLevelUnion={thinkingLevelUnion}
      storedLevelOutsideUnion={storedLevelOutsideUnion}
      onSave={update}
      onToggleTool={toggleTool}
    />
  );

  const appearanceSection = (
    <AppearanceSection settings={settings} onSave={update} />
  );

  const providersSection = (
    <ProviderSection
      settings={settings}
      models={models}
      knownProviders={knownProviders}
      selectedKnown={selectedKnown}
      onSelectKnown={setSelectedKnown}
      onCommitField={commitProviderField}
      budgets={budgets}
      onRefresh={refreshProvider}
      onRemove={removeProvider}
      onAdd={addProvider}
    />
  );

  const mcpSection = (
    <McpSection
      settings={settings}
      dialog={mcpDialog}
      setDialog={setMcpDialog}
      onSave={saveMcpServer}
      onRemove={removeMcpServer}
    />
  );

  const permissionsSection = (
    <PermissionsSection
      settings={settings}
      dialog={rulesDialog}
      setDialog={setRulesDialog}
      shellSandboxAvailable={platform === "linux"}
      shellSandboxSupported={sandboxSupported === true}
      onSave={update}
      onSaveRule={saveRule}
      onRemoveRule={removeRule}
    />
  );

  const webSearchSection = (
    <WebSearchSection settings={settings} onSave={update} />
  );

  // The Detached sessions section takes only `onBack`: it reads the sessions
  // store directly (no new command, no new fetch — `App` loads the stored rows
  // at boot and `deleteSession` removes ids from all three lists). Reopen Space
  // leaves Settings, so it needs the page's own exit.
  const sessionsSection = <SessionsSection onBack={onBack} />;

  // The Updates section takes no props: its version row reads `getAppInfo`
  // itself and its state machine is entirely local (no settings document is
  // involved — an update is not a preference).
  const updatesSection = <UpdateSection />;

  return (
    <div className="grid h-full grid-cols-[268px_minmax(0,1fr)]">
      <aside className="min-w-0 border-r border-border">
        <div className="flex h-full flex-col">
          <div className="px-2 pb-3 pt-3">
            <Button
              type="button"
              variant="ghost"
              size="lg"
              aria-label="Back"
              className="w-[calc(100%-0.5rem)] justify-start gap-2 rounded-xl px-1.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              onClick={onBack}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </Button>
          </div>
          <nav aria-label="Settings sections" className="flex-1 overflow-y-auto px-2 pb-3">
            <div className="space-y-1">
              <SettingsSidebarButton
                icon={Settings2Icon}
                label="General"
                active={section === "general"}
                onClick={() => setSection("general")}
              />
              <SettingsSidebarButton
                icon={PaletteIcon}
                label="Appearance"
                active={section === "appearance"}
                onClick={() => setSection("appearance")}
              />
              <SettingsSidebarButton
                icon={PackageIcon}
                label="Providers"
                active={section === "providers"}
                onClick={() => setSection("providers")}
              />
              <SettingsSidebarButton
                icon={ServerIcon}
                label="MCP"
                active={section === "mcp"}
                onClick={() => setSection("mcp")}
              />
              <SettingsSidebarButton
                icon={ShieldIcon}
                label="Permissions"
                active={section === "permissions"}
                onClick={() => setSection("permissions")}
              />
              <SettingsSidebarButton
                icon={FolderXIcon}
                label="Detached sessions"
                active={section === "sessions"}
                onClick={() => setSection("sessions")}
              />
              <SettingsSidebarButton
                icon={GlobeIcon}
                label="Web search"
                active={section === "web-search"}
                onClick={() => setSection("web-search")}
              />
              <SettingsSidebarButton
                icon={DownloadIcon}
                label="Updates"
                active={section === "updates"}
                onClick={() => setSection("updates")}
              />
            </div>
          </nav>
        </div>
      </aside>
      <section className="min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 pb-8 pt-4">
          {section === "general"
            ? generalSection
            : section === "appearance"
              ? appearanceSection
              : section === "providers"
                ? providersSection
                : section === "mcp"
                  ? mcpSection
                  : section === "permissions"
                    ? permissionsSection
                    : section === "sessions"
                      ? sessionsSection
                      : section === "web-search"
                        ? webSearchSection
                        : updatesSection}
        </div>
      </section>
    </div>
  );
}
