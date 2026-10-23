import type { ReactElement, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/components/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * A settings section card: a rounded-xl card hosting rows (the ZCode
 * `SettingsGroupCard` port).
 */
export function SettingsGroupCard({ children }: { children: ReactNode }): ReactElement {
  return (
    <Card className="overflow-hidden rounded-xl border border-border bg-card py-0 shadow-none">
      <CardContent className="space-y-0 px-0">{children}</CardContent>
    </Card>
  );
}

/**
 * One settings row: label + description left, control right (the ZCode
 * `SettingsRow` port — `grid-cols-[minmax(0,1fr)_192px]`, `border-t` rows,
 * `first:border-t-0`, `px-4 py-3`). `controlLayout="wide"` widens the
 * control column (`sm:grid-cols-[minmax(0,1fr)_280px]`) and moves `detail`
 * into it.
 */
export function SettingsRow({
  label,
  description,
  control,
  detail,
  controlLayout = "default",
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  detail?: ReactNode;
  controlLayout?: "default" | "wide";
}): ReactElement {
  return (
    <div className="border-t border-border px-4 py-3 first:border-t-0">
      <div
        className={cn(
          "grid items-center gap-4",
          controlLayout === "wide"
            ? "grid-cols-1 sm:grid-cols-[minmax(0,1fr)_280px]"
            : "grid-cols-[minmax(0,1fr)_192px]",
        )}
      >
        <div className="min-w-0">
          <div className="text-ui-base font-medium text-foreground">{label}</div>
          {description ? (
            <div className="mt-1 text-ui-base leading-6 text-foreground-subtle">
              {description}
            </div>
          ) : null}
        </div>
        <div className="flex w-full flex-nowrap items-center justify-end gap-2">
          {controlLayout === "wide" ? detail : null}
          {control}
        </div>
      </div>
      {detail && controlLayout !== "wide" ? <div className="mt-3">{detail}</div> : null}
    </div>
  );
}

/**
 * The shell of a settings LIST row — the divider + padding, and nothing else
 * (the ZCode-port sibling of `SettingsRow`, Finding 6b).
 *
 * `SettingsRow` is a PREFERENCE row: it owns a `grid-cols-[minmax(0,1fr)_192px]`
 * label/control grid and label + description markup. A settings section also
 * lists DATA — a configured provider, an MCP server, a detached session — and
 * those rows own their own layout (a `grid` of fields, a `flex flex-wrap` of
 * text column + ghost icon buttons). Routing a data row through `SettingsRow`
 * would give it a 192px control column it does not have and a label it does not
 * want, which is exactly why the report says NOT to. So this primitive owns the
 * one fact the data rows actually agree on — the shell — and the three call
 * sites keep their own content:
 *
 *   `border-t border-border px-4 py-3 first:border-t-0`
 *
 * which `ProviderSection`'s provider row, `McpSection`'s `McpRow` and
 * `SessionsSection`'s detached row each spelled by hand.
 *
 * `border-t` STAYS ON THE ROOT and the component adds no element of its own.
 * Both are load-bearing, not stylistic: `SettingsPage.test.tsx:940,1352,1497`
 * locate rows with `document.querySelectorAll(".border-t")` and
 * `SessionsSection.test.tsx:93` with `getByText(path).closest('[class*="border-t"]')`
 * — so the divider may not move to an inner wrapper, and a wrapper element would
 * insert a DOM level between the row and the layout the section puts inside it.
 * `primitives.test.tsx` pins both query shapes and the no-extra-DOM property.
 *
 * `className` merges through `cn()`, so a variant (the wider `px-4 py-3` of an
 * empty-state row, say) can win a padding conflict the same way
 * `IpcErrorLine`'s `className` does.
 */
export function SettingsDataRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div
      className={cn(
        "border-t border-border px-4 py-3 first:border-t-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A subtle inline badge (the ZCode `SettingsBadge` port; an optional
 * `title` for the error tooltips). */
export function SettingsBadge({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}): ReactElement {
  return (
    <span
      title={title}
      className="rounded-md bg-surface px-2.5 py-1 text-ui-base font-medium text-foreground-subtle"
    >
      {children}
    </span>
  );
}

/**
 * A section-nav button (the ZCode `SettingsSidebarButton` port — `h-8
 * w-full rounded-xl px-2.5`, icon + label; active = `bg-surface-hover
 * text-foreground`, inactive = `text-foreground-subtle
 * hover:bg-surface-hover hover:text-foreground`). The `ControlHintTooltip`
 * is the app's `ui/tooltip` (a local `TooltipProvider` — the app has no
 * global provider).
 *
 * C7: this is a `<Button>`, and the variant is **`link`, not `ghost`** — a
 * decision, not an oversight. `ghost` adds `hover:bg-hover`, and `cn()` can only
 * drop it by replacing it with another `hover:bg-*`; the only candidate is a
 * re-spelled `hover:bg-surface-hover`, which `primitives.test.tsx:113` forbids on
 * the ACTIVE arm (the pin that keeps the active row from also being a hover row).
 * `link` has no hover background at all, so nothing has to be undone: its
 * `hover:underline` is cancelled by `hover:no-underline`, and its `text-primary`
 * loses the text-colour group to whichever arm is rendered. Measured with the
 * real `cn()`, BOTH arms render the exact utility set they spelled before, and
 * the active arm contains `bg-surface-hover` without `hover:bg-surface-hover`.
 * `size="lg"` is the size whose `h-8 px-2.5` the row already spells; its
 * `rounded-lg` and `gap-1` lose to the row's own `rounded-xl`/`gap-2`, and the
 * wall's `text-[length:inherit]` (below) collapses both its `text-ui-base` and
 * the base's `text-ui-base/relaxed`, so no font-size and no line-height is
 * declared at all — which is what the plain `<button>` did.
 *
 * What `NAV_BUTTON_WALL` undoes:
 *  - `border-0` — the base's `border` is a 1px ring this row never had
 *    (preflight sets `border: 0 solid`); it would indent the glyph by 1px and
 *    shrink the label column. It also makes the base's `bg-clip-padding` a no-op
 *    on the active arm: with a zero-width border, padding-box and border-box are
 *    the same box, so `bg-surface-hover` fills exactly what it filled before.
 *  - `select-auto` — the base's `select-none` would make a section name
 *    unselectable.
 * Belt-and-braces, provably inert here: `justify-start` (the base centres on the
 * main axis, but the label wrapper is `flex-1`, so there is no free space to
 * distribute). Inert additions include the base's `whitespace-nowrap`: the row
 * inherits `normal` today, but it holds NO direct text — both children are
 * spans, and the label span spells `truncate` (whose own `white-space: nowrap`
 * it needs anyway) — so there is nothing for the row's `white-space` to apply to.
 * Inert: `text-[length:inherit]` in the wall makes the font-size question
 * moot — it collapses both the size's `text-ui-base` and the base's
 * `text-ui-base/relaxed`, so the row declares no font-size and no line-height,
 * exactly as a plain `<button>` declared neither; its ONLY painted text is the
 * label span, which spells `text-ui-base` itself, and its icon is an `<svg
 * class="size-4">` sized in rem. `outline-none` (`base.css:53-57` forces
 * `outline: none !important` on every focus, and again under `forced-colors`);
 * `disabled:*` / `aria-invalid:*` / `aria-expanded:*` (a nav row is none of those
 * — and Radix's Tooltip trigger sets `aria-describedby`, never `aria-expanded`);
 * `underline-offset-4` (no underline survives `hover:no-underline`);
 * `group/button`; `shrink-0` (a block child of the sidebar's `space-y-1` div, so
 * `flex-shrink` never applies); `has-data-[icon=inline-*]:pr/pl` (lucide sets no
 * `data-icon`); `[&_svg]:pointer-events-none` (the click handler is on the
 * button); `[&_svg]:shrink-0`; and `[&_svg:not([class*='size-'])]:size-4` — the
 * icon carries an explicit `size-4`, so the `:not([class*='size-'])` guard
 * excludes it (the icon-resize hazard, checked).
 */
const NAV_BUTTON_WALL =
  "border-0 select-auto justify-start hover:no-underline text-[length:inherit]";

export function SettingsSidebarButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick?: () => void;
}): ReactElement {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="link"
            size="lg"
            aria-label={label}
            onClick={onClick}
            className={cn(
              NAV_BUTTON_WALL,
              "flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors",
              active
                ? "bg-surface-hover text-foreground"
                : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center text-current">
              <Icon className="size-4 text-foreground" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="truncate text-ui-base text-foreground">{label}</span>
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" align="center">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Whether a persisted string is a value the picker actually offers — returned
 * narrowed, or `null`. A blank string counts as ABSENT (the same rule the blank
 * `defaultThinkingLevel` case establishes — and Radix rejects an empty-valued
 * item). */
function offeredValue(
  stored: string | null | undefined,
  options: readonly string[],
): string | null {
  return typeof stored === "string" && stored !== "" && options.includes(stored)
    ? stored
    : null;
}

/**
 * The `Select` value for a setting whose option list is a CLOSED vocabulary
 * (`theme`, `palette`). The persisted document is user-editable and the
 * backend round-trips these fields unvalidated, so any string can reach a
 * picker — and Radix renders NOTHING for a value with no matching item, which
 * blanks the trigger (the user loses both the "what is active" readout and
 * the way back to an option). So an unrecognised value selects `fallback`
 * instead. This is a RENDERING rule only: it never writes, so opening the page
 * leaves the file untouched.
 */
export function closedSelectValue(
  stored: string | null | undefined,
  options: readonly string[],
  fallback: string,
): string {
  return offeredValue(stored, options) ?? fallback;
}

/**
 * The `Select` value + items for a setting whose vocabulary is OPEN (the font
 * families: `applySettingsFont` splices ANY non-null family into the CSS
 * stack, so an off-list one is genuinely applied and coercing it to the
 * default would misreport what is on screen). A value the list does not offer
 * is surfaced as its own extra item — the app's established pattern for a
 * stored value outside a select's list (the default-thinking-level and
 * subagent-model pickers) — so the trigger always reads the stored value and
 * the offered options stay reachable as the way out.
 */
export function openSelectItems(
  stored: string | null | undefined,
  options: readonly { value: string; label: string }[],
): { value: string; items: { value: string; label: string }[] } {
  const values = options.map((option) => option.value);
  const offered = offeredValue(stored, values);
  if (offered !== null) return { value: offered, items: [...options] };
  // Not offered: either an off-list value (kept, and shown as its own item) or
  // an absent/blank one (the first option — the `"default"` sentinel).
  const offList = typeof stored === "string" && stored !== "" ? stored : null;
  return {
    value: offList ?? options[0]!.value,
    items:
      offList === null
        ? [...options]
        : [...options, { value: offList, label: offList }],
  };
}

/**
 * Humanize a braille variant name for display (`wave-rows` → `Wave rows`):
 * the spinner picker's cell labels + accessible names (the reference
 * settings UI's `capitalize` port, over the hyphen-split words).
 */
export function humanizeVariant(variant: string): string {
  return variant
    .split("-")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}
