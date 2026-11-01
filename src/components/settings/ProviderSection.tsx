import { useState } from "react";
import type { ReactElement } from "react";
import { EyeIcon, EyeOffIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import type {
  AppSettings,
  KnownProvider,
  ModelDto,
  ProviderAuthMode,
  ProviderBudgetRowDto,
  ProviderConfig,
  WireApi,
} from "@/lib/tauri";
import { externalOpen } from "@/lib/tauri";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingsBadge,
  SettingsDataRow,
  SettingsGroupCard,
  closedSelectValue,
} from "./primitives";
import { Field, TextField } from "./controls";
import ProviderAuthSection from "./ProviderAuthSection";

/** The Providers section's props (every piece of state stays in `SettingsPage`). */
interface ProviderSectionProps {
  settings: AppSettings | null;
  models: ModelDto[];
  /** The known-providers catalog (ADR 0024; `[]` = not loaded / failed). */
  knownProviders: KnownProvider[];
  /** The picker's selected template id (`""` = nothing selected). */
  selectedKnown: string;
  onSelectKnown: (id: string) => void;
  /** A provider field commit (immediate save + re-run its discovery). */
  onCommitField: (index: number, patch: Partial<ProviderConfig>) => void;
  /**
   * The spend/budget rows by PROVIDER id (the LiteLLM suite, #132). The page
   * fetches the whole ledger in ONE bulk `getProviderBudget()` at mount and maps
   * it by `providerId`; a missing entry means not fetched / fetch failed / no
   * rows, and the row renders NOTHING (never `$0.00`).
   */
  budgets: Record<string, ProviderBudgetRowDto[] | undefined>;
  onRefresh: (id: string) => Promise<void>;
  onRemove: (id: string) => void;
  onAdd: (template?: {
    name?: string;
    baseUrl?: string;
    api?: WireApi;
    keyUrl?: string;
  }) => void;
}
/** The endpoint APIs a provider row can speak (ADR 0024 + 0026: the wire the harness speaks, or a discovery mode — `litellm` routes discovery to `GET /model/info` on the openai-completions wire). */
const API_VALUES: WireApi[] = [
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
  "litellm",
];

/** The api's human label (the provider row's `api` select + the picker's option labels). */
const API_LABELS: Record<WireApi, string> = {
  "anthropic-messages": "Anthropic",
  "openai-responses": "OpenAI Responses",
  litellm: "LiteLLM",
  "openai-completions": "OpenAI-compatible",
};

function apiLabel(api: WireApi): string {
  return API_LABELS[api];
}

/**
 * The auth modes the provider row offers (the LiteLLM suite, #125–#132). The
 * CLOSED vocabulary of `ProviderAuthMode` — the Rust field is a `String` with a
 * serde default and validates at USE, so an unreadable stored value renders the
 * default through `closedSelectValue` and is never written back.
 */
const AUTH_MODE_VALUES: ProviderAuthMode[] = [
  "api_key",
  "oauth",
  "oidc",
  "gcloud_adc",
];

/**
 * The mode's human label (the auth-mode select's item text).
 *
 * `api_key` reads "API key (default)" rather than the bare "API key" for a
 * reason that is load-bearing, not cosmetic: Radix renders the SELECTED item's
 * text inside the trigger, and the row already carries an "API key" field label
 * (the key `TextField`). A bare label would give the Providers section two
 * elements reading "API key" and break `getByText("API key")` — the pin in
 * `SettingsPage.test.tsx` that proves the key field is visible, not clipped. The
 * suffix also says something true: it is the mode a pre-feature file parses to.
 */
const AUTH_MODE_LABELS: Record<ProviderAuthMode, string> = {
  api_key: "API key (default)",
  oauth: "OAuth",
  oidc: "OIDC",
  gcloud_adc: "Google ADC",
};
/**
 * One provider row: a labeled field grid (Name / Base URL / API key
 * (masked, an eye toggle) / the discovery status + a refresh + a remove;
 * a third row: the wire `api` select + the `authMode` select) — the
 * `SettingsRow`'s label+control shape can't host three text fields (they
 * overflow the fixed 280px control column and get clipped by the card's
 * `overflow-hidden`), so the row is a full-width `border-t` block (the
 * `SettingsRow`'s `px-4 py-3` / `first:border-t-0` pattern).
 *
 * The grid's last child is the full-width `ProviderAuthSection` (the sign-in /
 * device-flow / paste-token / headers / insecure-HTTP / oidc / spend surface) —
 * a grid child with `sm:col-span-2`, NOT a row, so the `.border-t` count the
 * page's tests locate rows by stays exactly one per provider.
 */
function ProviderRow({
  provider,
  modelCount,
  budget,
  onCommitField,
  onRefresh,
  onRemove,
}: {
  provider: ProviderConfig;
  modelCount: number;
  /** THIS provider's budget rows (`undefined` = none / not fetched — renders nothing). */
  budget: ProviderBudgetRowDto[] | undefined;
  onCommitField: (patch: Partial<ProviderConfig>) => void;
  onRefresh: () => Promise<void>;
  onRemove: () => void;
}): ReactElement {
  const [showKey, setShowKey] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  // The discovery status: `{n} models` when the provider's models are
  // present in the catalog, `unreachable` when it has 0, `checking…`
  // while a refresh is in flight.
  const status = refreshing
    ? "checking…"
    : modelCount > 0
      ? `${modelCount} models`
      : "unreachable";
  return (
    <SettingsDataRow>
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        <Field label="Name">
          <TextField
            value={provider.name}
            placeholder="Provider name"
            ariaLabel="Provider name"
            className="w-full"
            onCommit={(name) => onCommitField({ name })}
          />
        </Field>
        <Field label="Base URL">
          <TextField
            value={provider.baseUrl}
            placeholder="https://example.com/v1"
            ariaLabel="Base URL"
            className="w-full"
            onCommit={(baseUrl) => onCommitField({ baseUrl })}
          />
        </Field>
        <Field label="API key">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <TextField
                value={provider.apiKey}
                placeholder="No key (local gateway)"
                ariaLabel="API key"
                type={showKey ? "text" : "password"}
                className="w-full pr-8"
                onCommit={(apiKey) => onCommitField({ apiKey })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={showKey ? "Hide API key" : "Show API key"}
                className="absolute top-1/2 right-1.5 -translate-y-1/2"
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
              </Button>
            </div>
            {provider.keyUrl ? (
              // An External open (ADR 0051), NOT a `_blank` target: this app
              // installs no `on_new_window` handler, so wry denies the
              // new-window request and the link is a dead control. No cwd is
              // passed — a `keyUrl` is always absolute (the known-provider
              // catalog stores absolute base URLs).
              <a
                href={provider.keyUrl}
                className="text-ui-base text-foreground-subtle hover:underline"
                onClick={(e) => {
                  e.preventDefault();
                  void externalOpen(provider.keyUrl!);
                }}
              >
                Get key
              </a>
            ) : null}
          </div>
        </Field>
        <Field label="API">
          <Select
            // A stored `api` outside the wire list (a hand-edited file) leaves
            // BOTH consumers on the OpenAI-compatible wire — `WireApi::parse`
            // falls back to it for discovery and for `build_provider` — so that
            // is the label the trigger shows instead of going blank (Radix
            // renders no label for a value with no matching item). Nothing is
            // re-saved for being unreadable.
            value={closedSelectValue(provider.api, API_VALUES, "openai-completions")}
            onValueChange={(value) => onCommitField({ api: value as WireApi })}
          >
            <SelectTrigger aria-label="API" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {API_VALUES.map((api) => (
                <SelectItem key={api} value={api}>
                  {apiLabel(api)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex items-center justify-end gap-2">
          <SettingsBadge>{status}</SettingsBadge>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh models"
            onClick={() => void refresh()}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove provider"
              >
                <TrashIcon className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Remove provider {provider.name || "Untitled"}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Its {modelCount} models will no longer be selectable.
                  Existing sessions are unaffected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={onRemove}>Remove</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <Field label="Auth mode">
          {/* The auth mode the LiteLLM suite reads at resolve time (#125). A
              stored value outside the list (a hand-edited file) renders the
              default — the Rust side is a `String` with a serde default and
              validates at USE, so nothing here may write a "correction". */}
          <Select
            value={closedSelectValue(
              provider.authMode,
              AUTH_MODE_VALUES,
              "api_key",
            )}
            onValueChange={(value) =>
              onCommitField({ authMode: value as ProviderAuthMode })
            }
          >
            <SelectTrigger aria-label="Auth mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTH_MODE_VALUES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {AUTH_MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {/* The per-provider auth surface (sign-in / device flow / paste token /
            headers / insecure-HTTP / oidc / the spend line). It is a GRID CHILD,
            not a row: the `sm:col-span-2` gives it the grid's full width and it
            carries NO `border-t` — the page's tests locate provider rows by
            `.border-t`, so a phantom border would break that signal. */}
        <ProviderAuthSection
          provider={provider}
          budget={budget}
          onCommitField={onCommitField}
          className="sm:col-span-2"
        />
      </div>
    </SettingsDataRow>
  );
}

/** The Providers section: the provider rows + the known-providers picker. */
export default function ProviderSection({
  settings,
  models,
  knownProviders,
  selectedKnown,
  onSelectKnown,
  onCommitField,
  budgets,
  onRefresh,
  onRemove,
  onAdd,
}: ProviderSectionProps): ReactElement | null {
  if (settings === null) return null;
  return (
    <div className="space-y-3">
      <SettingsGroupCard>
        {settings.providers.length === 0 ? (
          <div className="px-4 py-3 text-ui-base text-foreground-subtle">
            No providers yet — add one to connect a model provider.
          </div>
        ) : (
          settings.providers.map((provider, index) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              modelCount={models.filter((m) => m.provider === provider.id).length}
              budget={budgets[provider.id]}
              onCommitField={(patch) => onCommitField(index, patch)}
              onRefresh={() => onRefresh(provider.id)}
              onRemove={() => onRemove(provider.id)}
            />
          ))
        )}
      </SettingsGroupCard>
      <div className="flex items-center gap-2">
        {/* (ADR 0024) The known-providers picker: a `Select` of the 20
            catalog templates (the label is `name — apiLabel(api)`) + an
            Add button that appends the template as a pre-filled row
            (the user's list stays the sole model source). */}
        <Select value={selectedKnown} onValueChange={onSelectKnown}>
          <SelectTrigger aria-label="Known provider" className="w-64">
            <SelectValue placeholder="Add a known provider…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="" disabled>
              Add a known provider…
            </SelectItem>
            {knownProviders.map((template) => (
              <SelectItem key={template.id} value={template.id}>
                {`${template.name} — ${apiLabel(template.api)}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={selectedKnown === ""}
          onClick={() => {
            const template = knownProviders.find(
              (t) => t.id === selectedKnown,
            );
            if (template) {
              onAdd({
                name: template.name,
                baseUrl: template.baseUrl,
                api: template.api,
                keyUrl: template.keyUrl,
              });
            }
            onSelectKnown("");
          }}
        >
          Add
        </Button>
        <Button onClick={() => onAdd()}>Add provider</Button>
      </div>
    </div>
  );
}
