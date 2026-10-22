import { useState } from "react";
import { TrashIcon } from "lucide-react";
import type {
  AgentConfigDto,
  AgentOverride,
  AgentOverrideFields,
  AgentOverrides,
  AppSettings,
  ModelDto,
  OverrideSource,
  ShadowedAgent,
} from "../lib/tauri";
import { foldAscii, orphanedOverrides, withOverride } from "../lib/agentOverrides";
import ModelPicker from "./ModelPicker";
import { EmptyListLine } from "./EmptyListLine";
import { MutedCaption } from "./MutedCaption";
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
 *   the catalog refetches (a Space switch, or the next pane mount after a save —
 *   `SpacesList` evicts the catalog on a successful write), which is why they are
 *   labelled `runs` — "what the last fetch saw the dispatch launch with" — and
 *   never restated as a promise about the edit you just made.
 *
 * The fetch-time `row.override` column is NOT bound to the controls — but it is
 * READ, for the one case where it and the store-side lookup disagree (see
 * `storedPinDiff`). Two selectors over one map can pick different entries, and a
 * row that silently shows one pin while the dispatch resolves the other is the
 * exact misrepresentation the rest of this component is written against.
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

/** The `edited` set's key for one row-field (see `patch`). Folded, because a row
 *  and the map key it matched can differ in case, and both write the same field. */
function editedKey(name: string, field: keyof AgentOverride): string {
  return `${foldAscii(name)}\u0000${field}`;
}

/** The empty suppression set (see `edited`): allocated ONCE so the "nothing is
 *  suppressed" identity is stable across renders — it is handed down as a prop. */
const NO_KEYS: ReadonlySet<string> = new Set();

interface AgentsDialogProps {
  rows: AgentConfigDto[];
  /**
   * True while NO **Space** is open. This changes the COPY only — the override
   * map is GLOBAL, so nothing is disabled: with no Space the rows are the
   * user-level set, exactly what the deleted Settings section offered. (In the
   * old per-Space plan this flag disabled every control, because there was no
   * layer to write to without a Space. There is always one now.)
   *
   * It gates ONE thing that is not copy: the orphan block. The rows it lists come
   * from a catalog discovery that was only allowed to read the user roots, so an
   * entry can be "undiscovered" here and live in every project that defines that
   * name — which is why no remove button is offered in that state. See `orphans`.
   */
  noSpaceOpen: boolean;
  settings: AppSettings | null;
  models: ModelDto[];
  tools: string[];
  /**
   * How many of THIS mount's writes have FAILED and rolled the store back to the
   * file's map — TRANSIENTLY, once the mount's write queue holds a link whose
   * composed map still carries the failed field: that link re-applies it when it
   * completes (see `writeAgentOverrides`). The mount owns the save, and a rollback
   * takes back the one thing the `edited` set was built on — the explanation that a
   * difference against the fetch
   * column is a save the backend already has. A write that never landed explains
   * nothing, so the suppression is dropped when this moves (see `edited`).
   *
   * Optional because the dialog is prop-driven and its own tests have no writes; the
   * mount always passes it.
   */
  rolledBackWrites?: number;
  onPatch: (next: AgentOverrides) => void;
  onClose: () => void;
}

export default function AgentsDialog({
  rows,
  noSpaceOpen,
  settings,
  models,
  tools,
  rolledBackWrites = 0,
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
  //
  // THE SECOND GATE, `noSpaceOpen`, is the same argument one level up and it is
  // the stronger one. With no Space open the rows are the USER-level set, so a key
  // for a definition some PROJECT defines reads as "undiscovered" here while being
  // perfectly live in every project that defines it. The modal has no signal that
  // distinguishes "stale everywhere" from "defined in a project I was not allowed to
  // read" — `noSpaceOpen` IS that signal, and the honest consequence is to render no
  // orphan block at all rather than one whose trash button is armed against data the
  // modal cannot prove stale (a reworded-but-still-clickable button would still be
  // the ADR's only cleanup path firing on live data).
  //
  // The trade-off, stated so it cannot be mistaken for a loss: while NO Space is
  // open, a GENUINELY user-level orphan gets no cleanup row here either. It is not
  // orphaned away — the map is global, and a name no root contributes stays
  // undiscovered in EVERY Space's catalog, so the same key surfaces (with its remove
  // button) as soon as any Space is open. ADR 0023's cleanup duty is therefore
  // reachable FROM ANY STATE IN WHICH A SPACE IS OPEN, just not from the one state in
  // which the modal can only see half the roots; what the no-Space state loses is
  // only the stale claim it cannot support.
  const orphans =
    settings === null || rows.length === 0 || noSpaceOpen
      ? []
      : orphanedOverrides(settings.agentOverrides, rows);

  /** One write, always through the shared editor: `withOverride` owns the
   * case-fold-twin drop and the delete-the-empty-entry rule, which are the two
   * things a hand-assembled spread in this component would get wrong.
   *
   * The `edited` bookkeeping exists for the stored-pin cue and nowhere else: a
   * field the user has written in this mount has an EXPLAINED difference between
   * the store map and the fetch-time `row.override` column, so the cue must not
   * claim the backend is reading something stale that the backend was just told.
   *
   * The set is stamped with the `rolledBackWrites` value it was recorded against,
   * and a stamp that no longer matches is treated as EMPTY — DERIVED STATE (a plain
   * read of state + prop during render), not the state-adjustment pattern: no
   * `setState`, no effect, no extra render is involved. A failed save rolls the
   * store back to the FILE's map — TRANSIENTLY, once the mount's queue holds a link
   * whose composed map still carries the failed field (see `writeAgentOverrides`) —
   * which takes back the explanation the suppression
   * rests on: the difference is unexplained again, and the row has to say it.
   *
   * The whole set goes, not just the failed field's key, because that is the fact
   * the mount actually has — the save is per-MAP, so a failure names no field. The
   * collateral is a cue that comes back for an earlier edit of the same mount that
   * DID land; that one is a nuisance rather than a lie, since the line reports what
   * the last fetch saw and the fetch really does predate the landed write. (The
   * narrower version needs the failure to carry the fields it rolled back, which the
   * map-shaped write API has no way to say.) */
  const [edits, setEdits] = useState<{ rolls: number; keys: Set<string> }>(
    () => ({ rolls: 0, keys: new Set() }),
  );
  const edited: ReadonlySet<string> =
    edits.rolls === rolledBackWrites ? edits.keys : NO_KEYS;
  const patch = (name: string, field: keyof AgentOverride, value: string | string[] | undefined) => {
    if (settings === null) return;
    const key = editedKey(name, field);
    // FUNCTIONAL on purpose: two patches inside one React batch (a click that
    // triggers a write and a sibling write, or a fast double-pick) each get the
    // SAME render-time `edited`, so the object form made the second `setEdits`
    // overwrite the first and LOSE the first key — the suppression then went quiet
    // for a field the user had demonstrably edited. `prev` is the queue's truth.
    // (The stamp reads the `rolledBackWrites` PROP, which an updater cannot reach
    // through `prev`; that half stays render-time, which is correct — a rollback
    // arriving mid-batch belongs to the next render's derivation.)
    setEdits((prev) => ({
      rolls: rolledBackWrites,
      keys: new Set(prev.rolls === rolledBackWrites ? prev.keys : NO_KEYS).add(
        key,
      ),
    }));
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
            <EmptyListLine>Loading…</EmptyListLine>
          ) : rows.length === 0 ? (
            <EmptyListLine>No Agent definitions found.</EmptyListLine>
          ) : filtered.length === 0 ? (
            <EmptyListLine>{`No agents match "${query}".`}</EmptyListLine>
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
                  edited={edited}
                  onPatch={patch}
                />
              ))}
            </div>
          )}
          {/* Orphaned overrides — muted rows with a remove button, the shape the
              deleted Settings section used (ADR 0023's only cleanup path). The
              `noSpaceOpen` case renders NOTHING here: see `orphans` above — with no
              Space the list is user-level only, so an override for a project-only
              definition would be labelled stale and armed with this ADR's only
              cleanup button, and the modal has no signal to tell that apart from a
              genuinely dead key. */}
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
                  <MutedCaption>No longer discovered (stale override)</MutedCaption>
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
 * The row's stored-pin DISAGREEMENT line (`row.override` vs the store-side map).
 *
 * `row.override` is the stored entry as the BACKEND's selector read it — the
 * supervisor's `override_layer` scan, which takes the first key the `HashMap` hands
 * back. The picker is bound to the live settings document, looked up by this
 * dialog's own ASCII-fold scan, which takes the first key in DOCUMENT order. Two
 * selectors over one map, so they agree everywhere except in the case they both
 * exist to handle: hand-edited case-fold twins (`"Scout"` beside `scout` — Rust
 * picks one by HashMap luck, the picker the other by insertion order) and a
 * `settings.json` the desktop has not re-read since something else wrote it. The
 * user then sees one pin while the dispatch launches with the other, and nothing on
 * the row says so. This is also where the ADR 0023 soft-degrade story gets a
 * visible home: what you pinned and what runs are different columns, and now a
 * stored pin can differ from the one the picker edits.
 *
 * Returns one clause per disagreeing field (an EMPTY list = nothing to say, which
 * is the ordinary case). A `null` on the wire means "the backend found no stored
 * value for this field", which is not a disagreement with a field the picker also
 * shows as unset — hence the `!== null` guard on every arm. The tool list compares
 * as the string the row prints, because that is what the user is reading.
 *
 * `edited` names the fields THIS dialog has written since it mounted, and they are
 * skipped. `row.override` is a FETCH-time value — the same lag the `runs` columns
 * carry — so the moment the user picks a different model the wire column differs
 * from the store-side map on purpose, and the backend already has the newer value.
 * Calling a difference the user just caused "the stored pin the last fetch saw
 * differs" would be the reverse of the honesty this line exists for. What is worth
 * naming is a disagreement the modal did NOT cause, and it runs BOTH ways: the file
 * moved under a fetch that predates it (Rust remembered a thinking level, something
 * else wrote `settings.json`, or this modal's own save failed and rolled the store
 * back to the file), and two selectors reading one map differently (the case-fold
 * twin). Hence the PAST tense in the copy — the line reports what the last FETCH saw,
 * which is a fact about a finished read, not a claim about what the backend reads now.
 * A save that failed clears the suppression entirely (see `rolledBackWrites`), so the
 * first of those cases cannot be silenced by a write that never landed.
 */
function storedPinDiff(
  rowName: string,
  wire: AgentOverrideFields,
  stored: AgentOverride | undefined,
  edited: ReadonlySet<string>,
): string[] {
  const parts: string[] = [];
  const says = (field: keyof AgentOverride, text: string) => {
    if (!edited.has(editedKey(rowName, field))) parts.push(text);
  };
  if (wire.model !== null && wire.model !== stored?.model) {
    says("model", `model ${wire.model}`);
  }
  if (wire.thinking !== null && wire.thinking !== stored?.thinking) {
    says("thinking", `thinking ${wire.thinking}`);
  }
  if (
    wire.tools !== null &&
    wire.tools.join(", ") !== (stored?.tools ?? []).join(", ")
  ) {
    says("tools", `tools ${wire.tools.join(", ") || "—"}`);
  }
  return parts;
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
  edited,
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
  /** Which `<name, field>` pairs this dialog has already written — the stored-pin
   *  cue skips those (their difference is explained by the edit). */
  edited: ReadonlySet<string>;
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
  // level no model still advertises must render as its own option — keyed on
  // `stored.thinking`, because the picker's job is to show what the user PINNED,
  // not what runs (`row.effective.thinking` is the other column, and the resolver
  // demotes a pin the winning model lacks, so the two differ routinely). Offered
  // DISABLED for the same reason the model above is.
  const staleLevel =
    stored?.thinking !== undefined &&
    stored.thinking !== "" &&
    !thinkingLevelUnion.includes(stored.thinking)
      ? stored.thinking
      : null;
  // The stored-pin disagreement for THIS row (see `storedPinDiff`): the fields
  // where the fetch-time `row.override` column and the entry the pickers are bound
  // to disagree for a reason this modal did not cause. An empty list renders
  // nothing, which is the ordinary case.
  const pinDiff = storedPinDiff(row.name, row.override, stored, edited);

  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-ui-base">{row.name}</span>
        {row.scope === "user" && (
          <MutedCaption>global</MutedCaption>
        )}
        <MutedCaption className="min-w-0 flex-1 truncate" title={row.path}>
          {row.path}
        </MutedCaption>
      </div>
      {row.description !== "" && (
        <span
          className="min-w-0 truncate text-ui-sm text-foreground-subtle"
          title={row.description}
        >
          {row.description}
        </span>
      )}

      {/* The stored-pin disagreement (see `storedPinDiff`): one muted line naming
          each field whose STORED value the backend's selector read differently from
          the entry the pickers below are bound to. PLAIN TEXT like the shadowing
          disclosure at the bottom of the row — there is no honest control here (the
          fix is to set the field again from the picker), and a button would promise
          a repair this component cannot perform. */}
      {pinDiff.length > 0 && (
        <MutedCaption className="min-w-0 truncate">
          stored pin the last fetch saw differs — {pinDiff.join(", ")}
        </MutedCaption>
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
        <MutedCaption className="min-w-0 truncate">
          runs {row.effective.model ?? "—"}
        </MutedCaption>
        <LayerTag>{sourceLabel(row.source.model, "model")}</LayerTag>
        <MutedCaption className="min-w-0 truncate">
          in the file {row.file.model ?? "—"}
        </MutedCaption>
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
        <MutedCaption className="min-w-0 truncate">
          runs {row.effective.thinking ?? "—"}
        </MutedCaption>
        <LayerTag>{sourceLabel(row.source.thinking, "thinking")}</LayerTag>
        <MutedCaption className="min-w-0 truncate">
          in the file {row.file.thinking ?? "—"}
        </MutedCaption>
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
              // DISABLED, symmetric with the stale MODEL item: the control already
              // holds this value, so clicking it re-fires `onValueChange` with the
              // same string and rewrites the same level — a control that looks like
              // it does something and only costs a save.
              <SelectItem value={staleLevel} disabled>
                {staleLevel}
              </SelectItem>
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
            <MutedCaption className="min-w-0 truncate">
              {/* Two spans, not one interpolated sentence: ADR 0067's labelled
                  empty state has to be findable as ITS OWN text (the
                  `Inherits parent tools` string is what the ADR names, and the
                  test — and a screen reader's announcement — should be able to
                  point at it). */}
              <span>file: {(row.file.tools ?? []).join(", ") || "—"}</span>
              <span> · </span>
              <span>{toolsInheritLabel(row.source.tools)}</span>
            </MutedCaption>
          ) : (
            <MutedCaption className="min-w-0 truncate">
              file: {(row.file.tools ?? []).join(", ") || "—"} · runs:{" "}
              {(row.effective.tools ?? []).join(", ") || "—"} (
              {sourceLabel(row.source.tools, "tools")})
            </MutedCaption>
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
      <MutedCaption as="p">
        {shadowHeading(row.scope, losers.length)}
      </MutedCaption>
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
