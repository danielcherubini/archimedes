import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { getAppInfo } from "@/lib/version";
import {
  checkUpdate,
  installUpdate,
  listenUpdateProgress,
  relaunchApp,
  type UpdateProgress,
} from "@/lib/update";
import { describeIpcError } from "@/lib/ipcError";
import { Button } from "@/components/ui/button";
import { IpcErrorLine } from "@/components/IpcErrorLine";
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

/**
 * ───────────────────────────── the updater store ─────────────────────────────
 *
 * The phase lives HERE, at module scope, and NOT in the component's state —
 * because the work it describes outlives the component. `UpdateSection` is one
 * arm of the Settings page: clicking a different nav item UNMOUNTS it, while the
 * Rust `install_update` keeps downloading in the background. Held in `useState`,
 * that meant a user who navigated away mid-install came back to a section that
 * had forgotten everything — the "…restart to finish" line gone (so the update
 * looked like it had done nothing), and worse, a brand-new `useRef` guard, so a
 * second Install click started a SECOND concurrent download into the same
 * package state. The process-level truth needs a process-level holder, and a
 * module-level singleton is the smallest one that is not a state library.
 *
 * The shape is deliberately the bare React external-store triad: a mutable
 * `phase`, a `Set` of listeners, and `subscribe`/`get` for
 * `useSyncExternalStore` (already the idiom of `lib/sidePaneState.ts` +
 * `SidePane.tsx` in this repo — same shared-flag pattern, same reason). The two
 * `…InFlight` booleans are the old `checkingRef`/`installingRef` guards moved
 * beside the state they protect: a guard that dies with the component guards
 * nothing, and these are the front door to the Rust `InstallClaim`, which
 * refuses a second install with `"install-in-progress"` regardless.
 *
 * One consequence worth naming: writes here are safe WHILE UNMOUNTED. The
 * install closure keeps calling `setPhase` after its component is gone, and
 * notifying an empty listener set is the no-op it should be — the alternative
 * (unmount cancels the bookkeeping) is precisely the bug being fixed.
 */
const IDLE: Phase = { kind: "idle" };

let phase: Phase = IDLE;
let checkInFlight = false;
let installInFlight = false;
const listeners = new Set<() => void>();

/** Reads the current phase (the `useSyncExternalStore` snapshot). */
function getPhase(): Phase {
  return phase;
}

/** Subscribes to phase changes; the returned fn is the unsubscribe. */
function subscribePhase(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Writes the phase and notifies — the only writer in this module. */
function setPhase(next: Phase | ((current: Phase) => Phase)): void {
  phase = typeof next === "function" ? next(phase) : next;
  // A copy: a listener that unsubscribes during the fan-out must not skip a
  // sibling, and `Set` iteration is live.
  for (const listener of [...listeners]) listener();
}

/**
 * Back to `idle` with no in-flight guards.
 *
 * NO production caller — a real process gets a fresh module on every launch,
 * which is exactly what this emulates. The test suite needs it because the
 * module now holds state across `render()`/`cleanup()` pairs: without it, the
 * case that leaves a never-settling install in flight would leak `installing`
 * into every later case in this file.
 */
export function resetUpdaterSectionState(): void {
  phase = IDLE;
  checkInFlight = false;
  installInFlight = false;
  listeners.clear();
}

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
 *
 * This component is a PROJECTION of the store, with no updater state of its own:
 * a remount reads whatever the install in the background has reached, so
 * navigating away and back shows the same phase it showed before (see the store
 * note above). The only local state is the version string, which is a per-mount
 * read of our own binary and is genuinely nothing to remember.
 */
export default function UpdateSection(): ReactElement {
  // The version row's only source (`getAppInfo` — the same read the rest of
  // the settings use; there is no second version string in the UI).
  const [version, setVersion] = useState<string | null>(null);
  const phase = useSyncExternalStore(subscribePhase, getPhase);

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
    // The old `checkingRef` guard, moved into the store so it survives a remount
    // (behaviour unchanged: the flag flips BEFORE the first `await`, so two
    // synchronous clicks — or two mounts — start exactly one invoke).
    if (checkInFlight) return;
    checkInFlight = true;
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
      setPhase({ kind: "checkFailed", error: describeIpcError(error) });
    } finally {
      checkInFlight = false;
    }
  };

  const install = async (available: string, notes: string | null): Promise<void> => {
    if (installInFlight) return;
    installInFlight = true;
    // PAINT FIRST. On Windows the `await` below never returns — the installer
    // starts and the process exits inside the Rust command — so this is the
    // LAST state the user will ever see on that platform. Announcing after the
    // await would mean announcing nothing.
    setPhase({ kind: "installing", version: available, progress: null });
    let unlisten: (() => void) | null = null;
    try {
      // Subscribe before downloading, so the first chunk has somewhere to land.
      // The subscription belongs to THIS closure, not to the mounted component:
      // a remount does not subscribe again (that would double the fan-out), it
      // just reads what this callback keeps writing.
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
      setPhase({
        kind: "available",
        version: available,
        notes,
        error: describeIpcError(error),
      });
    } finally {
      installInFlight = false;
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
            <IpcErrorLine
              error={`Installing the update failed: ${phase.error}`}
              className="text-ui-base"
            />
          ) : null}
        </div>
      );
    case "checkFailed":
      // The conflation the type exists to prevent, made visible: "I could not
      // ask" is never worded like "it said no".
      return (
        <IpcErrorLine
          error={`Could not reach the update server: ${phase.error}`}
          className="text-ui-base"
        />
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
