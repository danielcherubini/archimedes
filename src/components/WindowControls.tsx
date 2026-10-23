import { getCurrentWindow } from "@tauri-apps/api/window";
import { MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { CHROME_BUTTON, CHROME_BUTTON_CLOSE } from "./chromeButton";
import { cn } from "./lib/utils";
import { Button } from "./ui/button";

/**
 * C7 (finding 6d): these three controls are `<Button>`s now, on the `ghost`
 * variant and the `icon` size — the arm whose hover pair
 * (`hover:bg-hover hover:text-foreground`) IS the chrome grammar's, and the size
 * whose box (`size-7`) IS the chrome box. `CHROME_BUTTON` stays the authority
 * for geometry and ink: it is passed as `className`, which `Button` merges LAST,
 * so the constant wins every group it spells and the primitive contributes only
 * utilities that cannot repaint these buttons.
 *
 * The one base utility that WOULD repaint them is `border` — a 1px ring. It is
 * undone by `border-0` below, and the reason is `bg-clip-padding` (also base):
 * with a 1px border-box the hover fill would stop 1px short of the 28px box the
 * chrome bar has always painted. `border-0` makes that clip a no-op (a
 * zero-width border leaves `padding-box` and `border-box` the same box), which is
 * the same reasoning `AskQuestionCard.tsx` records for its own wall.
 *
 * What else the base adds, and why none of it is visible here:
 *  - `text-ui-base/relaxed`, `whitespace-nowrap`, `select-none` — these buttons
 *    render NO text; their only child is an `aria-hidden` `<svg>`;
 *  - `outline-none` — `base.css:53-57` already forces `outline: none !important`
 *    on every `:focus`/`:focus-visible`, and again under `forced-colors`;
 *  - `shrink-0`, `[&_svg]:shrink-0` — the box is fixed at `h-7 w-7` inside a
 *    `gap-0.5` flex row with no competing pressure, so nothing shrinks;
 *  - `[&_svg]:pointer-events-none` — the click handler is on the button and the
 *    attention alert reads `event.target.closest(...)`, so which of the two the
 *    pointer lands on changes nothing;
 *  - `disabled:*` — never disabled (a window control that could be disabled
 *    would be a window you cannot close);
 *  - `aria-invalid:*` / `aria-expanded:*` — neither attribute is ever set here;
 *  - `group/button` — nothing in the tree reads that group;
 *  - `bg-clip-padding` — see above: a no-op once `border-0` lands;
 *  - `[&_svg:not([class*='size-'])]:size-4` — INERT BY CONSTRUCTION, because the
 *    icons carry an explicit `size-*` CLASS. They used to size themselves with
 *    the `size={14}`/`size={12}` PROP, and a CSS rule beats a presentation
 *    attribute, so without the class all three glyphs would silently grow to
 *    16px. The class is the same number the prop already said.
 *
 * FRAMELESS WINDOW CONTROLS. The window is created `decorations: false`
 * (see tauri.conf.json), so the native titlebar — and its close / minimize /
 * maximize buttons — is gone. These replace it. The surrounding top bar in
 * App.tsx is the drag region (`data-tauri-drag-region="deep"` on the
 * container — "deep" extends the region to the whole subtree, since a bare
 * attribute only drags from the element clicked DIRECTLY): the bar's empty
 * areas drag the window (double-click maximizes) while these buttons
 * (interactive elements without the attribute) still block it and stay
 * clickable.
 */
const CHROME_BUTTON_WALL = "border-0";

export default function WindowControls() {
  const win = getCurrentWindow();

  return (
    // `data-window-control` is the attention-alert exemption (ADR 0038): the
    // activity handler treats a pointer/key event whose target resolves inside
    // this container as NOT attention, because "run finishes → click Minimize →
    // walk away" is that feature's main use case and a self-cancelling alert
    // would be worse than none. The scope is these three buttons ONLY — a click
    // on the rest of the drag bar, a Space tab, or one of the app controls in
    // `ChromeControls` (which sits immediately to the left of this container,
    // OUTSIDE it on purpose) IS attention. Any control added here inherits the
    // exemption, so add one deliberately.
    <div className="flex items-center gap-0.5" data-window-control>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title="Minimize"
        onClick={() => void win.minimize()}
        className={cn(CHROME_BUTTON_WALL, CHROME_BUTTON)}
      >
        <MinusIcon size={14} className="size-3.5" aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title="Maximize / Restore"
        onClick={() => void win.toggleMaximize()}
        className={cn(CHROME_BUTTON_WALL, CHROME_BUTTON)}
      >
        <SquareIcon size={12} className="size-3" aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title="Close"
        onClick={() => void win.close()}
        className={cn(CHROME_BUTTON_WALL, CHROME_BUTTON_CLOSE)}
      >
        <XIcon size={14} className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}
