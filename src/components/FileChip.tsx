import { basenameOfPath } from "../lib/paths";
import { fileIconFor } from "../lib/fileIcons";

const CHIP_CLASSES =
  "inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle";

/**
 * A file chip: a 16px language icon + the basename (`title` = the full path).
 *
 * It is interactive ONLY where the caller passes `onOpen` — then the SAME
 * icon + name markup sits inside a `<button>` (a `<button>`, not an `<a>`,
 * because the target is a FILE and the click is an **External open** of the
 * path — an anchor would advertise a URL it does not have).
 *
 * Exactly ONE of the five call sites does: the `ToolCallCard`'s EXPANDED-BODY
 * file row (`ToolCallCard.tsx:123`). The other four render INSIDE a toggle
 * `<button>` — `ToolCallCardHeader.tsx:99` (inside the button opened at `:82`)
 * and `ChangesGroupCard.tsx:211`/`:229`/`:234` (inside the button opened at
 * `:168`) — where a nested `<button>` would be invalid HTML whose click also
 * toggles the card. So the DEFAULT stays the inert `<span>`, byte-identical to
 * before, which additionally keeps `ChangesGroupCard`'s responsive chip-width
 * measurement (it measures the chip wrappers) untouched.
 */
export default function FileChip({
  path,
  onOpen,
}: {
  path: string;
  onOpen?: () => void;
}) {
  const spec = fileIconFor(path);
  const name = basenameOfPath(path) || path;
  const Icon = spec.icon;
  // Shared so both shapes carry identical inner markup — the inert shape is
  // what the four button-nested call sites render.
  const glyph = (
    <>
      <Icon className={`size-4 shrink-0 ${spec.className}`} />
      <span className="min-w-0 truncate">{name}</span>
    </>
  );
  if (onOpen) {
    // `text-left` is not decoration: a `<button>` takes the UA stylesheet's
    // centred `text-align` (Tailwind's preflight does not reset it), which
    // would shift a truncated basename relative to the inert `<span>`.
    return (
      <button
        type="button"
        onClick={onOpen}
        title={path}
        className={`${CHIP_CLASSES} cursor-pointer hover:text-foreground text-left`}
      >
        {glyph}
      </button>
    );
  }
  return (
    <span className={CHIP_CLASSES} title={path}>
      {glyph}
    </span>
  );
}
