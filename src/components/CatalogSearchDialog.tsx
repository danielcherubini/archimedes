import { Fragment, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { EmptyListLine } from "./EmptyListLine";
import { cn } from "./lib/utils";

/**
 * The SEARCHABLE-CATALOG dialog, once (finding 4).
 *
 * **Skills**, **Agents** and the **model picker** are the same dialog: the
 * bounded `Dialog` box, a header with a title and no description, a search
 * `<Input>`, one empty-state sentence, and a scroll container of rows. Six
 * pieces, spelled three times. This owns those six.
 *
 * WHAT STAYS AT THE SITE — the three differences a shell must not average away:
 *  - **the filter.** Name-only substring for Skills and Agents; `fuzzyMatch`
 *    across name / value / provider for the model picker, which then RE-SORTS
 *    alphabetically and discards the caller's order. The shell therefore takes
 *    the already-filtered `rows` and renders them in the order it is handed —
 *    it has no opinion about matching and no `filter` prop to sneak one in.
 *  - **the row markup**, via `renderRow`. Skills' rows are two lines with scope
 *    cues; an Agent row is a bordered card with three field lines and its own
 *    shadow report.
 *  - **whether the row is a control at all.** Skills' and the model picker's
 *    rows are `role="button"` + `tabIndex` + an Enter handler; **Agents' rows
 *    deliberately are not** — clicking one would have nothing honest to do,
 *    since a definition is addressed by name from the `subagent` call and not
 *    from this modal. So the shell owns NO navigation and NO affordance: it
 *    emits no `role`, no `tabIndex`, no key handler, no click. Its own test
 *    measures that.
 *
 * The two `role="button"` rows the callers pass in are `RowButton` (Task C4),
 * passed in as `renderRow` — NOT folded in here: this shell owns the dialog, not
 * the row. That split is load-bearing, because the row list must stay a keyed
 * `Fragment` with no element of its own, and the row's own ancestry is what the
 * callers' `row.parentElement` pins walk.
 *
 * `McpDialog` (`settings/McpSection.tsx`) is NOT one of these and is deliberately
 * not a caller: `sm:max-w-lg`, a `DialogDescription`, a `grid` of
 * `Field`/`Input`/`Select`/`Textarea`, and a `DialogFooter`. It is a form.
 * Folding it in would have meant widening every prop below to cover a shape with
 * nothing in common with the other three.
 *
 * ---------------------------------------------------------------------------
 * TWO HARD CONSTRAINTS, both invisible to `tsc`
 * ---------------------------------------------------------------------------
 *
 * **NO NEW DOM LEVEL.** A React component boundary adds no element, so owning
 * these six pieces is free — but an extra wrapper element is not. Two tests walk
 * the tree positionally: `SkillsDialog.test.tsx` and `ModelPickerDialog.test.tsx`
 * go `row` → `parentElement` (the scroller, where they assert `min-w-0` +
 * `overflow-y-auto` + `pr-2`) → `parentElement` (the wrapper, `min-w-0`). A
 * wrapper div here would break both while every class string stayed correct.
 * That is why rows are mapped through a keyed `Fragment` (a key needs an element
 * in React's tree, but a `Fragment` renders nothing) and why the empty state
 * REPLACES the scroller instead of sitting beside it.
 *
 * **NO REORDERING.** `AgentsDialog` renders its `noSpaceOpen` notice ABOVE the
 * search field and its orphan block BELOW the rows. A shell shaped
 * `header → input → children` would move that notice below the field — a visual
 * regression that not one test in the repo would notice — so `beforeSearch` is a
 * first-class insertion point rather than a `children` afterthought.
 *
 * `AgentsDialog` also nests a second one — its per-row **Model** control is a
 * `ModelPicker`, which renders `ModelPickerDialog`, which is now a
 * `CatalogSearchDialog`. `AgentsDialog.test.tsx` reads the LAST
 * `[data-slot=dialog-content]` node to reach that nested picker, so the shell
 * renders exactly one `DialogContent`, always, and in mount order the nested one
 * still lands last.
 */
export function CatalogSearchDialog<Row>({
  open,
  onOpenChange,
  title,
  searchPlaceholder,
  query,
  onQueryChange,
  rows,
  keyOf,
  renderRow,
  emptyMessage,
  rowGapClassName = "gap-0.5",
  beforeSearch,
  children,
  className,
}: {
  open: boolean;
  /** Passed straight to the `Dialog`. The caller decides what a close means —
   *  Skills/Agents call their own `onClose`, the model picker sets its own
   *  open state — and the shell does not get to unify those. */
  onOpenChange: (open: boolean) => void;
  /** The `DialogTitle`. None of the three dialogs has a `DialogDescription`,
   *  so the shell renders none; a caller wanting one is not one of these three. */
  title: ReactNode;
  searchPlaceholder: string;
  /** The search text, OWNED BY THE CALLER. It has to be: the same string also
   *  filters Skills' shadow report and Agents' per-row one, so a needle the
   *  shell held privately could not be shared with them. */
  query: string;
  /** The RAW input value — no trim, no lowercase. Normalising is the site's
   *  job, because the site also builds the "no match" copy from `query`
   *  verbatim while filtering on the folded needle. */
  onQueryChange: (query: string) => void;
  /** The ALREADY-FILTERED rows, in the order the caller wants them rendered. */
  rows: Row[];
  /** React's key for one row. A prop rather than a `row.path` assumption
   *  because the three catalogs key differently: a Skill by `path`, a model by
   *  `value`, an Agent definition by `path`. */
  keyOf: (row: Row) => string;
  renderRow: (row: Row) => ReactNode;
  /** The empty-state sentence, or `null` to render the rows. The CALLER picks
   *  it: each dialog has its own ladder (Agents has a loading arm that Skills
   *  has no use for) and its own copy, and every sentence is pinned by that
   *  dialog's own test. The shell owns only the `<p>`'s shape, by rendering
   *  through `EmptyListLine`. */
  emptyMessage: ReactNode;
  /** The scroller's gap: Agents spells `gap-2`, Skills and the model picker
   *  `gap-0.5`. THE ONLY SCROLLER PROP, ON PURPOSE. The rest of that class list
   *  is the shell's contract with the two `parentElement`-walking tests above,
   *  and a free `className` on the scroller is how `min-w-0` or `overflow-y-auto`
   *  quietly disappears. It splices into the position the sites spell the gap,
   *  because `cn(base_with_gap, "gap-2")` would MOVE it to the end of the
   *  attribute — the same utility set in a different order, which `cn` has
   *  always done and which is still a rewritten `class` attribute. */
  rowGapClassName?: string;
  /** Content ABOVE the search field (Agents' `noSpaceOpen` notice). */
  beforeSearch?: ReactNode;
  /** Content BELOW the rows: Skills' shadow report, Agents' orphaned overrides.
   *  Siblings of the scroller, never inside it — a report that scrolled with
   *  the rows would be a different behaviour, and a level deeper would break the
   *  `parentElement` walk. */
  children?: ReactNode;
  /** Merged into the dialog box through `cn()`. */
  className?: string;
}) {
  // The empty state and the rows are ALTERNATIVES, and the empty state wins when
  // it is present: every site's ladder ends in one or the other, and an empty
  // scroller left beside the sentence would be both a stray node and a second
  // `parentElement` for the tests above to land on.
  const empty = emptyMessage !== null && emptyMessage !== undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-h-[70vh] sm:max-w-3xl", className)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[calc(70vh-7.5rem)] min-w-0 flex-col gap-3">
          {beforeSearch}
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={searchPlaceholder}
          />
          {empty ? (
            <EmptyListLine>{emptyMessage}</EmptyListLine>
          ) : rows.length === 0 ? null : (
            <div
              className={cn(
                "flex min-w-0 flex-col",
                rowGapClassName,
                "overflow-y-auto pr-2",
              )}
            >
              {rows.map((row) => (
                // A keyed FRAGMENT: React needs the key somewhere in the tree
                // and this is the one place the shell has to touch the row list,
                // but a `div` here would be the extra DOM level the header
                // comment says the ancestry pins forbid.
                <Fragment key={keyOf(row)}>{renderRow(row)}</Fragment>
              ))}
            </div>
          )}
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
