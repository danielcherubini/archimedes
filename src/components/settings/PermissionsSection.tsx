import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { PencilIcon, TrashIcon } from "lucide-react";
import type {
  AccessDirection,
  AccessPolicy,
  AccessRule,
  AppSettings,
  FilePolicy,
} from "@/lib/tauri";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  SettingsBadge,
  SettingsDataRow,
  SettingsGroupCard,
  SettingsRow,
} from "./primitives";
import { Field } from "./controls";

/** The Permissions section's props (every piece of state stays in `SettingsPage`). */
interface PermissionsSectionProps {
  settings: AppSettings | null;
  /** The add/edit rule dialog draft (`null` = closed). */
  dialog: RuleDraft | null;
  setDialog: (draft: RuleDraft | null) => void;
  /**
   * (ADR 0030) Whether the Shell `Sandboxed` tier can be OFFERED at all: the
   * OS sandbox is Landlock, i.e. Linux only. `false` HIDES the option (there
   * is nothing to choose). See `shellSandboxSupported` for the Linux case
   * where the kernel cannot enforce Landlock (the option stays, greyed out).
   */
  shellSandboxAvailable: boolean;
  /**
   * (ADR 0030 Task 5) Whether THIS kernel can confine a shell (the
   * `shell_sandbox_available` probe). On Linux with `false` the `Sandboxed`
   * option stays VISIBLE but DISABLED, with the reason stated in the row:
   * confined commands fail closed, so offering them as a live choice would
   * be a lie, and hiding it would hide a real (if unusable) tier.
   */
  shellSandboxSupported: boolean;
  /** The immediate-save pattern (`SettingsPage`'s `update`). */
  onSave: (patch: Partial<AppSettings>) => void;
  /** Save one rule (add or edit — the dialog's Save). The second argument is
   * the rule an EDIT started from (the draft's `original` — there is no rule
   * id, see `RuleDraft`); an add omits it. */
  onSaveRule: (rule: AccessRule, replaces?: AccessRule) => void;
  /** Drop one rule (immediate save). */
  onRemoveRule: (rule: AccessRule) => void;
}

/**
 * (ADR 0030) One file-access-policy row: the direction's label + honest
 * copy, and the three-tier select (the "Default thinking level" row's
 * shape — a `Select` with an `aria-label`ed `SelectTrigger`).
 *
 * The labels are the wire values' human names (`sandboxed` / `ask` /
 * `allow`); `hideSandbox` drops the first tier where the OS has no sandbox
 * to offer (Shell off Linux).
 *
 * (permissions-section) This component MOVED OUT OF `GeneralSection.tsx`
 * verbatim — the `hideSandbox` / `sandboxDisabled` handling and the
 * "Sandboxed (unavailable here)" empty-trigger readout are part of it and
 * are NOT re-implementations (the spec is explicit that this logic is
 * subtle). The moved tests exercise it from `PermissionsSection.test.tsx`.
 */
function PolicyRow({
  label,
  description,
  value,
  onChange,
  hideSandbox = false,
  sandboxDisabled = false,
}: {
  label: "Reads" | "Writes" | "Shell";
  description: ReactNode;
  value: AccessPolicy;
  onChange: (value: AccessPolicy) => void;
  /** The Shell row hides `Sandboxed` off Linux (no Landlock = nothing to choose). */
  hideSandbox?: boolean;
  /**
   * (ADR 0030 Task 5) When set, the `Sandboxed` option is shown but
   * DISABLED and the row states this one-line reason (Linux without
   * Landlock: choosing it would make every command fail closed).
   */
  sandboxDisabled?: boolean;
}): ReactElement {
  return (
    <SettingsRow
      label={label}
      description={description}
      control={
        <Select
          value={value}
          onValueChange={(next) => onChange(next as AccessPolicy)}
        >
          <SelectTrigger aria-label={label} className="w-48">
            <SelectValue>
              {/* A `sandboxed` written on Linux survives a move to a machine
                  with no Landlock, where its item is hidden — and Radix
                  renders an empty trigger for a value with no matching
                  item. Name the stored value and say it cannot work here.
                  NOT "Don't ask me": the value still fails every command
                  closed, and a friendlier label would hide that. The value
                  itself is untouched on save. */}
              {hideSandbox && value === "sandboxed"
                ? "Sandboxed (unavailable here)"
                : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {!hideSandbox && (
              <SelectItem value="sandboxed" disabled={sandboxDisabled}>
                Sandboxed
              </SelectItem>
            )}
            <SelectItem value="ask">Ask me</SelectItem>
            <SelectItem value="allow">Don't ask me</SelectItem>
          </SelectContent>
        </Select>
      }
    />
  );
}

/** The add/edit rule draft (the `PermissionsDialog`'s local state).
 *
 * `original` is the plan's "replace by the PRE-EDIT rule" carried to the page:
 * there is no rule id (a rule IS `{path, direction, decision}`), and the
 * dialog's Save builds a FRESH triple from the draft, so the page cannot find
 * the rule an EDIT replaced by comparing that fresh object against the store
 * array. The Edit button therefore remembers the store's own rule object on
 * the draft, and the page's `saveRule` replaces THAT reference; an add leaves
 * it `undefined` (append). It is bookkeeping, not a form field — the dialog
 * renders the three fields and `draftToRule` never copies it. */
export interface RuleDraft {
  path: string;
  direction: AccessDirection;
  decision: "allow" | "deny";
  /** The rule this draft EDITS (the store's own object), `undefined` = an add. */
  original?: AccessRule;
}

/** The rules add/edit form (three fields; Save = the immediate-save pattern). */
function ruleToDraft(rule: AccessRule): RuleDraft {
  return {
    path: rule.path,
    direction: rule.direction,
    decision: rule.decision,
    original: rule,
  };
}
function draftToRule(d: RuleDraft): AccessRule {
  return { path: d.path.trim(), direction: d.direction, decision: d.decision };
}

/**
 * One rule row: path + a direction badge (the WIRE value, exactly like the
 * MCP badge shows the wire kind) + the decision as text (the MCP row's
 * summary-as-text pattern). Edit + Remove (an `AlertDialog` confirm, the
 * `McpSection` shape). NO Test action — the spec: "simpler: three fields,
 * no Test action".
 */
function RuleRow({
  rule,
  onEdit,
  onRemove,
}: {
  rule: AccessRule;
  onEdit: () => void;
  onRemove: () => void;
}): ReactElement {
  return (
    <SettingsDataRow>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-ui-base font-medium text-foreground">
              {rule.path}
            </span>
            <SettingsBadge>{rule.direction}</SettingsBadge>
          </div>
          <div className="truncate text-ui-sm text-foreground-subtle">
            {rule.decision}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit rule ${rule.path}`}
          onClick={onEdit}
        >
          <PencilIcon className="size-3.5" />
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove rule ${rule.path}`}
            >
              <TrashIcon className="size-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove rule {rule.path}?</AlertDialogTitle>
              <AlertDialogDescription>
                The rule stops applying, and the posture selects above decide
                again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onRemove}>Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </SettingsDataRow>
  );
}

/**
 * The add/edit form (the `McpDialog`'s model — an uncontrolled draft copy,
 * a `set` partial-patcher, a `valid` gate on Save). Three fields: path,
 * direction, decision.
 */
function PermissionsDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: RuleDraft;
  onSave: (rule: AccessRule, replaces?: AccessRule) => void;
  onClose: () => void;
}): ReactElement {
  const [draft, setDraft] = useState(initial);
  const set = (patch: Partial<RuleDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const valid = draft.path.trim() !== "";
  return (
    <Dialog open onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {initial.path === "" ? "Add rule" : `Edit rule ${initial.path}`}
          </DialogTitle>
          <DialogDescription>
            Stored in the desktop's settings.json. Deny beats allow on the
            same path; the more specific path wins. Rules never apply to bash.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Path">
            <Input
              value={draft.path}
              placeholder="~/.pi/agent"
              aria-label="Path"
              onChange={(e) => set({ path: e.currentTarget.value })}
            />
          </Field>
          <Field label="Direction">
            <Select
              value={draft.direction}
              onValueChange={(v) => set({ direction: v as AccessDirection })}
            >
              <SelectTrigger aria-label="Direction" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">Read</SelectItem>
                <SelectItem value="write">Write</SelectItem>
                <SelectItem value="readWrite">Read &amp; write</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Decision">
            <Select
              value={draft.decision}
              onValueChange={(v) =>
                set({ decision: v as RuleDraft["decision"] })
              }
            >
              <SelectTrigger aria-label="Decision" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">allow</SelectItem>
                <SelectItem value="deny">deny</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => onSave(draftToRule(draft), draft.original)}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Permissions section: the three posture selects + the Trust toggle
 * (both MOVED OUT OF General — a UI move only; `defaultTrustNewSpaces` is a
 * top-level `AppSettings` key, not a `FilePolicy` key), the scope copy the
 * bash decision requires, and the `{path, direction, decision}` rules list
 * (the `McpSection` row + dialog model, simpler: three fields, no Test
 * action). Rules persist through the existing whole-document `save_settings`
 * — no new commands, no wire change.
 */
export default function PermissionsSection({
  settings,
  dialog,
  setDialog,
  shellSandboxAvailable,
  shellSandboxSupported,
  onSave,
  onSaveRule,
  onRemoveRule,
}: PermissionsSectionProps): ReactElement | null {
  if (settings === null) return null;
  /**
   * The file-access policy (ADR 0030): the direction's stored policy, or the
   * documented default (`"allow"`) when the document predates the field — the
   * select must render the honest default, never an empty value.
   */
  const policy = (direction: "reads" | "writes" | "shell"): AccessPolicy =>
    settings.filePolicy?.[direction] ?? "allow";
  /**
   * Save one direction without touching the other two — AND without touching
   * `rules`: the spread of the stored `filePolicy` (all four keys) is the
   * fix for the silent-rule-deletion hazard the three-key reconstruction
   * carried (`skip_serializing_if = "Vec::is_empty"` made the loss invisible
   * on the wire). The three explicit reads stay so a pre-feature document
   * with no `filePolicy` still composes cleanly.
   */
  const savePolicy = (
    direction: "reads" | "writes" | "shell",
    value: AccessPolicy,
  ): void => {
    const fp = settings.filePolicy;
    const current: FilePolicy = {
      ...fp,
      reads: policy("reads"),
      writes: policy("writes"),
      shell: policy("shell"),
    };
    onSave({ filePolicy: { ...current, [direction]: value } });
  };
  const rules = settings.filePolicy?.rules ?? [];
  return (
    <div className="space-y-3">
      <SettingsGroupCard>
        {/* The file-access policy (ADR 0030): three selects — Reads / Writes /
            Shell — over the SAME three wire values (`sandboxed` / `ask` /
            `allow`). All three default to `allow` ("Don't ask me"), so the row
            copy IS the safety story: it states the free pass plainly, and
            never phrases the default as a restriction. */}
        <PolicyRow
          label="Reads"
          description={
            <>
              Reading files outside the boundary (the Space folder and the
              skill/agent directories). "Don't ask me" = no prompt and no log;
              "Ask me" prompts for each read outside the boundary; "Sandboxed"
              refuses it.
            </>
          }
          value={policy("reads")}
          onChange={(value) => savePolicy("reads", value)}
        />
        {/* The file-access policy (ADR 0030). WHY this row carries a disclosure
            the other two do not: the protected-dir refusal is forbidden from
            naming the route that bypasses it (issue #33), so this row is the
            ONLY place a human learns the carve-out is not absolute. It must
            therefore read as ADR 0030 wrote it — a guard-rail, not a security
            boundary — and no other surface contradicts it. Note the refusal is
            scoped to the protected LIST, not to a path: a directory is covered
            because the list names it, which is what the code actually does.
            (permissions-section) With the rules layer, a matching `deny` rule
            turns the refusal into an ASK — the copy states that path instead
            of claiming an absolute, which the old wording did. */}
        <PolicyRow
          label="Writes"
          description={
            <>
              Writing files outside the boundary. The default, "Don't ask me",
              lets the agent write anywhere on the machine with no prompt. The
              one carve-out is the protected agent-definition directories (your
              global skills and agents): while a directory is on this app's
              protected list and no deny rule covers it, the file tools refuse
              to rewrite it, and that refusal is a guard-rail against the agent
              silently rewriting its own instructions — not a security
              boundary. A matching rule can turn that refusal into a prompt.
              The shell tool and sudo_exec are governed by their own gates and
              reach these directories by design, and no setting here closes
              that; the guard-rail follows that list rather than the folder, so
              a directory the list does not name is not covered by it.
            </>
          }
          value={policy("writes")}
          onChange={(value) => savePolicy("writes", value)}
        />
        <PolicyRow
          label="Shell"
          description={
            <>
              The bash tool (sudo_exec and MCP tools have their own gates, not
              this policy). The default, "Don't ask me", runs commands anywhere
              on the machine with no prompt.
              {shellSandboxAvailable && shellSandboxSupported
                ? " Sandboxed runs them inside an OS sandbox (Landlock) confined to your Space folder and the system temp dirs (/tmp, /var/tmp): writes stay inside those, system files stay readable, and there are no network rules."
                : null}
              {/* (ADR 0030 Task 5) Linux without Landlock: the tier is greyed
                  out and the reason is stated — the honest sentence is that
                  confined commands CANNOT run here, not that they are unsafe
                  (they are never run unsandboxed). */}
              {shellSandboxAvailable && !shellSandboxSupported ? (
                <>
                  {" "}
                  "Sandboxed" cannot run on this machine: this kernel has no
                  Landlock, so sandboxed commands will fail instead of running
                  unsandboxed.
                </>
              ) : null}
            </>
          }
          value={policy("shell")}
          onChange={(value) => savePolicy("shell", value)}
          hideSandbox={!shellSandboxAvailable}
          sandboxDisabled={!shellSandboxSupported}
        />
        <SettingsRow
          label="Trust new Spaces by default"
          description="New Spaces start trusted (skip permission prompts). A trusted Space's agent can also write its own instruction directories without asking — deny those paths with a rule above if you want that to still prompt."
          control={
            <Switch
              checked={settings.defaultTrustNewSpaces}
              aria-label="Trust new Spaces by default"
              onCheckedChange={(checked) =>
                onSave({ defaultTrustNewSpaces: checked })
              }
            />
          }
        />
        {/* The scope copy the bash decision REQUIRES (not optional prose):
            the rules panel must not imply bash is covered — it is not, and
            only the user's own OS permissions stop it. */}
        <SettingsRow
          label="Rules apply to the file tools only"
          description={
            <>
              These rules apply to the file tools (`read`, `write`, `edit`,
              `grep`, `glob`). <b>bash runs with your own user's OS permissions
              — it is not covered here.</b> To stop the agent reaching
              something with `bash`, remove your user's access to it.
            </>
          }
          control={null}
        />
      </SettingsGroupCard>
      <SettingsGroupCard>
        {rules.length === 0 ? (
          <div className="px-4 py-3 text-ui-base text-foreground-subtle">
            <div>No rules yet.</div>
            <div className="mt-1">
              Three starter rules exist for a clean install: <code>~</code>{" "}
              read/write <em>allow</em> and <code>/</code> read <em>allow</em>{" "}
              (both change nothing at the default open posture — they document
              how open it is), and <code>~/.pi/agent</code> read <em>deny</em>{" "}
              (the one real restriction: covers{" "}
              <code>~/.pi/agent/auth.json</code>, which today sits outside the
              boundary and is refused only under <code>reads: Sandboxed</code>).
              The deny rule is a default you can delete.
            </div>
          </div>
        ) : (
          rules.map((rule) => (
            <RuleRow
              key={`${rule.path}|${rule.direction}|${rule.decision}`}
              rule={rule}
              onEdit={() => setDialog(ruleToDraft(rule))}
              onRemove={() => onRemoveRule(rule)}
            />
          ))
        )}
        {/* The default-rules offer (the plan's Decision 2): the spec's "three
            default rules written only on first write" has NO mechanism —
            nothing can distinguish "never seeded" from "the user deleted all
            rules" (empty and absent are byte-identical on the wire) — so the
            defaults are OFFERED as an explicit user action pre-filling the
            DRAFT, and no rule is ever written without a click. The offer's
            gate is the empty list, so it RE-APPEARS after the last rule is
            removed — chosen (Decision 4) and pinned: the copy labels the deny
            rule deletable, and one button on an otherwise-empty card is
            honest, not nagging. */}
        {rules.length === 0 && (
          <div className="px-4 py-3">
            <Button
              variant="outline"
              onClick={() =>
                setDialog({ path: "~/.pi/agent", direction: "read", decision: "deny" })
              }
            >
              Add default rule
            </Button>
          </div>
        )}
      </SettingsGroupCard>
      <Button
        onClick={() => setDialog({ path: "", direction: "read", decision: "deny" })}
      >
        Add rule
      </Button>
      {dialog !== null && (
        <PermissionsDialog
          initial={dialog}
          onSave={onSaveRule}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
