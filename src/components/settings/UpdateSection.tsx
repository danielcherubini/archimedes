import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { getAppInfo } from "@/lib/version";
import {
  checkUpdate,
  installUpdate,
  listenUpdateProgress,
  relaunchApp,
  type UpdateProgress,
} from "@/lib/update";
import { Button } from "@/components/ui/button";
import {
  SettingsBadge,
  SettingsGroupCard,
  SettingsRow,
} from "./primitives";

/**
 * The updater section's phases (ADR 0053's three-way check result, drawn).
 *
 * `checkFailed` is a SEPARATE phase from `upToDate` and must stay one: the
 * plugin swallows a non-2xx from the update endpoint into `ReleaseNotFound`
 * ("Could not fetch a valid release JSON"), so a 404 — which is exactly what a
 * repository with no published release returns — reaches here as a typed
 * rejection. Fold it into "up to date" and every installed client with a broken
 * endpoint reports itself current forever.
 *
 * `installing` is terminal on Windows: the Rust command exits the process once
 * the NSIS installer is launched, so nothing after that `await` is ever
 * observed. `downloaded` exists for the platforms that DO return (macOS/Linux),
 * where the app is still running on the OLD binary and the user has to relaunch.
 */
type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; version: string; notes: string | null; error: string | null }
  | { kind: "checkFailed"; error: string }
  | { kind: "installing"; version: string; progress: UpdateProgress | null }
  | { kind: "downloaded"; version: string }
  | { kind: "restarting" };

/** Bytes → a human size (`1.2 MB`, `806 KB`, `4096 B`). */
function bytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * The Updates section: the running version + a MANUAL check + the install
 * flow. Nothing here runs on its own — mounting the section asks the server
 * nothing (ADR 0053 keeps the trigger manual, because an update cadence that
 * ships cannot be retracted afterwards).
 */
export default function UpdateSection(): ReactElement {
  // The version row's only source (`getAppInfo` — the same read the rest of
  // the settings use; there is no second version string in the UI).
  const [version, setVersion] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // The in-flight guards are REFS, not state: a click handler closes over the
  // state of the render it was created in, so two synchronous clicks would both
  // read `idle`. The ref flips before the first `await`, which is the only
  // thing that makes "no double check" true.
  const checkingRef = useRef(false);
  const installingRef = useRef(false);

  useEffect(() => {
    // Reading our OWN version is not a network check, so it is safe on mount —
    // and a failure here just leaves the row without a number (never a lie).
    let alive = true;
    getAppInfo()
      .then((info) => {
        if (alive) setVersion(info.version);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const check = async (): Promise<void> => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setPhase({ kind: "checking" });
    try {
      const outcome = await checkUpdate();
      setPhase(
        outcome.state === "upToDate"
          ? { kind: "upToDate" }
          : {
              kind: "available",
              version: outcome.version,
              notes: outcome.notes,
              error: null,
            },
      );
    } catch (error) {
      // The typed code (`release-not-found`, `network:…`) is the diagnostic;
      // the sentence above it is the human half. Not a "you are current".
      setPhase({ kind: "checkFailed", error: String(error) });
    } finally {
      checkingRef.current = false;
    }
  };

  const install = async (available: string, notes: string | null): Promise<void> => {
    if (installingRef.current) return;
    installingRef.current = true;
    // PAINT FIRST. On Windows the `await` below never returns — the installer
    // starts and the process exits inside the Rust command — so this is the
    // LAST state the user will ever see on that platform. Announcing after the
    // await would mean announcing nothing.
    setPhase({ kind: "installing", version: available, progress: null });
    let unlisten: (() => void) | null = null;
    try {
      // Subscribe before downloading, so the first chunk has somewhere to land.
      unlisten = await listenUpdateProgress((progress) => {
        setPhase((current) =>
          current.kind === "installing" ? { ...current, progress } : current,
        );
      });
      await installUpdate();
      // Reached on macOS/Linux only (Windows exits above): the bytes are in
      // place, the app is still the OLD one, so say so with a button.
      setPhase({ kind: "downloaded", version: available });
    } catch (error) {
      // A Linux deb/pkexec failure can land here AFTER a complete download.
      // Back to `available` with the reason — retryable, and deliberately not
      // the check-failed sentence (the server was reachable).
      setPhase({ kind: "available", version: available, notes, error: String(error) });
    } finally {
      installingRef.current = false;
      unlisten?.();
    }
  };

  const restart = (): void => {
    setPhase({ kind: "restarting" });
    // One paint beat before the call: `relaunch_app` never returns
    // (`AppHandle::restart()` is `-> !`), so a synchronous call would take the
    // process down before this state reaches the screen.
    window.setTimeout(() => {
      void relaunchApp();
    }, 300);
  };

  return (
    <SettingsGroupCard>
      <SettingsRow
        label="Version"
        description="The build you are running."
        control={<SettingsBadge>{version ?? "unknown"}</SettingsBadge>}
      />
      <SettingsRow
        label="Updates"
        description="Archimedes looks for updates only when you click — nothing is checked on launch and nothing is downloaded without a click."
        detail={<UpdateStatus phase={phase} />}
        control={
          <UpdateControl
            phase={phase}
            onCheck={() => {
              void check();
            }}
            onInstall={(available, notes) => {
              void install(available, notes);
            }}
            onRestart={restart}
          />
        }
      />
      {phase.kind === "installing" ? <UpdateProgressRow phase={phase} /> : null}
    </SettingsGroupCard>
  );
}

/** The status line under the control — one place, so the up-to-date and
 * could-not-check sentences cannot be rendered at the same time. */
function UpdateStatus({ phase }: { phase: Phase }): ReactElement | null {
  switch (phase.kind) {
    case "upToDate":
      return <p className="text-ui-base text-foreground-subtle">You are up to date.</p>;
    case "available":
      return (
        <div className="space-y-1">
          <p className="text-ui-base text-foreground">
            Version {phase.version} is available.
          </p>
          {phase.notes ? (
            <p className="whitespace-pre-line text-ui-base text-foreground-subtle">
              {phase.notes}
            </p>
          ) : null}
          {phase.error ? (
            // Distinct from a failed CHECK: the endpoint answered, the install
            // is what broke (a deb transaction, a signature, a full disk).
            <p className="text-ui-base text-destructive">
              Installing the update failed: {phase.error}
            </p>
          ) : null}
        </div>
      );
    case "checkFailed":
      // The conflation the type exists to prevent, made visible: "I could not
      // ask" is never worded like "it said no".
      return (
        <p className="text-ui-base text-destructive">
          Could not reach the update server: {phase.error}
        </p>
      );
    case "downloaded":
      return (
        <p className="text-ui-base text-foreground-subtle">
          Version {phase.version} is installed — restart to finish.
        </p>
      );
    case "restarting":
      return (
        <p className="text-ui-base text-foreground-subtle">
          Restarting — the window is closing.
        </p>
      );
    default:
      return null;
  }
}

/** The action button (and the announced install state, which is the LAST thing
 * Windows users ever read). */
function UpdateControl({
  phase,
  onCheck,
  onInstall,
  onRestart,
}: {
  phase: Phase;
  onCheck: () => void;
  onInstall: (version: string, notes: string | null) => void;
  onRestart: () => void;
}): ReactElement {
  switch (phase.kind) {
    case "checking":
      return (
        <Button type="button" variant="outline" disabled>
          Checking…
        </Button>
      );
    case "available":
      return (
        <Button
          type="button"
          onClick={() => {
            onInstall(phase.version, phase.notes);
          }}
        >
          Install update
        </Button>
      );
    case "installing":
      // The Windows terminal state, and it has to be right on its own: the
      // process dies mid-install there, so this line IS the outcome message.
      return (
        <Button type="button" variant="outline" disabled>
          Installing…
        </Button>
      );
    case "downloaded":
      return (
        <Button type="button" onClick={onRestart}>
          Restart to finish
        </Button>
      );
    case "restarting":
      return (
        <Button type="button" variant="outline" disabled>
          Restarting…
        </Button>
      );
    default:
      return (
        <Button type="button" variant="outline" onClick={onCheck}>
          Check for updates
        </Button>
      );
  }
}

/** The download progress row (rendered only while installing). */
function UpdateProgressRow({
  phase,
}: {
  phase: Extract<Phase, { kind: "installing" }>;
}): ReactElement {
  // The copy that must PAINT before the await: on Windows the installer takes
  // the window with it, so this sentence is the whole success message there.
  const announced = "Installing — this window will close when the installer starts.";

  if (phase.progress === null) {
    return <p className="px-4 py-3 text-ui-base text-foreground-subtle">{announced}</p>;
  }

  const { downloaded, total } = phase.progress;
  // No `Content-Length` (a chunked or gzipped response) means no denominator:
  // an indeterminate bar plus a byte count, NEVER a `NaN%`.
  const percent = total && total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : null;

  return (
    <div className="border-t border-border px-4 py-3">
      <p className="text-ui-base text-foreground-subtle">{announced}</p>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface"
        role="progressbar"
        aria-valuemin={percent === null ? undefined : 0}
        aria-valuemax={percent === null ? undefined : 100}
        aria-valuenow={percent ?? undefined}
      >
        {/* No denominator → a pulsing full-width track: it says "moving, size
            unknown", which a 0%-width bar would not. */}
        <div
          className={
            percent === null
              ? "h-full w-full animate-pulse bg-primary opacity-60"
              : "h-full bg-primary"
          }
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p className="mt-1 text-ui-base text-foreground-subtle">
        {percent === null
          ? `${bytes(downloaded)} downloaded`
          : `${percent}% of ${bytes(total as number)}`}
      </p>
    </div>
  );
}
