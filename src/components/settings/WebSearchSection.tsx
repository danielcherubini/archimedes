import { useState } from "react";
import type { ReactElement } from "react";
import { EyeIcon, EyeOffIcon, PlayIcon } from "lucide-react";
import {
  testSearchProvider,
  type AppSettings,
  type WebSettings,
} from "@/lib/tauri";
import { describeIpcError } from "@/lib/ipcError";
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
  SettingsGroupCard,
  SettingsRow,
  closedSelectValue,
} from "./primitives";
import { TextField } from "./controls";

export interface WebSearchSectionProps {
  settings: AppSettings | null;
  onSave: (patch: Partial<AppSettings>) => void;
}

interface TestResultState {
  testing: boolean;
  result: { hits: number } | { error: string } | null;
}

function KeyedProviderRow({
  provider,
  label,
  description,
  apiKey,
  inputLabel,
  placeholder,
  settings,
  onCommit,
}: {
  provider: string;
  label: string;
  description: string;
  apiKey: string;
  inputLabel: string;
  placeholder: string;
  settings: AppSettings;
  onCommit: (val: string) => void;
}): ReactElement {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResultState["result"]>(null);
  const [showKey, setShowKey] = useState(false);

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setResult(null);
    try {
      const hits = await testSearchProvider(provider, settings);
      setResult({ hits });
    } catch (e) {
      setResult({ error: describeIpcError(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsRow
      label={label}
      description={description}
      controlLayout="wide"
      control={
        <div className="flex w-full items-center justify-end gap-2">
          {testing ? (
            <SettingsBadge>testing…</SettingsBadge>
          ) : result !== null ? (
            "hits" in result ? (
              <SettingsBadge>{`${result.hits} results`}</SettingsBadge>
            ) : (
              <SettingsBadge title={result.error}>error</SettingsBadge>
            )
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Test ${label}`}
            disabled={testing}
            onClick={() => void runTest()}
          >
            <PlayIcon className="size-3.5" />
          </Button>
          <div className="relative w-48 sm:w-64">
            <TextField
              type={showKey ? "text" : "password"}
              value={apiKey}
              placeholder={placeholder}
              ariaLabel={inputLabel}
              className="pr-8"
              onCommit={onCommit}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={showKey ? "Hide API key" : "Show API key"}
              className="absolute top-1/2 right-1 -translate-y-1/2"
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? (
                <EyeOffIcon className="size-3.5" />
              ) : (
                <EyeIcon className="size-3.5" />
              )}
            </Button>
          </div>
        </div>
      }
    />
  );
}

function SearxngRow({
  settings,
  onCommit,
}: {
  settings: AppSettings;
  onCommit: (val: string) => void;
}): ReactElement {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResultState["result"]>(null);

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setResult(null);
    try {
      const hits = await testSearchProvider("searxng", settings);
      setResult({ hits });
    } catch (e) {
      setResult({ error: describeIpcError(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsRow
      label="SearXNG"
      description="Self-hosted SearXNG instance URL"
      controlLayout="wide"
      control={
        <div className="flex w-full items-center justify-end gap-2">
          {testing ? (
            <SettingsBadge>testing…</SettingsBadge>
          ) : result !== null ? (
            "hits" in result ? (
              <SettingsBadge>{`${result.hits} results`}</SettingsBadge>
            ) : (
              <SettingsBadge title={result.error}>error</SettingsBadge>
            )
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Test SearXNG"
            disabled={testing}
            onClick={() => void runTest()}
          >
            <PlayIcon className="size-3.5" />
          </Button>
          <TextField
            type="text"
            value={settings.web.searxngUrl}
            placeholder="http://localhost:8080"
            ariaLabel="SearXNG URL"
            className="w-48 sm:w-64"
            onCommit={onCommit}
          />
        </div>
      }
    />
  );
}

function DuckDuckGoRow({ settings }: { settings: AppSettings }): ReactElement {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResultState["result"]>(null);

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setResult(null);
    try {
      const hits = await testSearchProvider("duckduckgo", settings);
      setResult({ hits });
    } catch (e) {
      setResult({ error: describeIpcError(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsRow
      label="DuckDuckGo"
      description="Keyless · always available"
      controlLayout="wide"
      control={
        <div className="flex w-full items-center justify-end gap-2">
          {testing ? (
            <SettingsBadge>testing…</SettingsBadge>
          ) : result !== null ? (
            "hits" in result ? (
              <SettingsBadge>{`${result.hits} results`}</SettingsBadge>
            ) : (
              <SettingsBadge title={result.error}>error</SettingsBadge>
            )
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Test DuckDuckGo"
            disabled={testing}
            onClick={() => void runTest()}
          >
            <PlayIcon className="size-3.5" />
          </Button>
          <SettingsBadge>Keyless</SettingsBadge>
        </div>
      }
    />
  );
}

export default function WebSearchSection({
  settings,
  onSave,
}: WebSearchSectionProps): ReactElement | null {
  if (settings === null) return null;

  const updateField = <K extends keyof WebSettings>(field: K, value: WebSettings[K]) => {
    onSave({
      web: {
        ...settings.web,
        [field]: value,
      },
    });
  };

  return (
    <SettingsGroupCard>
      <div className="border-b border-border px-4 py-3">
        <div className="text-ui-base font-medium text-foreground">Web Search</div>
        <div className="mt-1 text-ui-base leading-6 text-foreground-subtle">
          Configure Search providers and proxy for web_search and fetch_content tools.
        </div>
      </div>

      <KeyedProviderRow
        provider="brave"
        label="Brave Search"
        description="API key for Brave Search API"
        apiKey={settings.web.braveApiKey}
        inputLabel="Brave API key"
        placeholder="Brave API key"
        settings={settings}
        onCommit={(val) => updateField("braveApiKey", val)}
      />

      <KeyedProviderRow
        provider="tavily"
        label="Tavily"
        description="API key for Tavily Search API"
        apiKey={settings.web.tavilyApiKey}
        inputLabel="Tavily API key"
        placeholder="Tavily API key"
        settings={settings}
        onCommit={(val) => updateField("tavilyApiKey", val)}
      />

      <KeyedProviderRow
        provider="perplexity"
        label="Perplexity"
        description="API key for Perplexity Sonar API"
        apiKey={settings.web.perplexityApiKey}
        inputLabel="Perplexity API key"
        placeholder="Perplexity API key"
        settings={settings}
        onCommit={(val) => updateField("perplexityApiKey", val)}
      />

      <SearxngRow
        settings={settings}
        onCommit={(val) => updateField("searxngUrl", val)}
      />

      <DuckDuckGoRow settings={settings} />

      <SettingsRow
        label="Default provider"
        description="Primary Search provider to query before fallback"
        controlLayout="wide"
        control={
          <div className="flex w-full items-center justify-end">
            <Select
              value={closedSelectValue(
                settings.web.defaultProvider,
                ["auto", "brave", "tavily", "perplexity", "searxng", "duckduckgo"],
                "auto",
              )}
              onValueChange={(val) => updateField("defaultProvider", val)}
            >
              <SelectTrigger aria-label="Default provider" className="w-48 sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (fallback order)</SelectItem>
                <SelectItem value="brave">
                  Brave Search{!settings.web.braveApiKey && " (not configured)"}
                </SelectItem>
                <SelectItem value="tavily">
                  Tavily{!settings.web.tavilyApiKey && " (not configured)"}
                </SelectItem>
                <SelectItem value="perplexity">
                  Perplexity{!settings.web.perplexityApiKey && " (not configured)"}
                </SelectItem>
                <SelectItem value="searxng">
                  SearXNG{!settings.web.searxngUrl && " (not configured)"}
                </SelectItem>
                <SelectItem value="duckduckgo">DuckDuckGo</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />

      <SettingsRow
        label="Proxy"
        description="HTTP or HTTPS proxy URL for web requests (empty = HTTPS_PROXY / HTTP_PROXY env)"
        controlLayout="wide"
        control={
          <div className="flex w-full items-center justify-end">
            <TextField
              type="text"
              value={settings.web.proxy}
              placeholder="http://127.0.0.1:8080"
              ariaLabel="Proxy URL"
              className="w-48 sm:w-64"
              onCommit={(val) => updateField("proxy", val)}
            />
          </div>
        }
      />
    </SettingsGroupCard>
  );
}
