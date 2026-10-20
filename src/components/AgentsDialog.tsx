import { useState } from "react";
import { TrashIcon } from "lucide-react";
import type {
  AgentConfigDto,
  AgentOverride,
  AgentOverrides,
  AppSettings,
  ModelDto,
  OverrideSource,
  ShadowedAgent,
} from "../lib/tauri";
import { foldAscii, orphanedOverrides, withOverride } from "../lib/agentOverrides";
import ModelPicker from "./ModelPicker";
import { modelItemsFromCatalog } from "./ModelPickerDialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

/**
 * The **Agents** modal (ADR 0066 / ADR 0068) — the ONE Agent surface, opened
 * from the Space rail beside **Skills**.
 *
 * One row per **Agent definition** the ACTIVE **Space** can see (project-level
 * rows AND the global ones — `list_agent_config(cwd)` discovers with that `cwd`),
 * each carrying the three fields an **Agent override** can set, with the value
 * AND the layer that supplied it (`override` / `file` / `Inherits parent`). The
 * effective values and their layers come from Rust — the same resolver a real
 * dispatch runs (ADR 0068) — so this component derives nothing about resolution;
 * it renders the rows it is handed.
 *
 * PROP-DRIVEN like `SkillsDialog`: the fetch lives in `useAgentCatalog` at the
 * mount (which is also where the settings document is read and written), so the
 * dialog needs no IPC and its tests need no mock.
 *
 * What the two "which layer" columns read, and why:
 * - the **file** and **runs** columns are `row.file` / `row.effective` /
 *   `row.source` verbatim — Rust's answer, at the time of the last fetch;
 * - the **override** column and every control read `settings.agentOverrides`,
 *   i.e. the live document. A write lands in the store immediately, so the
 *   controls never misrepresent the saved state; the resolver's columns lag until
 *   the catalog refetches (the next Space switch), which is why they are labelled
 *   `runs` — "what the last fetch saw the dispatch launch with" — and never
 *   restated as a promise about the edit you just made.
 */

/** A field's label for the layer that supplied it (ADR 0068's label space).
 *
 * `parent` means "nothing below the explicit `subagent` tool param spoke" — the
 * row does NOT claim the child will inherit, because a dispatch that passes
 * `model:` overrides what this row shows. That is why the rung is worded
 * "Inherits parent" and not "the child inherits". */
function sourceLabel(source: OverrideSource, field: string): string {
  switch (source) {
    case "override":
      return "override";
    case "file":
      return "file";
    case "parent":
      return `Inherits parent${field === "tools" ? " tools" : ""}`;
  }
}

/**
 * The tools row's inherit copy (ADR 0067: the tools control's empty state must
 * be LABELLED, not silent — "an empty picker that implies no tools would be a
 * lie users act on"). With no `tools` key written, the child falls to the next
 * layer, and the wording names it.
 *
 * Anything that is not `file` reads the parent rung, which is ADR 0067's literal
 * copy: the only layers Rust can report beneath an ABSENT override are `file` and
 * `parent`, so a stale `override` (a row fetched before the key was cleared) is
 * the just-cleared state, and "Inherits parent tools" is what the user needs to
 * read there.
 */
function toolsInheritLabel(source: OverrideSource): string {
  return source === "file" ? "Inherits the file's tools" : "Inherits parent tools";
}

/**
 * The shadowing report's heading for one row (ADR 0065: disclosed, never listed).
 *
 * The clause names the WINNER's scope (the CAUSE), never the excluded entry's —
 * the rule `SkillsDialog`'s `shadowGroups` comment earns and this inherits:
 * `space_roots()` contributes two roots per level (`.agents/agents`, then
 * `.pi/agents`) and `user_roots()` returns two User roots, so a `user` entry can
 * be excluded by a `user` winner, and a clause keyed on the loser is FALSE in
 * shipped configurations. Here the winner is the row itself, so its scope is
 * already in hand.
 */
function shadowHeading(winnerScope: "space" | "user", count: number): string {
  return `${count} ${count === 1 ? "agent is" : "agents are"} hidden by a ${
    winnerScope === "space" ? "project" : "global"
  } agent with the same name`;
}

interface AgentsDialogProps {
  rows: AgentConfigDto[];
  /**
   * True while NO **Space** is open. This changes the COPY only — the override
   * map is GLOBAL, so nothing is disabled: with no Space the rows are the
   * user-level set, exactly what the deleted Settings section offered. (In the
   * old per-Space plan this flag disabled every control, because there was no
   * layer to write to without a Space. There is always one now.)
   */
  noSpaceOpen: boolean;
  settings: AppSettings | null;
  models: ModelDto[];
  tools: string[];
  onPatch: (next: AgentOverrides) => void;
  onClose: () => void;
}

export default function AgentsDialog({
  rows,
  noSpaceOpen,
  settings,
  models,
  tools,
  onPatch,
  onClose,
}: AgentsDialogProps) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  // Case-insensitive NAME substring (the `SkillsDialog` policy, stated there as
  // name-only for v1). The SAME needle filters the shadow report below, so the
  // report can never contradict the list above it.
  const filtered =
    needle === ""
      ? rows
      : rows.filter((r) => r.name.toLowerCase().includes(needle));

  // The union of the `thinkingLevels` arrays across the catalog, deduped in
  // FIRST-SEEN order (a `Set` preserves insertion order, so no `.sort()`) —
  // `SettingsPage`'s `thinkingLevelUnion` memo COPIED, not imported: a page
  // module is not a component's library, and the two surfaces have no reason to
  // re-render in step.
  const levelSet = new Set<string>();
  for (const model of models) {
    for (const level of model.thinkingLevels) levelSet.add(level);
  }
  const thinkingLevelUnion = [...levelSet];

  // (ADR 0023) The stored entries matching no discovered definition — ADR 0023's
  // orphans, and the remove button on them is that ADR's ONLY cleanup path.
  //
  // The helper's comment puts the "have the definitions loaded?" gate on the
  // CALLER, and from the dialog's seat `rows === []` is genuinely ambiguous: the
  // hook serves `[]` while a fetch is in flight, on a failed fetch, AND when a
  // folder really has no definitions. Gating on a non-empty list takes the safe
  // side of that ambiguity — a stale override is then momentarily invisible
  // rather than flashed as stale with a LIVE remove button. It is the same gate
  // the deleted section had (`agentDefs !== null`), expressed in the only signal
  // this prop list carries.
  const orphans =
    settings === null || rows.length === 0
      ? []
      : orphanedOverrides(settings.agentOverrides, rows);

  /** One write, always through the shared editor: `withOverride` owns the
   * case-fold-twin drop and the delete-the-empty-entry rule, which are the two
   * things a hand-assembled spread in this component would get wrong. */
  const patch = (name: string, field: keyof AgentOverride, value: string | string[] | undefined) => {
    if (settings === null) return;
    onPatch(withOverride(settings.agentOverrides, name, field, value));
  };

  /** Remove one orphan's entry (ADR 0023's cleanup path). Deleting the KEY, not
   * emptying the entry — `{ ghost: {} }` is an entry that claims to be an
   * override while saying nothing (ADR 0067). */
  const removeOrphan = (name: string) => {
    if (settings === null) return;
    const next: AgentOverrides = { ...settings.agentOverrides };
    delete next[name];
    onPatch(next);
  };

  return (
    <Dialog open onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-h-[70vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Agents</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[calc(70vh-7.5rem)] min-w-0 flex-col gap-3">
          {noSpaceOpen && (
            // The copy, not a disabled control: the override map is global, so
            // there IS always a correct thing to write. This line only says
            // which definitions the list can see.
            //
            // Rendered ONCE above the rows rather than on every row (the plan's
            // wording is "every row carries the copy"): the sentence is a fact
            // about the LIST — which roots discovery was allowed to read — not
            // about a definition, and repeating it N times would bury the rows
            // under N identical lines for no added truth. Flagged in the task
            // report rather than silently reworded.
            <p className="text-ui-sm text-foreground-subtlest">
              No Space open — showing your global Agent definitions
            </p>
          )}
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents…"
          />
          {settings === null ? (
            // The mount guards on `settings` too; this arm only exists so the
            // dialog can never read `settings.agentOverrides` off `null`.
            <p className="p-3 text-ui-sm text-foreground-subtlest">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="p-3 text-ui-sm text-foreground-subtlest">
              No Agent definitions found.
            </p>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-ui-sm text-foreground-subtlest">
              No agents match "{query}".
            </p>
          ) : (
            <div className="flex min-w-0 flex-col gap-2 overflow-y-auto pr-2">
              {filtered.map((row) => (
                <AgentRow
                  key={row.path}
                  row={row}
                  needle={needle}
                  stored={
                    // The stored entry, looked up through the ASCII fold: the
                    // backend resolves the map's keys case-insensitively, so a
                    // hand-edited `"Scout"` for `scout` IS this agent's override
                    // — an exact-case lookup would show the "Inherits"
                    // placeholder and misrepresent the saved state (the rule the
                    // deleted `SubagentSection` was reviewed for). FIRST match,
                    // mirroring the backend's `.find`.
                    Object.entries(settings.agentOverrides).find(
                      ([key]) => foldAscii(key) === foldAscii(row.name),
                    )?.[1]
                  }
                  models={models}
                  providers={settings.providers}
                  thinkingLevelUnion={thinkingLevelUnion}
                  tools={tools}
                  onPatch={patch}
                />
              ))}
            </div>
          )}
          {/* Orphaned overrides — muted rows with a remove button, the shape the
              deleted Settings section used (ADR 0023's only cleanup path). Note
              that with `noSpaceOpen` the LIST above is user-level only, so an
              override for a project-only definition reads as undiscovered here;
              the banner above says the list is scoped, which is the honest cue
              available without inventing a second copy. */}
          {orphans.length > 0 && (
            <div className="flex min-w-0 flex-col gap-0.5 border-t border-border pt-2">
              {orphans.map((name) => (
                <div
                  key={name}
                  className="flex min-w-0 items-center gap-2 text-ui-sm"
                >
                  <span className="min-w-0 flex-1 truncate text-foreground-subtle">
                    {name}
                  </span>
                  <span className="text-ui-xs text-foreground-subtlest">
                    No longer discovered (stale override)
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${name} override`}
                    onClick={() => removeOrphan(name)}
                  >
                    <TrashIcon className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One field's SOURCE LABEL (ADR 0068: every field prints the layer that supplied
 * it). A component rather than an interpolated sentence so the label is its own
 * findable node — a test (and a screen reader) can point at it — and so no column
 * header can accidentally satisfy a query for one of the three words.
 */
function LayerTag({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded bg-input px-1 text-ui-xs text-foreground-subtlest">
      {children}
    </span>
  );
}

/**
 * One definition's row: identity + description, then one line per overridable
 * field (its value, the layer that supplied it, and the control), then the
 * shadowing report.
 *
 * NOT a `role="button"` row: unlike `SkillsDialog`'s rows, clicking an Agent row
 * would have nothing honest to do — the definition is addressed by name from the
 * model's `subagent` call, not from this modal.
 */
function AgentRow({
  row,
  needle,
  stored,
  models,
  providers,
  thinkingLevelUnion,
  tools,
  onPatch,
}: {
  row: AgentConfigDto;
  /** The dialog's search needle — the shadow report is filtered by the SAME
   *  needle the rows use, so it can never contradict the list above it. */
  needle: string;
  /** This definition's stored entry, resolved through the ASCII fold. */
  stored: AgentOverride | undefined;
  models: ModelDto[];
  providers: { id: string; name: string }[];
  thinkingLevelUnion: string[];
  tools: string[];
  onPatch: (name: string, field: keyof AgentOverride, value: string | string[] | undefined) => void;
}) {
  // The stale-override rule for the MODEL (the `storedLevelOutsideUnion`
  // pattern): a pinned key no longer in the catalog matches no item, and Radix
  // would then show the placeholder — a false claim about the saved state. Offer
  // it as its own DISABLED item instead (clicking it changes nothing).
  const staleModel =
    stored?.model !== undefined &&
    !models.some((m) => `${m.provider}/${m.id}` === stored.model)
      ? stored.model
      : null;
  // The same rule applied per ROW to the thinking level (the analogue of
  // `SettingsPage`'s `storedLevelOutsideUnion`, which is app-wide): a stored
  // level no model still advertises must render as its own option.
  const staleLevel =
    stored?.thinking !== undefined &&
    stored.thinking !== "" &&
    !thinkingLevelUnion.includes(stored.thinking)
      ? stored.thinking
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-ui-base">{row.name}</span>
        {row.scope === "user" && (
          <span className="text-ui-xs text-foreground-subtlest">global</span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-ui-xs text-foreground-subtlest"
          title={row.path}
        >
          {row.path}
        </span>
      </div>
      {row.description !== "" && (
        <span
          className="min-w-0 truncate text-ui-sm text-foreground-subtle"
          title={row.description}
        >
          {row.description}
        </span>
      )}

      {/* MODEL. The three spans are SEPARATE nodes on purpose: the source label
          is the fact ADR 0068 exists to show, so it must be pointable-at rather
          than buried inside a sentence — and the two CONTEXT columns are worded
          `runs …` / `in the file …` so neither of them is the string `override`
          or `file`. A column literally headed `override:` would make any query
          for the `override` SOURCE LABEL trivially true (a test that cannot
          fail); the wording difference is what keeps the pin honest. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="w-16 shrink-0 text-ui-sm text-foreground-subtlest">
          Model
        </span>
        <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
          runs {row.effective.model ?? "—"}
        </span>
        <LayerTag>{sourceLabel(row.source.model, "model")}</LayerTag>
        <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
          in the file {row.file.model ?? "—"}
        </span>
        <ModelPicker
          label={`Model for ${row.name}`}
          value={stored?.model ?? ""}
          placeholder="Inherits"
          items={[
            // The composed `provider + "/" + id` keys — the exact call the
            // deleted `SubagentSection` made — plus the "Inherits" item as an
            // `items` entry (NOT a "leading" flag: `ModelPickerDialog` re-sorts
            // items alphabetically by name and DISCARDS caller order, so nothing
            // could lead anywhere). Picking it DELETES the key (ADR 0067).
            ...modelItemsFromCatalog(
              models.map((model) => `${model.provider}/${model.id}`),
              providers,
            ),
            { value: "", name: "Inherits" },
            ...(staleModel !== null
              ? [{ value: staleModel, name: staleModel, disabled: true }]
              : []),
          ]}
          onSelect={(value) =>
            // `""` (the "Inherits" item) maps to `undefined` = DELETE the field.
            onPatch(row.name, "model", value === "" ? undefined : value)
          }
        />
      </div>

      {/* THINKING (the same three-node shape as Model, for the same reason). */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="w-16 shrink-0 text-ui-sm text-foreground-subtlest">
          Thinking
        </span>
        <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
          runs {row.effective.thinking ?? "—"}
        </span>
        <LayerTag>{sourceLabel(row.source.thinking, "thinking")}</LayerTag>
        <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
          in the file {row.file.thinking ?? "—"}
        </span>
        <Select
          value={stored?.thinking ?? ""}
          onValueChange={(value) =>
            onPatch(row.name, "thinking", value === "" ? undefined : value)
          }
        >
          <SelectTrigger aria-label={`Thinking for ${row.name}`} className="w-48">
            <SelectValue placeholder="Inherits" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Inherits</SelectItem>
            {thinkingLevelUnion.map((level) => (
              <SelectItem key={level} value={level}>
                {level}
              </SelectItem>
            ))}
            {staleLevel !== null && (
              <SelectItem value={staleLevel}>{staleLevel}</SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      {/* TOOLS (ADR 0067): the empty state is LABELLED, never silent. Unticking
          everything writes NO key — which is "this override does not speak", not
          "no tools" — so the line says so in words. The cluster is rendered in
          BOTH states (nothing ticked is a reachable, editable state, not a
          read-only one); only the sentence above it changes. `subagent` /
          `list_agents` are stripped by the harness at this layer too, and the
          `tools` prop is the harness's own list, so they never appear here. */}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="w-16 shrink-0 text-ui-sm text-foreground-subtlest">
            Tools
          </span>
          {stored?.tools === undefined ? (
            <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
              {/* Two spans, not one interpolated sentence: ADR 0067's labelled
                  empty state has to be findable as ITS OWN text (the
                  `Inherits parent tools` string is what the ADR names, and the
                  test — and a screen reader's announcement — should be able to
                  point at it). */}
              <span>file: {(row.file.tools ?? []).join(", ") || "—"}</span>
              <span> · </span>
              <span>{toolsInheritLabel(row.source.tools)}</span>
            </span>
          ) : (
            <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
              file: {(row.file.tools ?? []).join(", ") || "—"} · runs:{" "}
              {(row.effective.tools ?? []).join(", ") || "—"} (
              {sourceLabel(row.source.tools, "tools")})
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-16">
          {tools.map((name) => (
            <label
              key={name}
              className="flex items-center gap-1.5 text-ui-sm text-foreground"
            >
              <input
                type="checkbox"
                checked={stored?.tools?.includes(name) ?? false}
                // "tick this override", so the label names what the control
                // actually does (the deleted cluster said `Enable tool …`,
                // which reads as the app-wide enabled-tools toggle — a
                // different setting on a different screen).
                aria-label={`Override tool ${name} for ${row.name}`}
                onChange={(e) =>
                  onPatch(
                    row.name,
                    "tools",
                    e.target.checked
                      ? [...(stored?.tools ?? []), name]
                      : (stored?.tools ?? []).filter((t) => t !== name),
                  )
                }
              />
              {name}
            </label>
          ))}
        </div>
      </div>

      {/* The shadowing report (ADR 0065) — muted PLAIN TEXT under the winning
          row: never a `Button`, never `role="row"`, never clickable, because a
          control naming a loser resolves to the WINNER's file (name, not path,
          is a definition's identity). The Skills dialog groups its report at the
          dialog's foot; here it sits under the row, because the Agent row already
          carries the winner's identity and the fact is per-name — the DISCLOSURE
          rule carries over, not the layout. Filtered by the dialog's needle. */}
      <ShadowReport row={row} needle={needle} />
    </div>
  );
}

/** The loser lines for one row (see the render site above). */
function ShadowReport({
  row,
  needle,
}: {
  row: AgentConfigDto;
  needle: string;
}) {
  // `?? []` is the same IPC tolerance `SkillsDialog` keeps for a row that
  // genuinely predates the field — a bare `flatMap` over such a row yields
  // `undefined` entries that throw on the first property access.
  const losers: ShadowedAgent[] = (row.shadowed ?? []).filter(
    (loser) => needle === "" || loser.name.toLowerCase().includes(needle),
  );
  if (losers.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 pt-1">
      <p className="text-ui-xs text-foreground-subtlest">
        {shadowHeading(row.scope, losers.length)}
      </p>
      {losers.map((loser) => (
        <div
          key={loser.path}
          className="flex min-w-0 items-center gap-2 text-ui-xs text-foreground-subtlest"
        >
          <span className="min-w-0 shrink-0">{loser.name}</span>
          <span className="min-w-0 truncate" title={loser.path}>
            {loser.path}
          </span>
        </div>
      ))}
    </div>
  );
}
