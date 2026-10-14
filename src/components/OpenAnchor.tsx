import type { ReactNode } from "react";
import { externalOpen } from "../lib/tauri";
import { useSpaceCwd } from "./SpaceCwd";

/** An anchor whose click is an **External open** — the OS's own default
 * handler, never a navigation of the Client's webview.
 *
 * `href` stays on the element: hover target, keyboard focus and copy-link all
 * still work; only the activation is intercepted. Every left-click AND
 * modifier-click (ctrl/cmd/shift) is routed to `external_open`, because the
 * Client has no "open in a new tab" for a modifier to mean instead. There is
 * deliberately no `onMouseDown`/`onAuxClick`: keyboard `Enter` on a focused
 * anchor already dispatches a `click`, which this handler cancels, and a
 * middle click dispatches none — that case is covered by the absence of
 * `target` (wry denies the new-window request by default) plus the navigation
 * guard. The cwd comes from the context, so a relative path resolves against
 * the active **Session**'s **Space** without any surface threading it. */
export default function OpenAnchor({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children?: ReactNode;
}) {
  const cwd = useSpaceCwd();
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        // `externalOpen` never rejects — it swallows the refusal into
        // `console.warn` — so a click handler needs no `catch`.
        void externalOpen(href, cwd);
      }}
    >
      {children}
    </a>
  );
}
