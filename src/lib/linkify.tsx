import type { ReactNode } from "react";
import OpenAnchor from "../components/OpenAnchor";

/** Split a plain-text run into text + `OpenAnchor`s. GFM's autolink shape:
 * `http(s)://`, `www.` (which GFM turns into `http://www.…`) and `mailto:`.
 *
 * This exists because `remark-gfm`'s autolink literals only cover *prose*: a
 * `<pre>` of tool output is one text node with nothing in it. Everything else
 * is left alone — non-matching spans come back as the original strings, byte
 * for byte, so a caller that renders `whitespace-pre-wrap break-words` keeps
 * every space, tab and newline and adds no box around the run.
 *
 * The result is an ARRAY meant to be used as JSX children, so the elements it
 * holds carry a `key` — an unkeyed element in an array child is a
 * `console.error` from React. */
export function linkifyText(text: string): ReactNode[] {
  // Built per call on purpose: a `g` regex is stateful (`lastIndex`), and a
  // shared one leaks state between calls the moment the scan stops early — a
  // real bug class. Built here, the function is stateless by construction.
  const linkPattern = /(?:https?:\/\/|www\.|mailto:)[^\s<>`]+/g;
  const segments: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (
    let match = linkPattern.exec(text);
    match !== null;
    match = linkPattern.exec(text)
  ) {
    const link = usableLink(match[0]);
    if (link === null) {
      // Punctuation only — leave it in the surrounding text.
      continue;
    }
    if (match.index > cursor) segments.push(text.slice(cursor, match.index));
    segments.push(
      <OpenAnchor key={key++} href={link.href}>
        {link.text}
      </OpenAnchor>,
    );
    // The trimmed tail falls back into the text after the anchor.
    cursor = match.index + link.text.length;
  }

  if (cursor < text.length) segments.push(text.slice(cursor));
  return segments;
}

const SCHEMES = ["https://", "http://", "www.", "mailto:"] as const;

/** A `www.` literal is an `http://` target — that is what GFM does with it. */
function hrefOf(match: string): string {
  return match.startsWith("www.") ? `http://${match}` : match;
}

/** The characters GFM-style autolinks do not want at the end of a URL: a
 * sentence's full stop, a wrapping paren/bracket, a quoting comma, a closing
 * quote. Trimmed here rather than excluded from the match, so they stay in the
 * text. */
const TRAILING_PUNCTUATION = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  ")",
  "]",
  "}",
  '"',
  "'",
]);

function usableLink(raw: string): { text: string; href: string } | null {
  let end = raw.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(raw[end - 1])) end -= 1;
  const text = raw.slice(0, end);
  // Empty, or nothing but the scheme (`https://.`), is not a link.
  const scheme = SCHEMES.find((s) => text.startsWith(s));
  if (scheme === undefined || text.length <= scheme.length) return null;
  return { text, href: hrefOf(text) };
}
