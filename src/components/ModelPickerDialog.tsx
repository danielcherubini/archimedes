import { useState } from "react";
import { fuzzyMatch } from "../lib/fuzzy";
import { CatalogSearchDialog } from "./CatalogSearchDialog";

/**
 * One model row (the caller flattens its data source — the composer's
 * grouped config options or the settings' model catalog). `value` is the
 * value to select (a `""` value is a "no value" row, e.g. "System
 * default"); `name` is the primary display text; `provider` is the
 * secondary cue (the skills dialog's "global" cue pattern); `disabled`
 * rows are shown but not selectable (the stale-override pattern).
 */
export interface ModelPickerItem {
  value: string;
  name: string;
  provider?: string;
  disabled?: boolean;
}

/**
 * A model's provider as the picker row's muted-grey inline cue: the
 * provider's configured `name` (its display name — `tama` → `Tama`); the
 * raw key when the provider is not configured (a model can reference a
 * key absent from the configured list).
 */
export function providerDisplayName(
  providers: { id: string; name: string }[],
  key: string,
): string {
  return providers.find((p) => p.id === key)?.name ?? key;
}

/**
 * The picker items for a model catalog (the Rust
 * `synthesize_catalog_config_options` shape — flat `{ value: "provider/id" }`
 * entries): the row NAME is the BARE model id (the provider PREFIX is
 * dropped — the provider is already printed as the cue, so keeping the
 * prefix showed it twice: `wizards/Qwen/Qwen3.8-27B (Wizards)`), and the
 * provider cue is the provider's display name (its configured `name` —
 * the raw key when unconfigured). Splitting follows `ModelKey::parse`: the
 * provider id never contains `/`, the MODEL id may, so the FIRST `/` is
 * the boundary. A value without a `/` keeps its name and gets no cue.
 *
 * The VALUE always keeps the full composed key — this is a DISPLAY-only
 * derivation (`settings.defaultModel`, `agentOverrides` and
 * `set_config_option` all still carry `provider/id`).
 */
export function modelItemsFromCatalog(
  values: string[],
  providers: { id: string; name: string }[],
): ModelPickerItem[] {
  return values.map((value) => {
    const slash = value.indexOf("/");
    const providerKey = slash > 0 ? value.slice(0, slash) : "";
    return {
      value,
      name: providerKey === "" ? value : value.slice(slash + 1),
      provider:
        providerKey === ""
          ? undefined
          : providerDisplayName(providers, providerKey),
    };
  });
}

/**
 * The Model picker modal (the skills-dialog pattern): a searchable list
 * of models, ALPHABETICAL (case-insensitive) with a FUZZY search (the
 * `fuzzyMatch` subsequence — `qwen` matches `Qwen3.8`; the query matches
 * the name OR the provider). Clicking a row selects its value and closes
 * the dialog.
 *
 * PROP-DRIVEN: the caller owns the data (the composer's config option /
 * the settings' `listModels` catalog) and the `onSelect` side effect
 * (the `set_config_option` call / the settings save).
 */
export default function ModelPickerDialog({
  open,
  onOpenChange,
  title = "Models",
  items,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  items: ModelPickerItem[];
  onSelect: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  // The fuzzy filter: the query is a subsequence of the name, the provider,
  // OR the full `provider/id` VALUE (`oa` finds `openai`'s models;
  // `wizards/q` finds `wizards/Qwen3.8` — the row text is now the BARE id,
  // so only the value carries the joined shape a user may type).
  const matches = (item: ModelPickerItem): boolean =>
    fuzzyMatch(needle, item.name) ||
    fuzzyMatch(needle, item.value) ||
    (item.provider !== undefined && fuzzyMatch(needle, item.provider));
  // Alphabetical (case-insensitive) — the caller's order is ignored.
  const filtered = (
    needle === "" ? items : items.filter(matches)
  ).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const select = (item: ModelPickerItem) => {
    if (item.disabled) return;
    onSelect(item.value);
    onOpenChange(false);
  };

  return (
    <CatalogSearchDialog<ModelPickerItem>
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      searchPlaceholder="Search models…"
      query={query}
      onQueryChange={setQuery}
      rows={filtered}
      keyOf={(model) => model.value}
      emptyMessage={
        items.length === 0
          ? "No models found."
          : filtered.length === 0
            ? `No models match "${query}".`
            : null
      }
      renderRow={(model) => (
        // LEFT AS A TEMPLATE LITERAL on purpose (Task C8) — a measured
        // same-group conflict, so this is one of the sites the `cn()`
        // convention deliberately does not reach. The row's base spells
        // `cursor-pointer` and the disabled arm spells
        // `cursor-not-allowed`: ONE tailwind-merge cursor group, so `cn`
        // would DROP `cursor-pointer` and a disabled row would render the
        // not-allowed cursor. Today's concatenation keeps both and lets
        // CSS source order decide, and the compiled stylesheet emits
        // `.cursor-pointer` AFTER `.cursor-not-allowed` — so a disabled
        // row shows a POINTER cursor right now. That is probably not what
        // was intended, but it is what the user sees, and changing it is
        // a behaviour change no test owns: nothing in
        // `ModelPickerDialog.test.tsx` reads a cursor class (the disabled
        // case pins `aria-disabled` and the suppressed click). Converting
        // this site belongs with a decision about which cursor a disabled
        // row should show.
        <div
          role="button"
          tabIndex={model.disabled ? -1 : 0}
          aria-disabled={model.disabled ? "true" : undefined}
          onClick={() => select(model)}
          onKeyDown={(e) => {
            if (e.key === "Enter") select(model);
          }}
          className={`group flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1 hover:bg-surface-hover ${
            model.disabled
              ? "cursor-not-allowed opacity-50"
              : ""
          }`}
        >
          <div className="flex items-center gap-2">
            {/* `min-w-0` lets the span shrink below its content
                width so `truncate` clips it (without it the
                min-width:auto floor would push the row past the
                dialog's right edge). The provider (when known)
                is INLINE, after the name, in muted grey — the
                `Qwen3.8-27B (Tama)` shape. */}
            <span className="min-w-0 flex-1 truncate text-ui-base">
              {model.name}
              {model.provider !== undefined && (
                <span className="text-foreground-subtlest">
                  {" (" + model.provider + ")"}
                </span>
              )}
            </span>
          </div>
        </div>
      )}
    />
  );
}
