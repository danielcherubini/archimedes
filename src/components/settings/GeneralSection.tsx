import type { ReactElement } from "react";
import type { AppSettings, ModelDto } from "@/lib/tauri";
import ModelPicker from "@/components/ModelPicker";
import { modelItemsFromCatalog } from "@/components/ModelPickerDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SettingsDataRow, SettingsGroupCard, SettingsRow } from "./primitives";

/** The General section's props (every piece of state stays in `SettingsPage`). */
interface GeneralSectionProps {
  settings: AppSettings | null;
  models: ModelDto[];
  /** The native harness's tool names (the enabled-tools checkbox list). */
  tools: string[];
  /** The union of the `listModels` results' advertised thinking levels. */
  thinkingLevelUnion: string[];
  /** A stored default level the union no longer advertises (`null` = none). */
  storedLevelOutsideUnion: string | null;
  /** The immediate-save pattern. */
  onSave: (patch: Partial<AppSettings>) => void;
  /** Toggle one tool in the enabled-tools list (immediate save). */
  onToggleTool: (name: string) => void;
}

/**
 * The delay options the attention-alert select offers, in SECONDS (the wire
 * unit — the `s` suffix is UI-only). 15 is the backend default
 * (`default_attention_delay_secs`); the others bracket it. Deliberately NOT a
 * union type: a hand-edited `settings.json` is a real producer and there is no
 * clamping layer, so a value outside this list is a value the UI must still
 * display (see the `SelectValue` children below).
 */
const ATTENTION_DELAYS: number[] = [5, 15, 30, 60];

/** The General section: default model / thinking level / session naming / tools. */
export default function GeneralSection({
  settings,
  models,
  tools,
  thinkingLevelUnion,
  storedLevelOutsideUnion,
  onSave,
  onToggleTool,
}: GeneralSectionProps): ReactElement | null {
  if (settings === null) return null;
  return (
    <SettingsGroupCard>
      {/* The `#` MCP-mention trigger (ADR 0031's follow-up). OFF by default,
          and the copy says WHY: `#` is the one prefix that collides with the
          text a coding user pastes, so an accidental mention is the failure
          mode here rather than a missing feature. It gates the TRIGGER only —
          a message already sent with a `#` mention keeps rendering its chip. */}
      <SettingsRow
        label="Mention MCP servers with #"
        description="Type # to name an MCP server in a message. # collides with pasted text such as #include or an issue number #123, so it is off by default: an accidental mention can fire whenever a server shares such a name. The $ and @ mentions are always on."
        control={
          <Switch
            checked={settings.mcpMentionsEnabled}
            aria-label="Mention MCP servers with #"
            onCheckedChange={(checked) =>
              onSave({ mcpMentionsEnabled: checked })
            }
          />
        }
      />
      <SettingsRow
        label="Default model"
        description="The model new sessions start with (the system default when unset)"
        control={
          // The SHARED `ModelPicker` (the one component every model picker
          // uses — a trigger opening the fuzzy-searched, alphabetical
          // dialog; the catalog is too long for a Radix dropdown). The
          // items are the SHARED derivation (the row name is the BARE
          // model id — the provider prefix is dropped; the provider cue is
          // the provider's display name — `tama` → `Tama` from the
          // configured providers) + the "System default" row (value `""`
          // → `defaultModel: null`).
          <ModelPicker
            label="Default model"
            value={settings.defaultModel ?? ""}
            placeholder="System default"
            items={[
              ...modelItemsFromCatalog(
                models.map((model) => `${model.provider}/${model.id}`),
                settings.providers,
              ),
              { value: "", name: "System default" },
            ]}
            onSelect={(value) =>
              onSave({ defaultModel: value === "" ? null : value })
            }
          />
        }
      />
      <SettingsRow
        label="Default thinking level"
        description="The thinking level new sessions start with (the model's own default when unset)"
        control={
          <Select
            value={settings.defaultThinkingLevel ?? ""}
            onValueChange={(value) =>
              onSave({ defaultThinkingLevel: value === "" ? null : value })
            }
          >
            <SelectTrigger aria-label="Default thinking level" className="w-48">
              <SelectValue placeholder="Model default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Model default</SelectItem>
              {thinkingLevelUnion.map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
              {storedLevelOutsideUnion !== null && (
                // DISABLED, symmetric with the Agents modal's stale items: the
                // control already holds this value, so clicking the item re-fires
                // `onValueChange` with the same string and rewrites the same level —
                // a control that looks like it does something and only costs a save.
                <SelectItem value={storedLevelOutsideUnion} disabled>
                  {storedLevelOutsideUnion}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        }
      />
      {/* Session naming (the port of pi's `/archimedes` naming controls):
          the master switch, then the model the title request uses. The
          copy carries the once-only rule — naming NEVER overwrites a name
          a session already has, so turning it back on cannot relabel an
          existing session. `sessionNamingReasoning` stays JSON-only by
          decision (pi keeps it JSON-only too). */}
      <SettingsRow
        label="Name sessions automatically"
        description="A short model-written name for each session after its first exchange. A session keeps the name it already has — naming never overwrites one."
        control={
          <Switch
            checked={settings.sessionNamingEnabled}
            aria-label="Name sessions automatically"
            onCheckedChange={(checked) =>
              onSave({ sessionNamingEnabled: checked })
            }
          />
        }
      />
      <SettingsRow
        label="Session naming model"
        description="Model used to write session names (the session's own model when unset)"
        control={
          // The SHARED `ModelPicker` again (the "Default model" row's
          // shape): the same catalog derivation + the unset row, whose
          // value `""` saves `sessionNamingModel: null` (= the session's
          // own model). The `placeholder` repeats that row's name because
          // an unset picker renders the PLACEHOLDER, not the matched item
          // (`ModelPicker` short-circuits on `value === ""`) — without it
          // the trigger would be an empty box. `label` is the trigger's
          // accessible name (the component sets `aria-label={label}`).
          <ModelPicker
            label="Session naming model"
            value={settings.sessionNamingModel ?? ""}
            placeholder="Session's own model"
            items={[
              ...modelItemsFromCatalog(
                models.map((model) => `${model.provider}/${model.id}`),
                settings.providers,
              ),
              { value: "", name: "Session's own model" },
            ]}
            onSelect={(value) =>
              onSave({ sessionNamingModel: value === "" ? null : value })
            }
          />
        }
      />
      {/* The attention alerts (ADR 0038/0039): the OS notification raised when
          a session has been paused on you — a run that finished, or a gate
          awaiting an answer — for longer than the delay below. The copy states
          the two suppressions, because they are the feature: nothing fires
          while you are in the window, and any keystroke, click or scroll
          cancels a pending alert. Per-trigger toggles are deliberately absent
          (one switch, app-wide). */}
      <SettingsRow
        label="Alert when the app is waiting on you"
        description="An alert when a session has been waiting on you — finished, or needing an answer — for longer than the delay below. Nothing is sent while this window is focused, and typing, clicking or scrolling here cancels a pending alert."
        control={
          <Switch
            checked={settings.attentionAlertsEnabled}
            aria-label="Alert when the app is waiting on you"
            onCheckedChange={(checked) =>
              onSave({ attentionAlertsEnabled: checked })
            }
          />
        }
      />
      <SettingsRow
        label="Delay before alerting"
        description="How long a session must be waiting on you before the alert goes out. The delay is read when a countdown starts, so changing it does not re-time one already running."
        control={
          <Select
            value={`${settings.attentionAlertDelaySecs}s`}
            onValueChange={(value) =>
              onSave({
                attentionAlertDelaySecs: Number(value.replace("s", "")),
              })
            }
          >
            <SelectTrigger aria-label="Delay before alerting" className="w-48">
              <SelectValue>
                {/* A hand-edited `settings.json` can hold a delay outside this
                    list (there is no clamping layer on purpose), and Radix
                    renders the PLACEHOLDER for a value with no matching item —
                    an empty control would misrepresent what is saved. Name the
                    stored value instead, exactly as `PolicyRow` does for a
                    `sandboxed` shell off Linux. The value is untouched. */}
                {ATTENTION_DELAYS.includes(settings.attentionAlertDelaySecs)
                  ? undefined
                  : `${settings.attentionAlertDelaySecs}s`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ATTENTION_DELAYS.map((secs) => (
                <SelectItem key={secs} value={`${secs}s`}>
                  {`${secs}s`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {/* The enabled-tools list (the harness-level tool filter — `[]` = all
          tools: "none checked" is a valid, meaningful state, it means all).
          Task C8: this row hand-rolled the settings data-row shell WITHOUT
          `first:border-t-0`, which C2 recorded as the reason it was not a
          drop-in `SettingsDataRow`. Checked rather than assumed: this row is the
          card's LAST child (after three `PolicyRow`s and eight `SettingsRow`s),
          so `first:` (`:first-child`) could never match and the missing reset was
          inert. The primitive's shell is therefore identical here. */}
      <SettingsDataRow>
        <div className="text-ui-base font-medium text-foreground">
          Enabled tools
        </div>
        <div className="mt-1 text-ui-base leading-6 text-foreground-subtle">
          The harness tools new sessions start with — empty = all tools
        </div>
        {tools.length === 0 ? (
          <div className="mt-2 text-ui-sm text-foreground-subtlest">
            Loading…
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {tools.map((name) => (
              <label
                key={name}
                className="flex items-center gap-2 text-ui-base text-foreground"
              >
                <input
                  type="checkbox"
                  checked={settings.enabledTools.includes(name)}
                  aria-label={`Enable tool ${name}`}
                  onChange={() => onToggleTool(name)}
                />
                {name}
              </label>
            ))}
          </div>
        )}
      </SettingsDataRow>
    </SettingsGroupCard>
  );
}
