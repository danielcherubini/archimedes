import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { CopyIcon, KeyIcon, XIcon } from "lucide-react";
import type {
  ProviderAuthMode,
  ProviderBudgetRowDto,
  ProviderConfig,
  ProviderLoginStep,
} from "@/lib/tauri";
import {
  externalOpen,
  providerLoginOauth,
  providerLoginOidc,
  providerLoginPasteToken,
  providerLoginSsoChooseTeam,
  providerLoginSsoPoll,
} from "@/lib/tauri";
import { describeIpcError } from "@/lib/ipcError";
import { useCopyButton } from "@/hooks/useCopyButton";
import { moneyOf } from "../SessionCostLine";
import { cn } from "@/components/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SettingsBadge } from "./primitives";
import { Field, TextField } from "./controls";

/**
 * The per-provider auth surface (T8 — the UI for issues #126 / #127 / #132).
 * Rendered as a full-grid-width child (`sm:col-span-2`) of each provider row's
 * two-column field grid, so it adds NO row and NO `border-t` element of its own
 * (`SettingsPage.test.tsx` and `primitives.test.tsx` locate rows by `.border-t`).
 *
 * It calls the T5/T6/T7 commands DIRECTLY (the `McpSection` pattern — a
 * component that owns its one-shot actions and their badge chain), while every
 * settings-document field (headers / insecure-HTTP / oidc) commits through
 * `onCommitField` into the page's immediate-save chain.
 *
 * The budget rows are DISPLAY-ONLY and come from the PAGE-level bulk fetch
 * (`SettingsPage`): this prop is THIS provider's rows, and `undefined` — not
 * fetched, fetch failed, or no rows — renders NOTHING. A missing figure is never
 * `$0.00` (that distinction is `moneyOf`'s whole reason to exist).
 */
interface ProviderAuthSectionProps {
  provider: ProviderConfig;
  /** The page-level budget ROWS for THIS provider (`undefined` = none / not fetched — renders nothing). */
  budget: ProviderBudgetRowDto[] | undefined;
  onCommitField: (patch: Partial<ProviderConfig>) => void;
  /** Always `sm:col-span-2` from the row — the section spans the grid's full width. */
  className?: string;
}

/** that have a sign-in affordance. A `gcloud_adc` row authenticates
 * from the ADC file and an `api_key` row uses its key field — neither signs in. */
const SIGN_IN_MODES: ProviderAuthMode[] = ["oauth", "oidc"];

/**
 * The device-flow poll cadence. The SAME 2 s the Rust side pins
 * (`cli_sso::SSO_POLL_INTERVAL = Duration::from_secs(2)`) — the timer lives here
 * because T5's command is one-shot: the UI drives the loop.
 */
const SSO_POLL_MS = 2000;

/**
 * The poll's TERMINAL sentence. There is NO `expired` variant on the wire —
 * expiry arrives as the poll's HTTP-400 `SettingsError`, so this message is the
 * only signal that the flow is dead and the UI must stop polling.
 */
const isExpiredSentence = (message: string): boolean =>
  message.includes("HTTP 400") || message.toLowerCase().includes("expired");

/** The header map → the editor's `KEY=VALUE` lines.
 *
 * A LOCAL copy of `McpSection`'s module-private `mapToLines` (`McpSection.tsx`,
 * the `McpDialog` draft) — that file is outside this task's owned set and
 * extracting a 4-line helper across it would move a non-owned file for no gain,
 * so the sibling implementations are cross-referenced instead. Keep the two in
 * step if either changes. */
function headersMapToLines(map: Record<string, string> | undefined): string {
  return map
    ? Object.entries(map)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")
    : "";
}

/** The editor's `KEY=VALUE` lines → the header map (`undefined` when empty —
 * the empty editor is the ABSENCE of headers, not `{}`; a line without a `=` is
 * skipped: the editor is best-effort, not a linter). The local sibling of
 * `McpSection`'s `linesToMap`, same cross-reference as above. */
function headersLinesToMap(lines: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of lines.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The stored port list → the comma-joined draft (absent → the empty editor,
 * which commits as `[]` = ONE ephemeral callback port). */
function portsToDraft(ports: number[] | undefined): string {
  return (ports ?? []).join(", ");
}

/** The comma-joined draft → the port list. Non-numeric entries are dropped; the
 * empty editor is the EMPTY list (the T6 spec's "or ephemeral port if empty"). */
function draftToPorts(draft: string): number[] {
  return draft
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map(Number)
    .filter(Number.isFinite);
}

export default function ProviderAuthSection({
  provider,
  budget,
  onCommitField,
  className,
}: ProviderAuthSectionProps): ReactElement {
  // --- The sign-in machine (the `McpRow` runAuth shape: in-flight + result) ---
  const [authenticating, setAuthenticating] = useState(false);
  const [flow, setFlow] = useState<ProviderLoginStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The expired-flow terminal (the poll's HTTP-400 sentence, in the badge title). */
  const [expired, setExpired] = useState<string | null>(null);
  /** The team-choice panel's local pick (`""` = nothing chosen yet). */
  const [chosenTeam, setChosenTeam] = useState("");
  const [choosing, setChoosing] = useState(false);

  // --- The paste-token fallback (a CREDENTIAL — never the settings document) ---
  const [token, setToken] = useState("");
  const [pasting, setPasting] = useState(false);
  const [pasteSaved, setPasteSaved] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  // --- The headers editor's local draft (`KEY=VALUE` lines) ---
  const [headersDraft, setHeadersDraft] = useState(() =>
    headersMapToLines(provider.headers),
  );

  const savedHeaders = headersMapToLines(provider.headers);
  useEffect(() => setHeadersDraft(savedHeaders), [savedHeaders]);

  // The oidc text fields hold their own drafts (`TextField`), so they need no
  // state here; the ports field is the one exception (a joined list, below).
  const [portsDraft, setPortsDraft] = useState(() =>
    portsToDraft(provider.oidc?.redirectPorts),
  );
  const savedPorts = portsToDraft(provider.oidc?.redirectPorts);
  useEffect(() => setPortsDraft(savedPorts), [savedPorts]);

  const showSignIn =
    provider.authMode !== undefined && SIGN_IN_MODES.includes(provider.authMode);
  const devicePending = flow?.status === "devicePending";

  /**
   * Start the login. `oauth` runs the OAuth 2.1 PKCE flow (falling back to the
   * legacy CLI-SSO device flow, which is the only case that returns
   * `devicePending`); `oidc` runs the direct OIDC PKCE flow against the row's
   * `oidc` block VERBATIM — the exact values the user is looking at.
   *
   * Both BLOCK until the browser callback completes (up to 10 minutes — the
   * `authMcpServer` shape), which is what the "signing in…" badge covers.
   */
  const runAuth = async (): Promise<void> => {
    if (authenticating || devicePending) return;
    setAuthenticating(true);
    setError(null);
    setExpired(null);
    setFlow(null);
    setChosenTeam("");
    try {
      const step =
        provider.authMode === "oidc"
          ? await providerLoginOidc(provider.id, provider.oidc ?? { issuer: "" })
          : await providerLoginOauth(provider.id, provider.baseUrl);
      // `provider_login_oidc` answers the "{providerId}: authenticated" STRING,
      // not the step DTO — the authenticated state is mapped client-side.
      if (typeof step === "string") {
        setFlow({ status: "authenticated" });
      } else {
        setFlow(step);
      }
    } catch (e) {
      setError(describeIpcError(e));
    } finally {
      setAuthenticating(false);
    }
  };

  /**
   * The device-flow poll loop, keyed on the pending step's identity: an interval
   * every 2 s until the step changes. Any non-`devicePending` step (or any
   * rejection) ends the loop — a rejection is TERMINAL because the wire has no
   * `expired` variant, so the HTTP-400 sentence is the only expiry signal.
   *
   * The interval needs no ref: the flow state IS this effect's key, so Cancel
   * (clearing the flow) and unmount both run the cleanup, which clears the
   * interval and sets `disposed` so an in-flight response can never `setState` on
   * a dead tree (jsdom unmounts mid-poll; a leaked interval is also a cross-file
   * hazard in this file-order-sensitive suite).
   */
  useEffect(() => {
    if (flow?.status !== "devicePending") return;
    const { loginId, pollSecret } = flow;
    let disposed = false;
    const tick = async (): Promise<void> => {
      try {
        const step = await providerLoginSsoPoll(
          provider.id,
          loginId,
          pollSecret,
          provider.baseUrl,
        );
        if (disposed) return;
        // Still pending: keep the interval running, nothing to render.
        if (step.status === "devicePending") return;
        setFlow(step);
      } catch (e) {
        if (disposed) return;
        const message = describeIpcError(e);
        setFlow(null);
        if (isExpiredSentence(message)) setExpired(message);
        else setError(message);
      }
    };
    const handle = window.setInterval(() => void tick(), SSO_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(handle);
    };
  }, [flow, provider.id, provider.baseUrl]);

  /** The team choice: ONE re-poll with `?team_id=<id>` (the verified wire). */
  const runChooseTeam = async (): Promise<void> => {
    if (flow?.status !== "chooseTeam" || chosenTeam === "" || choosing) return;
    setChoosing(true);
    setError(null);
    try {
      const step = await providerLoginSsoChooseTeam(
        provider.id,
        flow.loginId,
        flow.pollSecret,
        provider.baseUrl,
        chosenTeam,
      );
      setFlow(step);
      setChosenTeam("");
    } catch (e) {
      setError(describeIpcError(e));
    } finally {
      setChoosing(false);
    }
  };

  /** T5's pasted-token fallback (mint a virtual key; the backend degrades to
   * storing the pasted token on ANY mint failure). */
  const runPasteToken = async (): Promise<void> => {
    if (pasting || token === "") return;
    setPasting(true);
    setPasteError(null);
    setPasteSaved(false);
    try {
      await providerLoginPasteToken(provider.id, provider.baseUrl, token, true);
      // The draft is a credential: a successful save clears the field, and it
      // NEVER enters `onCommitField` (the settings document stays untouched).
      setToken("");
      setPasteSaved(true);
    } catch (e) {
      setPasteError(describeIpcError(e));
    } finally {
      setPasting(false);
    }
  };

  const commitHeaders = (): void => {
    if (headersDraft === savedHeaders) return;
    onCommitField({ headers: headersLinesToMap(headersDraft) });
  };

  const deviceCode = flow?.status === "devicePending" ? flow.userCode : null;
  const { copied, copy } = useCopyButton(deviceCode);

  /** The primary spend/max line — the KEY hop of the ledger (the `user`/`team`
   * rows are the multi-hop detail, not the row's display). `null` = nothing to
   * show, and NOTHING renders: a missing figure is never `$0.00`. */
  const keyRow = budget?.find((row) => row.level === "key");
  const spend = keyRow?.spend ?? null;
  const maxBudget = keyRow?.maxBudget ?? null;
  const budgetLine =
    keyRow !== undefined && (spend !== null || maxBudget !== null)
      ? `${moneyOf(spend) ?? "—"} / ${moneyOf(maxBudget) ?? "unlimited"}`
      : null;

  return (
    <div className={cn("space-y-3", className)}>
      {showSignIn ? (
        <div className="flex flex-wrap items-center gap-2">
          {authenticating ? (
            <SettingsBadge>signing in…</SettingsBadge>
          ) : error !== null ? (
            <SettingsBadge title={error}>error</SettingsBadge>
          ) : expired !== null ? (
            <SettingsBadge title={expired}>flow expired</SettingsBadge>
          ) : flow?.status === "authenticated" ? (
            <SettingsBadge>authenticated</SettingsBadge>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Sign in ${provider.name || "provider"}`}
            title="Sign in"
            disabled={authenticating || devicePending}
            onClick={() => void runAuth()}
          >
            <KeyIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}

      {flow?.status === "devicePending" ? (
        // The legacy CLI-SSO device flow (the only `devicePending` producer).
        // Inline in the row — no dialog, no new row, no `border-t`.
        <div className="space-y-2">
          <Field label="Enter this code at">
            <div className="text-ui-sm text-foreground-subtle">
              {"Sign in on the page your browser opened, or "}
              {/* An External open (ADR 0051), NEVER a `_blank` target — the same
                  policy as the row's "Get key" link: this app installs no
                  `on_new_window` handler, so wry denies a new window. */}
              <a
                href={flow.verificationUrl}
                className="text-foreground underline hover:opacity-80"
                onClick={(event) => {
                  event.preventDefault();
                  void externalOpen(flow.verificationUrl);
                }}
              >
                open it again
              </a>
              {": then enter this code."}
            </div>
          </Field>
          <div className="flex items-center gap-2">
            {/* The code is meant to be transcribed, so it is selectable and
                read-only (the codebase's first `readOnly` use, following the
                `McpDialog` `Field` + plain `Input` shape). */}
            <Input
              value={flow.userCode}
              readOnly
              aria-label="Device code"
              className="w-48 font-mono"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Copy device code"
              title={copied ? "Copied" : "Copy device code"}
              onClick={copy}
            >
              <CopyIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Cancel sign-in"
              title="Cancel"
              onClick={() => {
                // Clearing the flow runs the poll effect's cleanup (which clears
                // the interval) — the loop has no other owner.
                setFlow(null);
                setChosenTeam("");
              }}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      ) : null}

      {flow?.status === "chooseTeam" ? (
        // The `chooseTeam` step (CLI-SSO only — a PKCE login never returns it).
        <div className="space-y-2">
          <Field label="Choose a team">
            <Select value={chosenTeam} onValueChange={setChosenTeam}>
              <SelectTrigger aria-label="Choose a team" className="w-full">
                <SelectValue placeholder="Select a team…" />
              </SelectTrigger>
              <SelectContent>
                {flow.teams.map((team) => (
                  <SelectItem key={team.teamId} value={team.teamId}>
                    {team.teamAlias === "" ? team.teamId : team.teamAlias}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={chosenTeam === "" || choosing}
              onClick={() => void runChooseTeam()}
            >
              Continue
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Cancel sign-in"
              onClick={() => {
                setFlow(null);
                setChosenTeam("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {showSignIn ? (
        // The paste-token fallback: for a machine with no browser, or an IdP the
        // loopback callback cannot reach. The token is a CREDENTIAL — it lives in
        // T1's `provider-auth.json` store (owned by T5's command), never in the
        // settings document, so this never calls `onCommitField`.
        <div className="space-y-2">
          <Field label="Paste an SSO token">
            {/* A live `Input`, NOT a `TextField`: the Save button's click is what
                commits the draft, and a blur-only draft would still hold the empty
                string when the click lands (jsdom fires no blur on a click, and a
                real browser's blur ordering is not a thing to rely on here). */}
            <div className="flex items-center gap-2">
              <Input
                type="password"
                value={token}
                placeholder="Paste a token from /sso/key/generate"
                aria-label="SSO token"
                className="min-w-0 flex-1"
                onChange={(event) => setToken(event.currentTarget.value)}
              />
              <Button
                type="button"
                size="sm"
                disabled={pasting || token === ""}
                onClick={() => void runPasteToken()}
              >
                Save token
              </Button>
            </div>
          </Field>
          {pasting ? (
            <SettingsBadge>saving…</SettingsBadge>
          ) : pasteError !== null ? (
            <SettingsBadge title={pasteError}>error</SettingsBadge>
          ) : pasteSaved ? (
            <SettingsBadge>saved</SettingsBadge>
          ) : null}
        </div>
      ) : null}

      <Field label="Headers (one KEY=VALUE per line; $VAR and ${VAR} expand from the environment)">
        <Textarea
          value={headersDraft}
          placeholder={'Authorization=Bearer $TOKEN'}
          aria-label="Headers"
          rows={2}
          onChange={(event) => setHeadersDraft(event.currentTarget.value)}
          onBlur={commitHeaders}
        />
      </Field>

      {/* The boolean block shape is the MCP dialog's: a caption + a `Switch`.
          Loopback is ALWAYS allowed (ADR 0057) — this toggle only covers the
          non-loopback `http://` refusal. */}
      <div className="mb-1 text-ui-sm text-foreground-subtle">
        Allow insecure HTTP (loopback is always allowed)
      </div>
      <Switch
        aria-label="Allow insecure HTTP"
        checked={provider.allowInsecureHttp === true}
        onCheckedChange={(checked) =>
          onCommitField({ allowInsecureHttp: checked })
        }
      />

      {provider.authMode === "oidc" ? (
        // The OIDC block (T6). Every commit COMPOSES over the existing block —
        // two fields must not erase each other (the `WebSearchSection.updateField`
        // pattern). An empty issuer still saves: the backend validates at use.
        <div className="space-y-3">
          <Field label="Issuer">
            <TextField
              value={provider.oidc?.issuer ?? ""}
              placeholder="https://id.example.com"
              ariaLabel="OIDC issuer"
              className="w-full"
              onCommit={(issuer) =>
                onCommitField({
                  oidc: { ...(provider.oidc ?? { clientId: "" }), issuer },
                })
              }
            />
          </Field>
          <Field label="Client ID">
            <TextField
              value={provider.oidc?.clientId ?? ""}
              placeholder="the pre-registered public client id"
              ariaLabel="OIDC client ID"
              className="w-full"
              onCommit={(clientId) =>
                onCommitField({
                  oidc: { ...(provider.oidc ?? { issuer: "" }), clientId },
                })
              }
            />
          </Field>
          <Field label="Scope">
            <TextField
              value={provider.oidc?.scope ?? ""}
              placeholder="openid (openid is always requested)"
              ariaLabel="OIDC scope"
              className="w-full"
              onCommit={(scope) =>
                onCommitField({ oidc: { ...(provider.oidc ?? { issuer: "" }), scope } })
              }
            />
          </Field>
          <Field label="Redirect ports (comma-separated; empty = one ephemeral port)">
            {/* A live `Input`, NOT a `TextField`: this field's draft is SECTION
                state (a joined list needs parsing and re-syncing from the saved
                block), so the change-only rule has to read the draft the input
                actually holds. `TextField` keeps its own draft and hands the
                committed string to `onCommit` — reading the component's own state
                there would compare the PREVIOUS value and drop the first real
                edit. Same reasoning as the SSO-token input above. */}
            <Input
              value={portsDraft}
              placeholder="8420, 8421"
              aria-label="OIDC redirect ports"
              className="w-full"
              onChange={(event) => setPortsDraft(event.currentTarget.value)}
              onBlur={() => {
                if (portsDraft === savedPorts) return;
                onCommitField({
                  oidc: {
                    ...(provider.oidc ?? { issuer: "" }),
                    redirectPorts: draftToPorts(portsDraft),
                  },
                });
              }}
            />
          </Field>
        </div>
      ) : null}

      {budgetLine !== null ? (
        <Field label="Spend / max budget">
          <span className="text-ui-sm text-foreground-subtle">{budgetLine}</span>
        </Field>
      ) : null}
    </div>
  );
}
