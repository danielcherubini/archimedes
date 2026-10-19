import { X } from "lucide-react";
import type { ChatComposerAttachment } from "../../lib/chatAttachments";

/**
 * The composer's staged-image thumbnail strip.
 *
 * Props-only: the `attachments` state + the object-URL lifecycle (staging,
 * release-on-remove, release-on-session-switch, release-on-unmount) all stay
 * in `ChatStream` — they coordinate with `send()` and the session-switch
 * effect. Extracted verbatim from `ChatStream` (identical DOM); renders
 * nothing while nothing is staged.
 */
export default function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: ChatComposerAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <>
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((att, index) => (
            <div
              key={att.id}
              className="group relative size-12 overflow-hidden rounded-lg border border-input-border bg-input"
            >
              <img
                src={att.objectUrl}
                alt={att.filename}
                className="size-full object-cover"
              />
              {/* The `[image #N]` the draft uses for this picture (1-based, in
                  staging order), so the number in the text is checkable against
                  the image it names. Decoration beside the thumbnail, so
                  `aria-hidden`: a screen reader already gets the file name from
                  the `img`, and a bare `#1` in the accessible name would be
                  noise. */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-input/90 px-1 text-ui-xs leading-tight text-foreground-subtle"
              >
                {`#${index + 1}`}
              </span>
              <button
                type="button"
                aria-label="Remove image attachment"
                onClick={() => onRemove(att.id)}
                className="absolute right-0.5 top-0.5 size-4 rounded-full bg-input p-0 opacity-0 transition-opacity group-hover:opacity-100"
              >
                <X className="size-3 text-foreground" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
