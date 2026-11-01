import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createHighlighter, type Highlighter } from "shiki";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  ServerIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { Message } from "../store/sessions";
import { useSettings } from "../store/settings";
import type { AppPalette } from "../lib/theme";
import { splitMentionBlocks, type MentionBlock, type SkillBlock } from "../lib/skills";
import { fileIconFor } from "../lib/fileIcons";
import ToolCallCard from "./ToolCallCard";
import SubagentDelegatingCard from "./SubagentDelegatingCard";
import DiffBlock from "./DiffBlock";
import OpenAnchor from "./OpenAnchor";
import { MutedCaption } from "./MutedCaption";
import { cn } from "./lib/utils";
import { useCopyButton } from "../hooks/useCopyButton";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "./Reasoning";
import { Button } from "./ui/button";

/**
 * C7: what `<Button>`'s base and the `ghost`/`default` arms would change at the
 * three `MessageBubble` sites, undone. A bare `<Button>` renders
 * `bg-primary text-primary-foreground h-7 px-2` (`ui/button.tsx:40` sets
 * `defaultVariants {variant:"default"}`), so every site names
 * `variant="ghost"` AND a `size`, and carries its own wall. `ghost` is the arm
 * that matches what all three already were — ink that changes on hover, no fill.
 * Measured with the real `cn()`: for each site the rendered utility SET contains
 * every utility the site spelled before the conversion (nothing lost), and the
 * additions below are the only ones that would have painted.
 *
 * SHARED by all three (`SKILL_HEADER_WALL`, `COPY_GLYPH_WALL`):
 *  - `border-0` — the base's `border` is a 1px ring; preflight sets
 *                 `border: 0 solid`, so none of these sites has one today. It
 *                 would grow every box 2px. With the width at zero the base's
 *                 `bg-clip-padding` is a no-op (padding-box == border-box), so it
 *                 needs no negation even where a background paints.
 *  - `h-auto` / `px-0` — the size's `h-7 px-2` is a fixed 28px tall, 8px-inset
 *                 box. All three sites are content-sized: the header is exactly
 *                 as tall as its label row, the two glyphs are 12px icons.
 *  - `text-[length:inherit]` — the size declares `text-ui-base` and the base
 *                 declares `text-ui-base/relaxed`; `cn` keeps the LAST of the
 *                 font-size group, so this arbitrary-value utility wins BOTH and
 *                 the site keeps the font-size AND the line-height it inherits
 *                 (this is the hazard C7 records: `ChatStreamDirectoryCompletion.test.tsx`'s
 *                 `primaryLines()` finds picker rows with
 *                 `querySelectorAll(".text-ui-base")`, so a site that GAINS the
 *                 token is selected by a test that never saw it).
 *  - `transition-none` — the base's `transition-colors` would fade an ink change
 *                 over 150ms; all three change instantly today. (At the
 *                 attachment badge the base's `transition-colors` is displaced by
 *                 that badge's own `transition-opacity`, which is why no wall
 *                 there spells this.)
 *  - `hover:bg-transparent` — `ghost` adds `hover:bg-hover` and none of these
 *                 sites fills on hover.
 *
 * Provably INERT at all three, so NOT negated: `rounded-md` (no background, no
 * border, so nothing to round — and each site that has a radius spells its own);
 * `outline-none` (`base.css:53-57` forces `outline: none !important` on every
 * focus in every browser, and again under `forced-colors`); `disabled:*` (none of
 * these buttons is ever disabled); `aria-invalid:*` (a `<button>` is never
 * `aria-invalid` here — no form, no field); `group/button` (grep-verified:
 * nothing in the tree reads that group); `has-data-[icon=inline-*]:pr/pl`
 * (lucide sets no `data-icon` attribute); `[&_svg]:pointer-events-none` (the
 * handler is on the button, so the click target moving off the `<svg>` cannot
 * change what runs); `[&_svg]:shrink-0` (every glyph here already spells
 * `shrink-0` or is the only child); `gap-1` (the header spells `gap-2`, which
 * wins; the two glyph sites have exactly one child, so there is no gap to draw);
 * `shrink-0` (the header's parent is a plain block `div`, and the two glyph sites
 * spell `shrink-0` themselves); `whitespace-nowrap` at the glyph sites (a 12px
 * icon has no text to wrap); `select-none` at the glyph sites (an icon carries no
 * selectable text); `justify-center`/`items-center` at the two glyph sites (the
 * wall restores a BLOCK display, so there is no flex container to distribute in);
 * `bg-clip-padding` (no border, and where a background does paint the clip is
 * padding-box == border-box); `text-foreground`/`hover:text-foreground` and
 * `aria-expanded:text-foreground` at the header (it has no direct text node —
 * both its spans and both glyphs spell their own ink, so the colour it declares
 * is never what paints); `gap-1` at the header (`gap-2` wins);
 * `aria-expanded:bg-hover` at the two glyph sites and the badge (neither is ever
 * `aria-expanded` — only the skill header is, and that one negates it).
 */
const SKILL_HEADER_WALL =
  "border-0 h-auto px-0 justify-start whitespace-normal transition-none select-auto text-[length:inherit] hover:bg-transparent aria-expanded:bg-transparent";

/**
 * C7 wall for the two always-visible 12px copy glyphs (the code fence's
 * `Copy code` and the reply's `Copy response`). Both are the same shape — an
 * icon-only button whose display is the UA's `inline-block` — so one wall serves
 * both. `inline-block` is restored rather than argued away because the display
 * group is the one thing that could move the glyph inside its own box: under
 * flex the base's `items-center justify-center` would centre, and at the
 * `copy-response` site the button is a flex ITEM of a `flex-col`, where
 * `inline-block` blockifies to `block` and `self-end` shrinks it to the icon.
 * `justify-start` is spelled because the base centres on the main axis.
 */
const COPY_GLYPH_WALL =
  "border-0 inline-block h-auto px-0 justify-start transition-none text-[length:inherit] hover:bg-transparent";

/**
 * One `<skill>` block injected into a user message: a collapsible card
 * (COLLAPSED by default — ZCode's `ToolLayout` defaults `isOpen` to
 * `false`), styled after the `ToolCallCard`/`FileSummaryCard` conventions:
 * icon + muted label + mono name + a chevron that rotates on open.
 */
function SkillBlockCard({ block }: { block: SkillBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg bg-input px-3 py-2">
      <Button
        type="button"
        variant="ghost"
        size="default"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(SKILL_HEADER_WALL, "flex w-full items-center gap-2 text-left")}
      >
        <WandSparklesIcon className="size-4 shrink-0 text-foreground-subtle" />
        <span className="shrink-0 whitespace-nowrap font-medium text-foreground-subtlest">
          Skill
        </span>
        <span className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtle">
          {block.name}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "ml-auto size-4 shrink-0 text-foreground-subtlest transition-transform",
            open ? "rotate-90" : "rotate-0",
          )}
        />
      </Button>
      {open && (
        <div className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-ui-sm text-foreground-subtle">
          {block.body}
        </div>
      )}
    </div>
  );
}

/**
 * One `@`-agent / `#`-MCP block: the SOFT hint the user's mention injected.
 *
 * Deliberately a compact SINGLE-LINE chip and NOT a collapsible card like
 * `SkillBlockCard`: the block body is a two-sentence nudge ("the user NAMED
 * this resource — the agent may still reason it isn't needed"), not a
 * document worth hiding, so there is no chevron, no expand, and the body is
 * NOT rendered at all (the chip says what happened; the agent's own
 * dispatch/connect row in the transcript is the proof it acted on it).
 */
function NamedResourceChip({ block }: { block: MentionBlock }) {
  // `block.body` is parsed but deliberately NOT rendered: the block is a soft
  // pointer for the AGENT, and the chip only tells the user what they named —
  // expanding the prose hint in the UI would add noise.
  const Icon = block.kind === "agent" ? BotIcon : ServerIcon;
  return (
    <div className="flex items-center gap-2 rounded-lg bg-input px-3 py-2">
      <Icon className="size-4 shrink-0 text-foreground-subtle" />
      <span className="shrink-0 whitespace-nowrap font-medium text-foreground-subtlest">
        {block.kind === "agent" ? "Agent" : "MCP"}
      </span>
      <span className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtle">
        {block.name}
      </span>
      <MutedCaption>named by the user</MutedCaption>
    </div>
  );
}

/**
 * One shared highlighter for the whole app.
 *
 * BOTH syntax themes are loaded in this ONE call (ADR 0027): switching
 * palette then only re-runs `codeToHtml` against themes the singleton already
 * holds — no second highlighter, no re-instantiation, no flash of unhighlighted
 * code. (`createHighlighter` is the expensive part — grammars + themes — so a
 * per-palette instance would pay it twice for a purely cosmetic axis.)
 *
 * `tsx` / `jsx` are in the `langs` list because they are the alias grammars a
 * coding agent emits by far the most. Shiki THROWS on a lang outside this list
 * (`Language `tsx` not found`), the `codeToHtml` call site below catches it,
 * and the catch renders the plain fallback — so before these two entries
 * existed every tsx / jsx fence was silently UNHIGHLIGHTED with no error
 * anywhere. `css` / `html` / `markdown` / `vue` are still absent and still
 * fall back the same way (a known gap, deliberately not widened here).
 */
let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark", "dracula"],
      langs: [
        "bash",
        "rust",
        "typescript",
        "javascript",
        "tsx",
        "jsx",
        "json",
        "python",
        "toml",
        "yaml",
      ],
    });
  }
  return highlighterPromise;
}

/**
 * (ADR 0027) The syntax theme DERIVES from the palette — no separate setting.
 *
 * Deliberately a one-line pure function exported for tests: the rule is then
 * assertable without a DOM, and the render tests below only have to prove the
 * rule is WIRED into `codeToHtml` (via the theme's own paper colour).
 *
 * Anything that is not `"dracula"` — `"zai"`, `null` (settings not loaded /
 * the stored default), `undefined` — answers `github-dark`, which is the
 * behaviour this component had before the palette axis existed. The pairing is
 * coherent in both directions: `dracula` is a DARK syntax theme and only
 * Dracula's dark variant ships here (a scope decision — ADR 0027), so that
 * palette pins the app dark and dark code never sits on a light bubble.
 */
export function shikiThemeFor(
  palette: AppPalette | null | undefined,
): "dracula" | "github-dark" {
  return palette === "dracula" ? "dracula" : "github-dark";
}

/**
 * The ONE body class string, shared by BOTH render branches.
 *
 * It used to be two literals, and they drifted: the fallback `<pre>` carried
 * `p-3` and the highlighted `<div>` did not, so every real fence sat flush
 * against the panel edge while the rare fallback was inset — the opposite of
 * what the doc-comment below promises. Shiki emits no padding (its
 * `<pre class="shiki …">` carries only an inline colour) and no rule in
 * `index.css` pads `pre`, `.shiki` or `code`, so the class was the entire
 * inset. `MessageBubble.codeblock.test.tsx` now asserts the two branches emit
 * the SAME class list, which is only possible while it is one constant.
 *
 * Deliberately NO background class: the highlighted branch must not fight the
 * inline paper colour Shiki writes on its own `<pre>`.
 */
const CODE_BODY_CLASS = "overflow-x-auto p-3 font-mono text-sm";

/**
 * A fenced code block: a bordered panel whose header names the file type
 * (glyph + hue from `fileIconFor`, so a ```tsx fence is the SAME colour as the
 * `.tsx` chip in a tool row) and offers a copy button, above the
 * Shiki-highlighted body. Only the HEADER is a `bg-panel` band: Shiki writes
 * an INLINE `background-color` onto its own `<pre>` (theme paper), which
 * outranks any Tailwind class, so the body is deliberately left unstyled in
 * the background axis — the CSS states what actually renders instead of
 * asserting a class that loses.
 *
 * Why the header is `bg-panel` and not `bg-card`: the descriptor hue it paints
 * is the SAME token a `FileChip` uses, and a `FileChip` rides the transcript
 * column — its row (`TRANSCRIPT_ROW`) carries no background of its own, so the
 * chip shows the column behind it, which is `bg-chat` (`ChatStream.tsx`)
 * = the content slab `#282a36` under Dracula. The raised card is `#343746`
 * and the recessed panel is `#191a21`.
 *
 * The one-step-down shift (amendment to ADR 0027) darkened the raised card
 * enough that all 25 descriptors now clear the 3:1 non-text floor on it (worst
 * `file-py` 3.06) — the seven that failed on the old `#424450` (2.50) now
 * pass. So the header being a recessed `bg-panel` is no longer a legibility
 * requirement: every surface the descriptor can land on clears 3:1 (worst
 * `file-py` 4.50 on the panel `#191a21`, 3.69 on the slab `#282a36`, 3.06 on
 * the raised card `#343746`). The recess is a deliberate band, not a fix. The
 * hues are IDENTITY colours that a palette must not re-hue, so if a palette
 * ever brightens the card again, the surface is what moves — and
 * `fileIconContrast.test.ts` pins both surfaces by TOKEN, so a future move
 * re-measures instead of re-asserting.
 *
 * Header/body separation: the header sits BELOW Shiki's inline `#282A36` paper
 * (`#191a21`, a 1.22 step). It survives because `border-b` is still there and
 * because 1.22 is a visible edge between a band and a body. It is the cost side
 * of the recess, not a free win. `src/lib/fileIconContrast.test.ts` pins both
 * surfaces by TOKEN, so a future move re-measures instead of re-asserting.
 *
 * Ported from ZCode's code block, HEADER ONLY: line numbers, the wrap toggle,
 * Mermaid, the fullscreen viewer and i18n are all out of scope here, and the
 * copy interaction is this repo's own copy→confirm machine (`useCopyButton`:
 * copy → check for 1.5s, timer cleared on unmount) rather than ZCode's.
 *
 * The header renders whether or not the highlight succeeded — the block must
 * never change shape between highlighted and fallback rendering.
 */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);

  // (ADR 0027) Which syntax theme to highlight with. Read straight from the
  // settings store (the same subscription shape `ChatStream` uses for
  // `spinnerStyle`), so a palette change in the settings UI reaches an
  // already-mounted bubble with no reload; `null` (nothing loaded yet, or the
  // stored default) is the zai default.
  const palette = useSettings((s) => s.settings?.palette ?? "zai");

  // Copy → confirm for 1.5s, owned by `useCopyButton` (the timer, the
  // restart-on-second-click and the unmount cleanup all live there now). The
  // BUTTON stays below, at the call site — see the hook's doc-comment for why.
  const { copied, copy: handleCopy } = useCopyButton(code);

  // The identity is derived from a synthetic filename so the fence shares the
  // extension table the file chips use. An absent language is `text` (plain
  // text); an UNKOWN one keeps its own label — `bogus` is more truthful than
  // silently claiming the block is plain text, and it still gets the neutral
  // glyph because `bogus` is not in the table.
  const label = lang?.trim() ? lang.trim().toLowerCase() : "text";
  const descriptor = fileIconFor(`x.${label}`);
  const Icon = descriptor.icon;
  // What Shiki is ASKED for, which is NOT the same string as the label above:
  // `text` is this component's own name for "no language" and Shiki has no such
  // alias (it has `plaintext`), and a `TypeScript` / `JSON` fence must be
  // normalised exactly like the label is. Passing the raw `lang` was a bug:
  // Shiki resolves aliases case-sensitively, so a capitalised fence THREW,
  // the `catch` below rendered the unhighlighted fallback, and the header still
  // showed the lowercased label — the fence looked highlighted and was not.
  const shikiLang = lang?.trim() ? label : "plaintext";

  const header = (
    <div
      data-testid="code-block-header"
      className="flex items-center justify-between gap-2 border-b border-border bg-panel px-3 py-1.5"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon className={cn("size-3.5 shrink-0", descriptor.className)} />
        <span
          data-testid="code-block-lang"
          className={cn(descriptor.className, "font-mono text-ui-caption lowercase")}
        >
          {label}
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="default"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
        className={cn(COPY_GLYPH_WALL, "shrink-0 text-foreground-subtle hover:text-foreground")}
      >
        {copied ? (
          <CheckIcon className="size-3" />
        ) : (
          <CopyIcon className="size-3" />
        )}
      </Button>
    </div>
  );

  useEffect(() => {
    let cancelled = false;
    getHighlighter().then((highlighter) => {
      if (cancelled) return;
      try {
        setHtml(
          highlighter.codeToHtml(code, {
            lang: shikiLang,
            theme: shikiThemeFor(palette),
          }),
        );
      } catch {
        setHtml(null);
      }
    });
    return () => {
      cancelled = true;
    };
    // `palette` is a dependency on purpose: it is what makes an ALREADY-mounted
    // fence re-highlight the instant the palette changes (both themes are
    // already loaded, so this is just a re-render of the body).
  }, [code, lang, palette]);

  if (!html) {
    // Unknown / unsupported language (or the highlighter still loading): same
    // panel, same header, plain body.
    return (
      <div className="my-4 overflow-hidden rounded-lg border border-border">
        {header}
        <pre className={CODE_BODY_CLASS}>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  return (
    <div className="my-4 overflow-hidden rounded-lg border border-border">
      {header}
      <div
        className={CODE_BODY_CLASS}
        // Shiki output is produced locally from the user's own agent output.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/** ADR 0051: the External-open policy is Rust-side; this ONLY stops
 * react-markdown blanking the schemes we ALLOW (its default filter is
 * `http|https|irc|ircs|mailto|xmpp`), and keeps refusing the executable ones so
 * no script-bearing href is ever in the DOM. Deliberately NOT percent-encoding —
 * the href goes to the OS verbatim. NOTE this transform governs `img src` too:
 * `data` stays denied, so a markdown `data:` image stays blanked exactly as it
 * is today — do not "widen" DENIED later. */
const DENIED = ["javascript", "data", "vbscript", "blob", "filesystem"];
const SCHEME = /^[a-z][a-z0-9+.-]*$/i;
export function safeUrlTransform(url: string): string {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  const q = url.indexOf("?");
  const hash = url.indexOf("#");
  const relative =
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (q !== -1 && colon > q) ||
    (hash !== -1 && colon > hash);
  if (relative) return url;
  const scheme = url.slice(0, colon);
  // The token before `:` must be a LEGAL scheme: micromark hands us an
  // already-percent-encoded destination, so `java&#9;script:` arrives as
  // `java%09script:alert(1)`. A `%` is illegal in a scheme; without this test
  // the override would let through a class the DEFAULT filter refused.
  return SCHEME.test(scheme) && !DENIED.includes(scheme.toLowerCase())
    ? url
    : "";
}

/**
 * The ZCode markdown scale, ported from `zcode/packages/ui/src/components/ai-elements/`
 * (`@tailwindcss/typography` `prose*` classes are NOT used — the component
 * mapping below replaces them):
 * - root: `text-ui-base` on `leading-[1.75] tracking-wide`, first/last block
 *   margins trimmed;
 * - plain `p`: unstyled (preflight zero — paragraphs ride the 1.75 leading);
 * - `strong` `font-medium` (not the default bold);
 * - headings `mt-6 mb-4` + the size/weight ramp (h1 `text-ui-xl` … h6
 *   `text-ui-base` `font-normal`);
 * - lists `my-3` + `space-y-1.5` + `marker:text-foreground-subtlest` (ol is
 *   `list-inside` so multi-digit markers never clip), `li` `pl-1` with direct
 *   `p`s inlined;
 * - blockquote `my-4` + `border-l-2 pl-3 text-foreground-subtle`;
 * - code: inline `font-mono text-ui-sm` on the inline-code token (50%), blocks
 *   `my-4` on a `border border-border` panel at 14px mono — a file-type header
 *   (`bg-panel`) above the body, which keeps Shiki's own paper;
 * - links `text-ui-base font-medium` in the icon-blue token, dotted underline
 *   shown on hover — and an activation is an **External open** (`OpenAnchor`),
 *   never a navigation of the Client's own webview;
 * - tables (the ZCode `markdown-table` scale): a `my-3` frame that is
 *   `overflow-x-auto rounded-xl border border-border` (wide tables scroll
 *   instead of breaking the bubble), the table itself `w-max min-w-full`,
 *   cells `px-3 py-2` with a `border-b` row rule, `th` unbolded +
 *   `text-foreground-subtlest`, `td` `align-top`, rows highlight on hover and
 *   the last row drops its rule.
 */
function AgentMarkdown({ text }: { text: string }) {
  const components = useMemo(
    () => ({
      h1: ({ children }: { children?: ReactNode }) => (
        <h1 className="mt-6 mb-4 text-ui-xl font-semibold">{children}</h1>
      ),
      h2: ({ children }: { children?: ReactNode }) => (
        <h2 className="mt-6 mb-4 text-ui-lg font-semibold">{children}</h2>
      ),
      h3: ({ children }: { children?: ReactNode }) => (
        <h3 className="mt-6 mb-4 text-ui-base font-semibold">{children}</h3>
      ),
      h4: ({ children }: { children?: ReactNode }) => (
        <h4 className="mt-6 mb-4 text-ui-base font-semibold">{children}</h4>
      ),
      h5: ({ children }: { children?: ReactNode }) => (
        <h5 className="mt-6 mb-4 text-ui-base font-medium">{children}</h5>
      ),
      h6: ({ children }: { children?: ReactNode }) => (
        <h6 className="mt-6 mb-4 text-ui-base font-normal">{children}</h6>
      ),
      strong: ({ children }: { children?: ReactNode }) => (
        <strong className="font-medium">{children}</strong>
      ),
      ul: ({ children }: { children?: ReactNode }) => (
        <ul className="my-3 list-outside list-disc space-y-1.5 pl-5 marker:text-foreground-subtlest [&_ul]:my-1.5 [&_ol]:my-1.5">
          {children}
        </ul>
      ),
      ol: ({ children }: { children?: ReactNode }) => (
        <ol className="my-3 list-inside list-decimal space-y-1.5 pl-0 marker:text-foreground-subtlest [&_ul]:my-1.5 [&_ol]:my-1.5">
          {children}
        </ol>
      ),
      li: ({ children }: { children?: ReactNode }) => (
        <li className="pl-1 [&>p]:my-0 [&>p]:inline">{children}</li>
      ),
      blockquote: ({ children }: { children?: ReactNode }) => (
        <blockquote className="my-4 border-border border-l-2 pl-3 text-foreground-subtle [&_p]:my-0 [&_p+p]:mt-2">
          {children}
        </blockquote>
      ),
      // The ZCode `markdown-table` scale: a bordered, horizontally
      // scrollable frame around a content-width table (wide tables scroll
      // instead of breaking the bubble); cells get a bottom border, padding,
      // and a min/max width so long content wraps instead of blowing out a
      // column. (ZCode's virtual scrollbar / toolbar / preview dialog are NOT
      // ported — the app's global native-scrollbar styling covers scrolling.)
      table: ({ children }: { children?: ReactNode }) => (
        <div className="my-3 w-full overflow-x-auto rounded-xl border border-border">
          <table className="w-max min-w-full text-ui-base">{children}</table>
        </div>
      ),
      thead: ({ children }: { children?: ReactNode }) => (
        <thead>{children}</thead>
      ),
      tbody: ({ children }: { children?: ReactNode }) => (
        <tbody>{children}</tbody>
      ),
      tr: ({ children }: { children?: ReactNode }) => (
        <tr className="transition-colors last:[&>td]:border-b-0 hover:bg-hover/20">
          {children}
        </tr>
      ),
      th: ({ children }: { children?: ReactNode }) => (
        <th className="border-border border-b px-3 py-2 text-left font-normal text-foreground-subtlest min-w-16 max-w-md whitespace-normal break-words">
          {children}
        </th>
      ),
      td: ({ children }: { children?: ReactNode }) => (
        <td className="border-border border-b px-3 py-2 text-foreground align-top min-w-16 max-w-md whitespace-normal break-words">
          {children}
        </td>
      ),
      a: ({
        children,
        href,
      }: {
        children?: ReactNode;
        href?: string;
      }) => (
        // An **External open**, not a navigation: a bare `<a href>` here handed
        // the click to the webview, which replaced the Client's own page (the
        // navigation guard refuses that, so the click used to do NOTHING).
        // `OpenAnchor` reads the Space cwd from the context itself, which is why
        // this `useMemo` may keep `[]` deps — see below.
        <OpenAnchor
          href={href ?? ""}
          className="text-ui-base font-medium text-icon-blue no-underline decoration-dotted underline-offset-4 hover:underline"
        >
          {children}
        </OpenAnchor>
      ),
      code({ className, children }: { className?: string; children?: ReactNode }) {
        const codeText = String(children ?? "").replace(/\n$/, "");
        const lang = /language-(\w+)/.exec(className ?? "")?.[1];
        if (lang || codeText.includes("\n")) {
          return <CodeBlock code={codeText} lang={lang} />;
        }
        return (
          <code className="rounded-md bg-markdown-inline-code/50 mx-0.5 px-1.5 py-0.5 font-mono text-ui-sm [overflow-wrap:anywhere]">
            {children}
          </code>
        );
      },
    }),
    // `[]` is correct even though the anchor now depends on the Space cwd: the
    // cwd is read by `OpenAnchor` from `SpaceCwdContext`, so the element created
    // here holds no cwd value and the map never goes stale. Adding `cwd` (or a
    // `useSpaceCwd()` call in this component) would rebuild the whole map — and
    // re-parse the markdown — on every Space change for nothing.
    [],
  );

  return (
    <div className="[overflow-wrap:anywhere] min-w-0 max-w-full text-ui-base leading-[1.75] tracking-wide [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      {/* `remark-gfm` is NOT included by default in react-markdown v10 —
       * without it GFM tables (and strikethrough / task lists) fall back to
       * raw pipe text, which is what made tables look broken in the chat. */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={safeUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * The agent's reply: the text on a BAND, with a copy button below it.
 *
 * A NAMED component (not inline JSX in the `switch`) because it holds hooks —
 * the `useCopyButton` call (which owns what used to be a local
 * `useState`/`useRef`/`useEffect` trio) cannot live in a `switch` arm of a
 * component whose other arms return early (`MessageBubble` itself may render a
 * `user` / `tool-call` / `diff` bubble and skip the call entirely, which would
 * change the hook count between renders).
 *
 * THE BAND mirrors the user band (`case "user"` above) and reuses its TOKEN:
 * `bg-composer`, never a copied hex. The palette gives `--color-composer` and
 * `--color-input` the same value today and splits them so a theme can move one
 * without dragging the other; both bands are "the composer's text coming back",
 * so they move together and stay apart from a theme's input surface.
 *
 * `[overflow-wrap:anywhere]` is deliberately NOT copied from the user band:
 * that one renders the raw sentence (a pasted URL must break mid-token), while
 * `AgentMarkdown` renders block elements that prose already wraps.
 *
 * RETURNS A FRAGMENT, not a wrapper `<div>`: `MessageList`'s row wrapper is the
 * flex item here, and `MessageBubble.markdown.test.tsx` reads the markdown root
 * as `container.firstElementChild.firstElementChild` — one more element on the
 * path would shift every one of those assertions.
 */
function AgentText({ text }: { text: string }) {
  // Copy → confirm for 1.5s, owned by `useCopyButton` (the timer, the
  // restart-on-second-click and the unmount cleanup all live there now). The
  // BUTTON stays below, at the call site — see the hook's doc-comment for why.
  // The PROP is what gets copied, so the clipboard receives the markdown
  // SOURCE — backticks, table pipes and all. Reading the rendered DOM back
  // would hand over the text with its markup stripped.
  const { copied, copy: handleCopy } = useCopyButton(text);

  return (
    <>
      {/* THE MARGINS, and why one of them is NEGATIVE.
          `MessageList`'s scroll container is `flex flex-col gap-3` (12px), and a
          flex item's margins ADD to a gap — they can never subtract from it, so
          `mt-0` cannot pull this reply closer to the `Thought` above it than
          12px. `-mt-2` (−8px) is the only way to reach the agreed 4px:
          12 − 8 = 4. `mb-5` (20px) then measures 12 + 20 = 32px below the reply,
          which is the gap a user message already produces under its own band
          (`user-message` carries `my-5`, pinned in `MessageBubble.test.tsx`).
          DO NOT "clean up" the negative margin: removing it does not break the
          layout tests, it silently re-separates the `Thought` row from the reply
          it belongs to — back to 12px, and the pair reads as two rows again.
          They live on the BAND (not on a unit wrapper as in `case "user"`)
          because `agent-text` has no siblings; the user case must put `my-5` on
          its unit precisely because its mention cards and image grid are
          siblings that a band margin would push away. */}
      <div
        data-testid="agent-band"
        className="-mt-2 mb-5 rounded-xl bg-composer px-3 py-2 text-ui-base text-foreground"
      >
        <AgentMarkdown text={text} />
      </div>
      {/* OUTSIDE and BELOW the band, always visible, and pushed to the END
          (right) edge: the reply's surface is the message, the button is a tool
          on it — inside the band it would sit on the composer fill and compete
          with the last line of prose. Under the band reads as a caption for
          what it produced, not a control before it. The distinct accessible
          name (`Copy code` belongs to a code fence) is what lets a test tell
          the two buttons apart in one render. */}
      <Button
        type="button"
        variant="ghost"
        size="default"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy response"}
        title={copied ? "Copied" : "Copy response"}
        data-testid="copy-response"
        // `self-end`: the row wrapper is a `flex-col` (MessageList), whose
        // children default to `stretch`, so without this the 12px icon sat at
        // the START of a button as wide as the column. Aligning to the cross-
        // axis end both shrinks the hit area to the icon and right-aligns it —
        // `w-fit` alone would have kept it on the left, and `ml-auto` is a
        // margin fighting stretch where alignment is the lever. `<Button>`'s
        // base spells no `self-*`, so this survives the merge untouched, and
        // `MessageBubble.test.tsx` reads it straight off this node's className.
        // C7: `COPY_GLYPH_WALL` is what keeps the box the size of the icon — the
        // size's `h-7 px-2` would have made it a 28px tall plate with the glyph
        // centred in it, and `self-end` alone cannot undo that.
        className={cn(
          COPY_GLYPH_WALL,
          "self-end shrink-0 text-foreground-subtle hover:text-foreground",
        )}
      >
        {copied ? (
          <CheckIcon className="size-3" />
        ) : (
          <CopyIcon className="size-3" />
        )}
      </Button>
    </>
  );
}

// Memoized: during a live turn EVERY thought/text chunk replaces only the
// trailing message object in the reducer — every other bubble receives the
// SAME reference. Without this, each chunk re-rendered the whole transcript
// (a full ReactMarkdown re-parse per agent-text bubble), which made the app
// render real slow. Only the changed bubble re-renders now.
export default memo(
  function MessageBubble({
    message,
    isStreaming = false,
    sessionId,
  }: {
    message: Message;
    isStreaming?: boolean;
    /**
     * The ACP session id (optional — the `SubagentTranscript`'s
     * `MessageBubble` does not pass it; a subagent session never has a
     * `subagent` tool call, so the `subagent` branch is never taken there).
     */
    sessionId?: string;
  }) {
    switch (message.kind) {
      case "user": {
        // THE USER'S TEXT RIDES A BAND on the composer's own fill
        // (`bg-composer`): these were the only words in the transcript with no
        // surface of their own, so they read as part of the column rather than
        // as something the user put there. The TOKEN is deliberate, not
        // `bg-input` and not a one-off hex — the palette gives `--color-composer`
        // and `--color-input` the same value today and splits them on purpose so
        // a theme can move one without dragging the other. The user's text is
        // the composer's text coming back, so it wears the composer's token and
        // matches the box it was typed in under every palette.
        //
        // FULL WIDTH, and that width is FREE: `MessageList`'s row wrapper is a
        // `flex-col`, whose children stretch by default, so a plain block-level
        // `div` spans the chat column and ends where the column's `p-4` ends.
        // The earlier shrink-wrap — `inline-block`, `self-start`, `max-w-[85%]`
        // — is all gone, and none of the three may creep back: each ONE
        // silently re-narrows the band (`self-start` alone overrides the
        // stretch; `inline-block` makes the box shrink-to-fit even in a flex
        // column that is not). `rounded-xl` stays — a full-width band with
        // square corners would read as a table row, not as the user's message.
        // NO border (asked for). Measured in a real browser against the built
        // CSS, sampling the rendered pixels — the fill against the chat column
        // is 1.11 (Dracula), 1.12 (zai dark) and 1.08 (zai light, `#ffffff` on
        // a `#f6f6f6` column). All three are faint boundaries — well under the
        // 3:1 a non-text boundary ideally wants — and zai light is the weakest:
        // there the band reads as a barely-there tint. That is the cost of the
        // border going, and no existing token avoids it (`--color-card`,
        // `--color-input` and `--color-header` are all the same `#ffffff` in
        // that palette), so strengthening it further would need a border back or
        // a new token. Accepted knowingly — do not "fix" it unasked.
        //
        // ONLY the text is in the band. The mention rows below stay where
        // they were, on the column, because `SkillBlockCard` /
        // `NamedResourceChip` paint `bg-input` — in the zai palettes that is the
        // SAME colour as `bg-composer`, so inside the band each card's edge
        // would vanish. The band is the user's sentence; the rows are
        // annotations about it.
        //
        // `my-5` = 20px (this repo's `--spacing` is `.25rem`, root font-size is
        // never overridden) separates the band from the transcript around it.
        // The OBSERVED gaps are larger than 20px because a flex item's margins
        // do not collapse, so they stack on the container's own rhythm —
        // measured in a browser against the built CSS: 32px (20 + the `gap-3`
        // 12px) between plain neighbours, 48px (20 + 12 + the breathing
        // `mt-4` 16px) beside a tool row. That is the transcript saying "a new
        // kind of row starts here" twice over; only the band gets these
        // margins, every other row type keeps its existing rhythm.
        //
        // `expandMentions` appends `<skill>` / `<agent>` / `<mcp>` blocks
        // after the user's text; render the blocks as a collapsible card
        // (skill — collapsed by default) or a compact soft-hint chip
        // (agent / MCP) instead of raw text — display-only, the
        // persisted/sent text is unchanged. Images render as a read-only
        // thumbnail grid (the transcript is history — NO remove buttons).
        // `data:` URLs are safe here: the transcript is local.
        const { text, blocks } = splitMentionBlocks(message.text);
        return (
          // THE UNIT carries the 20px, not the band. The mention rows and the
          // image grid below are SIBLINGS of the band (annotations of this
          // message, 8px under it via `mt-2`), so a `my-5` on the BAND would
          // land between a sentence and its own annotations: measured, they sat
          // 28px from the sentence they describe and 12px from the next row of
          // the NEXT message — the association inverts. On the unit the band
          // keeps its 8px neighbours (re-measured: 8px) and the whole user
          // message stands apart.
          // This div is a flex ITEM of `MessageList`'s row wrapper, so it
          // starts a new formatting context and its children's `mt-2` stays
          // INSIDE it rather than collapsing out — hence a text-only message
          // begins exactly at the band (measured: unit.top == band.top, 32px
          // under a plain neighbour = 20 + the container's `gap-3`), and a
          // text-less one (images only) begins 20px down with its images a
          // further 8px below that. The 20px also stacks on the breathing
          // `mt-4` next to a tool row: 48px, measured.
          <div className="my-5" data-testid="user-message">
            {text === "" ? null : (
              // An image-only message has no text: an empty band would be a
              // padded stripe with nothing in it — a paint artefact, not a
              // message. See the block comment above for the width, the fill
              // and the no-border decision.
              <div
                data-testid="user-band"
                className="whitespace-pre-wrap rounded-xl bg-composer px-3 py-2 [overflow-wrap:anywhere] text-ui-base text-foreground"
              >
                {text}
              </div>
            )}
            {blocks.length > 0 && (
              <div className="mt-2 flex flex-col gap-2">
                {blocks.map((block, i) =>
                  block.kind === "skill" ? (
                    <SkillBlockCard key={i} block={block} />
                  ) : (
                    <NamedResourceChip key={i} block={block} />
                  ),
                )}
              </div>
            )}
            {message.images && message.images.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {message.images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt={img.name}
                    title={img.name}
                    className="max-h-48 max-w-64 rounded-lg border border-input-border object-contain"
                  />
                ))}
              </div>
            )}
          </div>
        );
      }

      case "agent-text":
        return <AgentText text={message.text} />;

      case "agent-thought":
        return (
          <Reasoning
            isStreaming={isStreaming}
            autoCollapseKey={isStreaming ? null : "complete"}
          >
            <ReasoningTrigger streamingText={message.text} />
            <ReasoningContent>{message.text}</ReasoningContent>
          </Reasoning>
        );

      case "tool-call":
        return (
          <div className="w-full">
            {message.title === "subagent" ? (
              <SubagentDelegatingCard
                title={message.title}
                status={message.status}
                rawInput={message.rawInput}
                rawOutput={message.rawOutput}
                sessionId={sessionId ?? ""}
              />
            ) : (
              <ToolCallCard
                title={message.title}
                status={message.status}
                diff={message.diff}
                rawInput={message.rawInput}
                rawOutput={message.rawOutput}
              />
            )}
          </div>
        );

      case "diff":
        return (
          <div className="w-full">
            <DiffBlock path={message.path} patch={message.patch} />
          </div>
        );
    }
  },
);
