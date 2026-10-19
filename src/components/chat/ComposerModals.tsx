import SudoConfirmModal from "../SudoConfirmModal";
import SudoPasswordModal from "../SudoPasswordModal";
import type { InteractiveRequestData } from "../../store/interactive";

/**
 * The interactive modals (the `confirm` / `password` overlays). Props-only;
 * the request lists are derived in `ChatStream` from the interactive store.
 * Extracted verbatim (identical DOM — `fixed` overlays rendered at the
 * `ChatStream` root, NOT inside the scroll region).
 */
export default function ComposerModals({
  activeSessionId,
  confirmRequests,
  passwordRequests,
}: {
  activeSessionId: string;
  confirmRequests: InteractiveRequestData[];
  passwordRequests: InteractiveRequestData[];
}) {
  return (
    <>
      {confirmRequests.map((r) => (
        <SudoConfirmModal
          key={r.requestId}
          sessionId={activeSessionId}
          requestId={r.requestId}
        />
      ))}
      {passwordRequests.map((r) => (
        <SudoPasswordModal
          key={r.requestId}
          sessionId={activeSessionId}
          requestId={r.requestId}
        />
      ))}
    </>
  );
}
