# Grounding report — Settings frontend (permissions section)

Area: `SettingsPage.tsx`, `GeneralSection.tsx`, `McpSection.tsx`, `useSettingsDocument`,
`src/lib/settings.ts`, `SettingsPage.test.tsx`. Reads the CURRENT tree (wave 1 already landed:
`c90f5dd`, `6fd3740`). Baseline verified this session: **153 test files / 3240 tests, all passing**
(`pnpm test`, 95.87 s). All quotes are verbatim from the tree at that baseline.

---

## 0. What already landed that this area needs (wave 1, both commits)

- **`src/lib/tauri/types.ts`** now carries the full wire mirror of the Rust rule model:
  - `export type AccessDirection = "read" | "write" | "readWrite";`
  - `export interface AccessRule { path: string; direction: AccessDirection; decision: "allow" | "deny"; }`
  - `FilePolicy` gained `rules?: AccessRule[]`; its doc comment says *"OPTIONAL on purpose: a pre-feature
    `settings.json` has no `rules` key and the backend defaults it to empty, so read it nullishly. Rules
    NEVER apply to `bash`."* — the frontend type is the seam the new section reads/writes through.
  - `AccessPolicy` is unchanged: `"sandboxed" | "ask" | "allow"` (the UI label for `"allow"` is
    "Don't ask me"; the label never rides the wire).
  - `FilePolicy` is `{ reads; writes; shell; rules? }` — three **required** `AccessPolicy` fields plus
    the optional `rules` array. The `defaultTrustNewSpaces` key is a **top-level `AppSettings` key**
    (`types.ts`), not a `FilePolicy` key — the spec's "no wire change" claim for moving the trust toggle
    checks out structurally.
- **`GeneralSection.tsx`** — the two `keyof FilePolicy` annotations on `policy` and `savePolicy` were
  narrowed to `"reads" | "writes" | "shell"` (type-only, 4 lines with the body, 2 annotation sites) so
  the new `rules` member does not make the index return `AccessPolicy | AccessRule[]` (a `pnpm build`
  blocker). Per the `6fd3740` commit message: *"The savePolicy three-key reconstruction silently
  dropping rules is NOT touched — T06 owns it and its report carries the full chain."* — i.e. the hazard
  below is a KNOWN HAZARD documented here for the next task, not something to fix or re-derive.
- The Rust side (for the hazard chain's symbol names): `src-tauri/src/agent/policy.rs` has
  `pub struct FilePolicy { pub reads; pub writes; pub shell; #[serde(default, skip_serializing_if =
  "Vec::is_empty")] pub rules: Vec<AccessRule> }` — an empty list **never serializes**, so the wire
  cannot distinguish "absent" from "empty". `src-tauri/src/commands/settings.rs` `save_settings`
  delegates straight to `config::write_settings` (a plain `fs::write` of `serde_json::to_string_pretty`),
  and `get_settings` delegates to `config::load_settings` — **no merge, no migration logic on save**.

### THE KNOWN HAZARD — full chain, with symbols

**Any write of the three posture selects destroys a user's rules.** The chain, end to end:

1. `GeneralSection.tsx` `savePolicy(direction, value)` rebuilds `FilePolicy` from exactly three keys —
   `const current: FilePolicy = { reads: policy("reads"), writes: policy("writes"), shell:
   policy("shell") }; onSave({ filePolicy: { ...current, [direction]: value } });` — there is **no
   `rules` key in the reconstruction**, so a document whose `filePolicy.rules` is non-empty loses it the
   moment a user touches Reads / Writes / Shell.
2. That `onSave` is `SettingsPage.tsx`'s `update`, which is the hook's `patch`.
3. `useSettingsDocument.ts` `patch` does a **top-level shallow merge** — `const next = { ...settings,
   ...changes };` — so the `filePolicy` object from step 1 **replaces the whole `filePolicy` key** of the
   document. `rules` is gone from the in-memory document.
4. `patch` then publishes `next` to the store (`useSettings.getState().setSettings(next)`) and calls
   `void saveSettings(next)` — the **complete** document, rules deleted — through
   `commands/settings.ts` `saveSettings` → Rust `save_settings` → `write_settings` (overwrite).
5. The Rust side's `#[serde(default, skip_serializing_if = "Vec::is_empty")]` means the file is then
   written **without** a `rules` key, and on the next load `#[serde(default)]` fills an empty `Vec` —
   so the wire cannot surface the loss either: empty and absent are byte-identical in the file.
   (`config.rs` `load_settings` has no field-level merge; it reads the file or defaults.)

Concrete loss scenario: a user clicks "Always allow this directory" in a guard prompt (the relay
persists one `allow` rule into `settings.json` — the Rust-owned write from ADR 0025's split), then
opens Settings and changes one posture select → the rule is silently dropped on that save.

The next task fixes this at the seam of step 2/3 (**`useSettingsDocument` `patch` is top-level-shallow;
`savePolicy` rebuilds only three keys**). A `rules`-preserving write must ensure the `filePolicy`
object handed to `patch` carries `rules` (from the store's document) alongside `{reads, writes, shell}`
— either inside `savePolicy`, or in a `patch` that merges `filePolicy` shallowly. Since `savePolicy` is
moving into the new Permissions section with `PolicyRow` (see §2), the fix lands wherever the moved
helper lands.

The **empty-rules-and-first-write interaction** compounds this: because the wire cannot carry "empty
list" distinctly, the first-write default seeding (spec §6 here) cannot structure itself as "write an
empty list then fill it" — see §6.

---

## 1. `SettingsPage.tsx`

### `type Section` — verbatim (the discriminator, `SettingsPage.tsx`)

```ts
/**
 * The section discriminator. `"sessions"` is the SHORT slug and it is never
 * rendered — the nav label is `Detached sessions`, which is what the user reads
 * (the section lists only sessions with no open Space, so a nav entry called
 * `Sessions` would promise the full list and show a partial one; and a button
 * whose text were exactly `Sessions` would collide with `App.test.tsx`'s pin
 * that the workspace UNMOUNTS while Settings is open).
 */
type Section =
  | "general"
  | "appearance"
  | "providers"
  | "mcp"
  | "sessions"
  | "web-search"
  | "updates";
```

`"permissions"` joins this union. **This is the ONLY type change in this file** (per the spec's
"`type Section` (`SettingsPage.tsx:50`) gains `"permissions"`").

### The sidebar nav list — verbatim, in order (the `nav`'s `space-y-1` div)

```tsx
<SettingsSidebarButton
  icon={Settings2Icon}
  label="General"
  active={section === "general"}
  onClick={() => setSection("general")}
/>
<SettingsSidebarButton
  icon={PaletteIcon}
  label="Appearance"
  active={section === "appearance"}
  onClick={() => setSection("appearance")}
/>
<SettingsSidebarButton
  icon={PackageIcon}
  label="Providers"
  active={section === "providers"}
  onClick={() => setSection("providers")}
/>
<SettingsSidebarButton
  icon={ServerIcon}
  label="MCP"
  active={section === "mcp"}
  onClick={() => setSection("mcp")}
/>
<SettingsSidebarButton
  icon={FolderXIcon}
  label="Detached sessions"
  active={section === "sessions"}
  onClick={() => setSection("sessions")}
/>
<SettingsSidebarButton
  icon={GlobeIcon}
  label="Web search"
  active={section === "web-search"}
  onClick={() => setSection("web-search")}
/>
<SettingsSidebarButton
  icon={DownloadIcon}
  label="Updates"
  active={section === "updates"}
  onClick={() => setSection("updates")}
/>
```

`SettingsSidebarButton` (from `./primitives`) is a `<Button variant="link">` with `aria-label={label}`;
the nav pin in `SettingsPage.test.tsx` reads `document.querySelectorAll("nav button")` aria-labels (see
§5). The `nav` carries `aria-label="Settings sections"`.

### The section switch — verbatim (the content-area `section`)

```tsx
<section className="min-h-0 overflow-y-auto">
  <div className="mx-auto w-full max-w-4xl px-4 pb-8 pt-4">
    {section === "general"
      ? generalSection
      : section === "appearance"
        ? appearanceSection
        : section === "providers"
          ? providersSection
          : section === "mcp"
            ? mcpSection
            : section === "sessions"
              ? sessionsSection
              : section === "web-search"
                ? webSearchSection
                : updatesSection}
  </div>
</section>
```

**The ternary chain has no default element for an unmapped `section` — the final `: updatesSection`
arm catches everything.** A new arm must be spliced before `: updatesSection`; every existing arm
renders one of the pre-built `const xxxSection = (...)`. An unmapped `"permissions"` would silently
render the Updates section (nothing type-checks it), which is why both the union member AND its ternary
arm are required together.

### How a section's element is constructed and rendered

Each section is a **module-level component** (default export from its own file) instantiated once per
render into a const; `SettingsPage` **owns every piece of state** and passes it by props, and the
**immediate-save pattern is `onSave={update}`** — the components never import the hook or the store.
Two consts are worth contrasting:

- `generalSection` takes the picker data + the page-owned `toggleTool`:
  `onSave={update}` `onToggleTool={toggleTool}`.
- `updatesSection` is `<UpdateSection />` — **no props at all**; its version row reads `getAppInfo`
  itself (the comment: *"an update is not a preference"*).

### The per-section const pattern — verbatim

```tsx
const mcpSection = (
  <McpSection
    settings={settings}
    dialog={mcpDialog}
    setDialog={setMcpDialog}
    onSave={saveMcpServer}
    onRemove={removeMcpServer}
  />
);
```

`mcpSection` is the model the rules section copies: a const that passes `settings`, the dialog draft
state (`mcpDialog` is `useState<McpDraft | null>(null)` on the page), a setter, and save/remove
callbacks that **live on the page** and call `update` — with `McpDraft` imported as a **type** from the
section module (`import McpSection, { type McpDraft } from "./McpSection";`).

### Every place a new `"permissions"` entry must be added (the full list)

1. `type Section` union (quoted above) — add `| "permissions"`.
2. The sidebar `nav` — one new `SettingsSidebarButton` (label per the spec's section name, an icon
   import added to the lucide import list, `active={section === "permissions"}`, `onClick={() =>
   setSection("permissions")}`), in the chosen slot.
3. The import of a new `PermissionsSection` default export (alongside the `./GeneralSection` etc.
   imports).
4. A new `const permissionsSection = (<PermissionsSection … />)` block beside `mcpSection`.
5. A new ternary arm in the section switch, **before the `: updatesSection` catch-all**.
6. `SettingsPage.test.tsx`: the nav-id pin array (see §5) extends with the new button's
   `aria-label`; `go(...)`'s union type and its per-section wait get a `"Permissions"` arm; and any
   `.border-t`-based row-order tests that assert "the three `PolicyRow`s sit above the Trust switch"
   must be re-pointed (the rows move out of General — see §2).

Nothing else: `SettingsPage` already holds the `settings` document (via `useSettingsDocument`), so a
new section needs no new fetch, no new state shape beyond possibly a rules-dialog draft mirroring
`mcpDialog`.

---

## 2. `GeneralSection.tsx`

### `PolicyRow` — verbatim (it is NOT exported)

```tsx
/**
 * (ADR 0030) One file-access-policy row: the direction's label + honest
 * copy, and the three-tier select (the "Default thinking level" row's
 * shape — a `Select` with an `aria-label`ed `SelectTrigger`).
 *
 * The labels are the wire values' human names (`sandboxed` / `ask` /
 * `allow`); `hideSandbox` drops the first tier where the OS has no sandbox
 * to offer (Shell off Linux).
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
```

**Visibility: `function PolicyRow` — module-private, NOT exported.** `GeneralSection` itself is
`export default function GeneralSection`. The spec says `PolicyRow` "moves intact"; because it is
private, "moving intact" is a **copy of this exact component into the new section's module** (or an
export, which changes the module surface — the moving task's choice). The `hideSandbox` /
`sandboxDisabled` handling and the "Sandboxed (unavailable here)" empty-trigger readout are part of
the component and must be copied verbatim (the spec is explicit that this logic is subtle and must not
be re-implemented). Note the label union `"Reads" | "Writes" | "Shell"` is hardcoded into the prop
type and the `SelectTrigger aria-label={label}` — the tests query by these combobox names (see §5).

### The three `PolicyRow` usages — verbatim

**Reads:**

```tsx
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
```

**Writes:**

```tsx
<PolicyRow
  label="Writes"
  description={
    <>
      Writing files outside the boundary. The default, "Don't ask me",
      lets the agent write anywhere on the machine with no prompt. The
      one carve-out is the protected agent-definition directories (your
      global skills and agents): the file tools refuse to rewrite a
      directory while it is on this app's protected list, and that
      refusal is a guard-rail against the agent silently rewriting its
      own instructions — not a security boundary. The shell tool and
      sudo_exec are governed by their own gates and reach these
      directories by design, and no setting here closes that; the
      guard-rail follows that list rather than the folder, so a
      directory the list does not name is not covered by it.
    </>
  }
  value={policy("writes")}
  onChange={(value) => savePolicy("writes", value)}
/>
```

**Shell:**

```tsx
<PolicyRow
  label="Shell"
  description={
    <>
      The bash tool (sudo_exec and MCP tools have their own gates, not
      this policy). The default, "Don't ask me", runs commands anywhere on
      the machine with no prompt.
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
```

Wait — the Shell row's copy above is reconstructed from the file it was read from (the comment-laden
JSX was returned in the tool output). **The exact Shell-row description text this report's
transcription shows matches the source** (the Landlock sentence and the Linux-without-Landlock
sentence are embedded in the JSX exactly as written). The three rows render in **Reads → Writes →
Shell order and are the card's first children** (before the trust toggle and everything else); the
card currently contains them followed by the trust row, the `#` mention row, Default model, Default
thinking level, session naming ×2, attention ×2, and the Enabled-tools `SettingsDataRow` last.

The `policy` / `savePolicy` helpers (recap, see §0 hazard): `policy` reads
`settings.filePolicy?.[direction] ?? "allow"` (nullish across a pre-feature document — this is what
makes "never an empty select" true), `savePolicy` rebuilds the three-key `FilePolicy` and calls
`onSave` — the helpers **move with the rows** into the permissions section, taking
`shellSandboxAvailable` / `shellSandboxSupported` props with them.

### The trust toggle block — verbatim

```tsx
<SettingsRow
  label="Trust new Spaces by default"
  description="New Spaces start trusted (skip permission prompts for bash/edit/write); existing Spaces are unaffected"
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
```

The trust toggle is a plain `SettingsRow` + `Switch` saving the **top-level** `defaultTrustNewSpaces`
(the spec's "no wire change" — moving it means moving this block).

### The trust copy the spec says must change — verbatim (the CURRENT description string)

> `description="New Spaces start trusted (skip permission prompts for bash/edit/write); existing Spaces are unaffected"`

This is the string `GeneralSection.tsx:237`'s description prop holds (one line, inside the
`SettingsRow` quoted above). The spec's replacement is the "Trust copy must change" block in
permissions-section.md. Note the spec's spec-section quote *"skip permission prompts for
bash/edit/write"* is the substring of this current string. The spec's approved replacement text:

> "New Spaces start trusted (skip permission prompts). A trusted Space's agent can also write its own instruction directories without asking — deny those paths with a rule above if you want that to still prompt."

**Also note**: the Writes-row copy quoted above promises *"the file tools refuse to rewrite a
directory while it is on this app's protected list, and that refusal is a guard-rail…"* — with the
rules change (deny-by-default-rule → ask), the Writes copy arguably needs a follow-up re-word; that
is a copy decision for the planner, NOT a finding — the Writes row's disclosure test pins the
guard-rail language (§5) and will need its own churn decision.

---

## 3. `McpSection.tsx` — the rows+dialog model to copy

### What it exports

- `export default function McpSection(...)`; `export interface McpDraft { … }` — that is all. The row
  (`McpRow`), the dialog (`McpDialog`), and the draft converters (`entryToDraft`, `draftToEntry`) are
  **module-private**.
- Why it has no props for data-fetch state: every piece of state lives on `SettingsPage`.

### Component signatures — verbatim (the contract the section owns)

`McpSectionProps`:

```tsx
interface McpSectionProps {
  settings: AppSettings | null;
  /** The add/edit dialog draft (`null` = closed). */
  dialog: McpDraft | null;
  setDialog: (draft: McpDraft | null) => void;
  /** The dialog's Save (immediate save, the provider pattern). */
  onSave: (name: string, entry: McpServerEntry) => void;
  /** Drop one `mcpServers` entry (immediate save). */
  onRemove: (name: string) => void;
}
```

`McpDraft` (the dialog's local form state — one field per input):

```tsx
export interface McpDraft {
  name: string;
  kind: "http" | "stdio";
  url: string;
  headers: string; // `KEY=VALUE` lines
  bearerTokenEnv: string;
  useOAuth: boolean;
  command: string;
  args: string; // one arg per line
  env: string; // `KEY=VALUE` lines
  cwd: string;
}
```

### The row — the `McpRow` skeleton (abridged, the parts a rules row copies)

```tsx
function McpRow({
  name,
  entry,
  onEdit,
  onRemove,
}: {
  name: string;
  entry: McpServerEntry;
  onEdit: () => void;
  onRemove: () => void;
}): ReactElement {
  // …test/auth one-shot state + actions (the rules row has NO Test action —
  //     spec: "simpler: three fields, no Test action")…
  return (
    <SettingsDataRow>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-ui-base font-medium text-foreground">
              {name}
            </span>
            <SettingsBadge>{kind}</SettingsBadge>
            {isOAuth && <SettingsBadge>OAuth</SettingsBadge>}
          </div>
          <div className="truncate text-ui-sm text-foreground-subtle">{summary}</div>
        </div>
        {/* …test/auth ghost buttons … */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit MCP server ${name}`}
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
              aria-label={`Remove MCP server ${name}`}
            >
              <TrashIcon className="size-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove MCP server {name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The server leaves the harness's `mcp` tool (its tools are no
                longer callable). Existing sessions are unaffected.
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
```

Row anatomy for a rules row: `SettingsDataRow` shell (the shared `border-t` list-row primitive —
"the one fact the data rows actually agree on" per `primitives.tsx`), a `flex flex-wrap` of a
min-w-0 flex-1 text column (name + badges + summary) + ghost icon buttons (edit = `PencilIcon`,
remove = `TrashIcon` inside an `AlertDialog` confirm). The rules row's text column is *path,
direction, decision* instead of name/kind/summary, and it skips the Test/Auth machinery.

### The dialog — `McpDialog` shape (abridged, the parts a rules dialog copies)

```tsx
function McpDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: McpDraft;
  onSave: (name: string, entry: McpServerEntry) => void;
  onClose: () => void;
}): ReactElement {
  const [draft, setDraft] = useState(initial);
  const set = (patch: Partial<McpDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const valid =
    draft.name.trim() !== "" &&
    (draft.kind === "http"
      ? draft.url.trim() !== ""
      : draft.command.trim() !== "");
  return (
    <Dialog open onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {initial.name === ""
              ? "Add MCP server"
              : `Edit MCP server ${initial.name}`}
          </DialogTitle>
          <DialogDescription>
            Stored in the desktop's settings.json. …
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Name">
            <Input
              value={draft.name}
              placeholder="Server name"
              aria-label="Server name"
              onChange={(e) => set({ name: e.currentTarget.value })}
            />
          </Field>
          {/* …kind Select, per-kind fields… */}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => onSave(draft.name.trim(), draftToEntry(draft))}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

Dialog anatomy for a rules dialog: an **uncontrolled draft copy** (`useState(initial)`; the page's
`dialog` prop is only the initial value + null/closed signal), a `set` partial-patcher, a `valid`
gate on the Save button, `Dialog open onOpenChange={(nextOpen) => !nextOpen && onClose()}` (so Escape
closes through the page's setter), `Field` + `Input`/`Select`/`Textarea` controls from
`./controls` (`Field` is exported from `controls.tsx` alongside the MCP section). Three fields for a
rule: path (Input), direction (Select over `read` / `write` / `readWrite`), decision (Select over
`allow` / `deny`).

### How it saves (which hook/callback)

`McpSection` receives `onSave` and `onRemove` — it **never calls `useSettingsDocument` or the store
itself**; the page wires them: `saveMcpServer` on `SettingsPage` does

```tsx
const saveMcpServer = (name: string, entry: McpServerEntry) => {
  if (settings === null) return;
  update({ mcpServers: { ...settings.mcpServers, [name]: entry } });
  setMcpDialog(null);
};
```

i.e. compose a new `mcpServers` object, `update` (the hook's `patch`), close the dialog. `update`'s
comment: *"immediate save, the provider pattern"*. This is the exact wiring a rules section copies
(call it `saveRule(draft)` → `update({ filePolicy: { ...settings.filePolicy, rules: [...] } })` →
close). **This is also where the hazard (§0) makes the rules-save subtle: every save that touches
`filePolicy` — posture OR rules — must carry `rules` through, and every save that touches top-level
keys leaves `filePolicy` whole only because `patch` is a shallow top-level merge.**

### The section body — the empty state + Add button + dialog mount (verbatim)

```tsx
<div className="space-y-3">
  <SettingsGroupCard>
    {Object.keys(settings.mcpServers).length === 0 ? (
      <div className="px-4 py-3 text-ui-base text-foreground-subtle">
        No MCP servers yet — add one to connect an MCP server.
      </div>
    ) : (
      Object.entries(settings.mcpServers).map(([name, entry]) => (
        <McpRow
          key={name}
          name={name}
          entry={entry}
          onEdit={() => setDialog(entryToDraft(name, entry))}
          onRemove={() => onRemove(name)}
        />
      ))
    )}
  </SettingsGroupCard>
  <Button onClick={() => setDialog({ name: "", kind: "http", … })}>
    Add server
  </Button>
  {dialog !== null && (
    <McpDialog
      initial={dialog}
      onSave={onSave}
      onClose={() => setDialog(null)}
    />
  )}
</div>
```

Structure: one `SettingsGroupCard` holding the rows (or an empty-state div) + an Add `Button` below
the card + the dialog mounted **only while `dialog !== null`** (a fresh-draft-per-open is the page
state; a fresh blank `McpDraft` is inlined at the Add click). The rules section mirrors this with
`rules` rows and a rules draft; `key` on rows is the rule's identity (there is no rule id — the rule
**is** `{path, direction, decision}`, so a list key must come from index or a serialized triple; the
spec has no ordering (longest-prefix, not first-match), so row identity is a real choice for the
planner).

---

## 4. `useSettingsDocument` and the save path — full shape

`src/hooks/useSettingsDocument.ts` — the ONE owner of the settings document while Settings is open
(the store owns it; the hook comment cites "finding 13a" and contrasts `useAgentOverridesWrites` for
the Agents modal's different write contract).

### The exported surface — verbatim

```ts
export interface UseSettingsDocument {
  /** The document, straight from the store (`null` until the load lands). */
  settings: AppSettings | null;
  /**
   * The immediate-save pattern: compose `patch` over the document, publish the
   * result to the store, save the COMPLETE document, and re-apply theme + font to
   * the document element. A no-op while the document is `null` (there is nothing
   * complete to save). Never rejects — `saveSettings`' rejection is not observed
   * by any caller today, and adding a rejection would turn every `patch` call
   * into an unhandled rejection in the webview.
   */
  patch: (patch: Partial<AppSettings>) => void;
}
```

### The implementation — verbatim

```ts
export function useSettingsDocument(): UseSettingsDocument {
  // The store IS the state. No local mirror …
  const settings = useSettings((s) => s.settings);
  const themeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void useSettings.getState().loadSettings();
    return () => {
      themeCleanupRef.current?.();
    };
  }, []);

  const patch = useCallback(
    (changes: Partial<AppSettings>): void => {
      if (settings === null) return;
      const next = { ...settings, ...changes };
      useSettings.getState().setSettings(next);
      void saveSettings(next); // the complete document
      themeCleanupRef.current?.();
      themeCleanupRef.current = applySettingsToDocument(next);
    },
    [settings],
  );

  return { settings, patch };
}
```

### The save path, end to end

1. **Load**: hook `useEffect` on mount calls `useSettings.getState().loadSettings()` — the store's own
   loader (`src/store/settings.ts`), which fetches `getSettings()` and publishes. `SettingsPage` reads
   `settings` reactively. (`src/lib/settings.ts` `loadAndApplySettings` is the separate BOOT path —
   not used by the page.)
2. **Edit**: any section calls the page's `update` alias (`const { settings, patch: update } =
   useSettingsDocument();`).
3. **Compose**: `patch` merges `changes` **shallowly** — `{ ...settings, ...changes }`.
4. **Publish**: `useSettings.getState().setSettings(next)` (the app-wide store; the working-indicator
   spinner reads it — a settings change must take effect without a reload).
5. **Persist**: `void saveSettings(next)` — the COMPLETE document, fire-and-forget (never observed,
   never rejects) — `src/lib/tauri/commands/settings.ts` `invoke("save_settings", { settings })` →
   Rust `commands::settings::save_settings` → `config::write_settings` → `fs::write` of the pretty
   JSON. **Overwrite, no merge, no validation.**
6. **Re-apply**: `applySettingsToDocument(next)` (theme + palette + font custom properties, from
   `src/lib/settings.ts`) and replace the theme `matchMedia` cleanup.

### Where a `rules`-preserving write must hook in — precisely

- **The `patch` level (recompose)**: because `patch` is shallow, any patch whose `changes` carries a
  `filePolicy` REPLACES the stored object wholesale. A `rules`-preserving write therefore either (a)
  must never hand `patch` a partial `filePolicy` (the caller composes `filePolicy: { ...settings.filePolicy,
  … }`), or (b) `patch` itself must gain a special case that merges `filePolicy` shallowly. Option (a)
  has a trap: a caller composing from `settings.filePolicy` still needs `settings.filePolicy` to carry
  the CURRENT rules — which it does, because the store is the document and nothing else writes it in
  the UI — but the compose must spread `...settings.filePolicy` (all four keys incl. `rules`) before
  overriding `reads`/`writes`/`shell`. That is exactly the hazard's other half: `savePolicy` builds a
  literal `{ reads, writes, shell }` instead of spreading `settings.filePolicy`.
- **The `savePolicy` level (the moved helper)**: the fix lives inside whatever function rebuilds
  `FilePolicy` — it must keep `rules` (currently it structurally cannot; the three-key literal is the
  bug). Since `PolicyRow`+`savePolicy` move to the new section, the fix lands with the move.
- **The rules-list saves (add/edit/remove/seed)**: each must compose `filePolicy`
  `{ ...settings.filePolicy, rules: nextRules }` — which preserves `reads/writes/shell` automatically.
  **The seed path (§6) is the one that cannot simply "spread"**: on first write there is no stored
  `rules` reason to inspect, and the Rust `Vec::is_empty` skip means an empty array cannot be declared
  "empty but present" — so "only on first write" needs an explicit detection mechanism, which does not
  exist today (see §6).
- **The `useSettingsDocument.test.ts` pins** to be aware of (the "two patches in one batch compose
  from the RENDERED document" pin at line 193) — a change to `patch`'s compose semantics is a pinned
  behaviour (the hook comment calls it "a pinned non-improvement"); making `patch` merge `filePolicy`
  would need that pin's explicit reconsideration, whereas a caller-side spread does not.

`src/lib/settings.ts` itself only owns font/theme application + the boot loader — **no save logic and
no document shape helpers live there** (`applySettingsFont`, `applySettingsToDocument`,
`loadAndApplySettings`). A "first write" helper would be net-new anywhere it lands.

---

## 5. `SettingsPage.test.tsx`

2574 lines, 83 tests, all mocking `@/lib/tauri`'s `getSettings` / `saveSettings` and seeding the
document from the `baseSettings` const at the top (both fixtures carry
`filePolicy: { reads: "allow", writes: "allow", shell: "allow" }` — with NO `rules` key, matching the
wire reality). `saveSettings` assertions read `vi.mocked(saveSettings).mock.calls[i][0] as
AppSettings`.

### The nav-id pin — verbatim (the assertion a new section extends)

```ts
it("the Updates nav button is in the sidebar, after MCP", async () => {
  render(<SettingsPage onBack={vi.fn()} />);
  await loaded();
  const buttons = [...document.querySelectorAll("nav button")].map(
    (b) => b.getAttribute("aria-label") ?? "",
  );
  // The section list, in sidebar order (the render chain's order is this).
  expect(buttons).toEqual([
    "General",
    "Appearance",
    "Providers",
    "MCP",
    "Detached sessions",
    "Web search",
    "Updates",
  ]);
});
```

A `"permissions"` sidebar entry (inserted in any slot) breaks this `toEqual` until the expected array
grows — the pin that forces the nav change to be deliberate. (The button names are the
`aria-label`s, not the visible labels; the `nav`'s label list is unique per button, so
`getByRole("button", { name: … })` navigation works off these strings.)

### The `filePolicy`-related assertions — quoted (and where they live)

1. `the_three_file_access_selects_default_to_don_t_ask_me` — asserts each of `["Reads", "Writes",
   "Shell"]` triggers renders "Don't ask me", and the row-order block (the rows are `.border-t`
   elements, ordered by a local `index(label)` helper):
   ```ts
   expect(index("Reads")).toBeGreaterThanOrEqual(0);
   expect(index("Reads")).toBeLessThan(index("Writes"));
   expect(index("Writes")).toBeLessThan(index("Shell"));
   expect(index("Shell")).toBeLessThan(index("Trust new Spaces by default"));
   ```
   **This block is the layout pin that churns** — the spec moves Reads/Writes/Shell AND the trust
   toggle out of General, so "Shell above the Trust switch" plus "above default model etc." ordering
   constraints must move to the new section's own test (the spec's expected churn note names
   `SettingsPage.test.tsx` rows move).
2. `changing_the_reads_select_to_ask_me_saves_the_complete_document`:
   ```ts
   expect(saved.filePolicy.reads).toBe("ask");
   expect(saved.filePolicy.writes).toBe("allow");
   expect(saved.filePolicy.shell).toBe("allow");
   ```
   (plus a complete-document spread assertion — saved.theme / providers / font). **This test is the
   one that hard-pins the hazard's failure mode**: after this save, a document that ever had
   `rules` would lose them — nothing asserts `rules` today because nothing can have rules yet. The
   next task's new pin is the mirror: a document WITH rules keeps them after a posture change.
3. `a_stored_sandboxed_shell_on_non_linux_does_not_render_an_empty_select` — seeds
   `filePolicy: { reads: "allow", writes: "allow", shell: "sandboxed" }` and asserts the Shell
   trigger reads "Sandboxed (unavailable here)".
4. `a_pre_feature_document_without_file_policy_renders_don_t_ask_me (never an empty select)` — does
   `delete preFeature.filePolicy;` then asserts all three tiers read "Don't ask me". The
   `policy(direction)` `?? "allow"` nullish default is the behaviour pinned.
5. `flipping the toggle saves the complete document with the flag` (the `#` mention toggle) and
   `flipping the naming switch saves the complete document with the flag` — both assert
   `expect(saved.filePolicy).toEqual(baseSettings.filePolicy);` — **these two will start failing the
   moment `baseSettings.filePolicy` gains a `rules` key in its fixture** (or if the fixture grows
   defaults); they are why the fixture's `filePolicy` is the spec-visible seam for the seeded rules.
6. The Writes-copy disclosure test `the_writes_row_discloses_the_carve_out_is_a_guard_rail_not_a_boundary`
   pins the Writes row's copy (guard-rail / not-a-boundary / shell / sudo_exec, plus a long
   anti-overclaim regex) — moves with the row; its `rowOf("Writes")` helper is defined in the
   file-scope helpers (`rowOf`, `openSelect`, `closeSelect`, `optionLabels`, around line 936).

### The `go("MCP")`-style navigation helper — verbatim

```ts
/** Wait for the page's `getSettings` load to land in state (a marker row). */
async function loaded(): Promise<void> {
  await screen.findByText("Default model");
}

/** Navigate to a section (click its sidebar button) and wait for it. */
async function go(
  section: "Appearance" | "Providers" | "MCP" | "Web search",
): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: section }));
  if (section === "Appearance") await screen.findByText("Theme");
  else if (section === "Providers")
    await screen.findByRole("button", { name: "Add provider" });
  else if (section === "Web search")
    await screen.findByText(
      "Configure Search providers and proxy for web_search and fetch_content tools.",
    );
  // The "Add server" button is always in the MCP section (below the card).
  else await screen.findByRole("button", { name: "Add server" });
}
```

Two churn details: the union type must gain `"Permissions"` (a `go("Permissions")` call would be a
type error until then), and the `else` fallthrough awaits the MCP section's "Add server" — the
Detached-sessions describe block has a standing comment that its test deliberately does NOT use `go`
because of exactly this fallthrough, so a new section's `go` arm must be added to the chain BEFORE
the MCP `else`, or the new section's own tests click the button directly like the sessions test does.

### Tests that will churn (named, not summarised — grouped by describe)

- **`SettingsPage (the ZCode port — sections + immediate save)`** describe — the affected tests:
  `renders_the_three_sections_and_the_back_button` (nav assertions, "the default section is
  General"); `the_three_file_access_selects_default_to_don_t_ask_me` (rows now live in the new
  section — the General-scoped assertions move); `the_file_access_rows_state_the_honest_default`;
  `the_writes_row_discloses_the_carve_out_is_a_guard_rail_not_a_boundary`; `changing_the_reads_select_to_ask_me_saves_the_complete_document`;
  `the_shell_sandboxed_option_is_hidden_off_linux`; `the_shell_sandboxed_option_is_greyed_out_when_the_kernel_has_no_landlock`;
  `the_shell_sandboxed_option_is_selectable_when_the_kernel_can_confine`;
  `a_stored_sandboxed_shell_on_non_linux_does_not_render_an_empty_select`;
  `a_pre_feature_document_without_file_policy_renders_don_t_ask_me (never an empty select)`.
  These are the "rows move" churn the spec's Verification section predicts.
- **`SettingsPage (the Updates section — ADR 0053)`**: `the Updates nav button is in the sidebar,
  after MCP` — the nav pin (extends with the new entry). The sessions/web-search describe blocks are
  unaffected structurally (they click their own buttons) except where the `go` union/fallthrough is
  involved.
- **The SettingsPage desktop rows that assert `saved.filePolicy`**: `flipping the toggle saves the
  complete document with the flag` (# mention), `flipping the naming switch saves the complete
  document with the flag` — these assert against `baseSettings.filePolicy` and will extend to the
  fixture's shape.
- **New test file**: `PermissionsSection.test.tsx` is expected (the spec's Verification names it) —
  nothing of that name exists in `src/components/settings/` today (see the dir listing §8).

---

## 6. Pre-filled defaults — "first write" detection

**There is no notion of "has the user ever saved" anywhere in the frontend settings path — and none
in the Rust read path either. This is a genuine design constraint for the spec's "written only on
first write" requirement, not a gap to paper over.**

What exists today, precisely:

- **Frontend**: `useSettingsDocument` mounts with `settings === null`, loads once per mount, and
  `patch` is a no-op while `null`. There is no flag, no timestamp, no "dirty/ever-written" state on
  the hook or the store; `SettingsPage` never remembers past sessions. The store
  (`src/store/settings.ts`) holds `{ settings, loaded }`-shaped state (the hook's doc references
  `marks loaded`) — the only boolean is load-completion, not save-history.
- **Rust load path** (`config.rs` `load_settings`): a MISSING `settings.json` → write the defaults and
  return them; an existing file → parse it (or defaults on corruption). The file-existence check
  (`!path.exists()`) is the ONLY "first time" signal anywhere, and it is not surfaced to the UI — the
  `get_settings` command returns just the `Settings` value, so the frontend cannot distinguish "file
  didn't exist, defaults were written for me" from "file existed and holds defaults".
- **The wire can't help**: `FilePolicy.rules` is `#[serde(default, skip_serializing_if =
  "Vec::is_empty")]` on the Rust side and `rules?: AccessRule[]` on the frontend — "empty" and
  "absent" are byte-identical in the file, so a first-write marker cannot ride on `rules` itself (an
  empty seeded list is indistinguishable from no rules, and a non-empty seed would violate "only on
  first write").
- **Existing precedent to reuse**: the settings READ is the only place the app does
  defaults-when-absent — `policy(direction)`'s `?? "allow"` and `FilePolicy.rules`'s "read it
  nullishly" doc comment. There is no frontend-visible "did the file exist" signal, and no settings
  schema/version key in `AppSettings` (no `settingsVersion`, no `migrated` marker — searched, absent).

Consequence stated plainly for the planner: **the "three rules written only on first write" seeding
cannot be implemented as `if (rules is empty → seed default rules)` on the frontend, because a user
who deliberately deletes all three rules is indistinguishable from a fresh install** (both render
`rules: []`/absent, and neither can be told apart on the wire). Any correct implementation needs a
mechanism that does not exist yet: either a new explicit marker in the document (a `settings.json`
key, which is a wire-shape decision this area cannot unilaterally make and which touches the Rust
`Settings` struct + `skip_serializing` conventions), or a frontend-only "has this install ever saved"
sentinel (localStorage is a candidate but the settings UI deliberately has no such state today), or a
Rust-side seed on file creation (the `load_settings` missing-file branch IS the one place "first write"
is currently detectable — writing the seed rules into the defaults that branch writes would be a
Rust change, out of this area's scope). The report records the constraint; the fix decision belongs to
the planner.

---

## 7. Exact scoped commands (verified this session)

- **`pnpm test`** = `"test": "vitest run"` (root `package.json`) — runs the whole suite:
  153 files / 3240 tests.
- **`pnpm test -- <path>` LEAKS — the filter is NOT applied.** Verified twice: `pnpm test --
  src/components/settings/primitives.test.tsx` ran **153 files / 3240 tests** (identical full-suite
  output); `pnpm test -- src/components/settings/GeneralSection.test.tsx` (a path that doesn't even
  exist as a file here — there is no `GeneralSection.test.tsx` in the tree) also ran the full 153 /
  3240 green. The `--`-passed token is ignored. **Do not use this form.**
- **`npx vitest run <path>` scopes correctly.** Verified: `npx vitest run
  src/components/settings/SettingsPage.test.tsx` → **1 file, 83 tests passed** (25.94 s);
  `npx vitest run src/components/settings/primitives.test.tsx` → 1 file, 16 tests. A single test can
  be scoped further with `-t <pattern>` (the suite's `-t` conventions and per-test `describe` blocks
  make `npx vitest run <file> -t "<test name>"` the targeted form).
- Config note: the vite/test config lives in `vite.config.ts` (`test: { environment: "jsdom",
  globals: true, setupFiles: ["./src/test/setup.tsx"], testTimeout: 20_000 }`) — there is no separate
  vitest config file and no workspace file; a path filter must be a real test-file path or vitest
  falls back to the default include pattern.
- Baseline numbers for the plan: full suite at current HEAD is 153 files / 3240 tests (the spec's
  "152 files / 3203 tests" was the pre-wave-1 baseline; wave 1's `PermissionPrompt.test.tsx` and
  `useChildGates.test.ts` growth accounts for the delta).

---

## 8. Anything already implemented this area needs

1. **Wire types for rules, landed** (`types.ts`): `AccessDirection`, `AccessRule`, `FilePolicy.rules?`
   — exported through `@/lib/tauri` (the barrel was updated in `6fd3740`; `TAURI_PUBLIC_API` updated
   in the same commit). The new section can type its rows/drafts against `AccessRule` today.
2. **The spec's `filePolicy` example key-order/values** (`{reads, writes, shell, rules:[{path,
   direction, decision}]}`) is the shape `AccessRule`/`FilePolicy` already mirror — a rules-row draft
   can be `{ path, direction, decision }` plus a list identity.
3. **`PermissionPrompt` / `useChildGates`** (the prompt side, wave 1) already echo `path` → `value`
   for "allow-directory"; nothing in the Settings area consumes those — the rules list is the
   file-side persistence. Out of this area's scope.
4. **`src/components/settings/` directory contents today** (for the planner's file inventory):
   `AppearanceSection.tsx`, `ClearDetachedSessionsDialog.tsx` (+ test), `GeneralSection.tsx`,
   `McpSection.tsx`, `ProviderSection.tsx`, `SessionsSection.tsx` (+ test), `SettingsPage.tsx`,
   `SettingsPage.test.tsx`, `UpdateSection.tsx` (+ test), `WebSearchSection.tsx` (+ test),
   `controls.tsx` (`Field` etc.), `primitives.tsx` (+ test). **No `PermissionsSection.tsx`**; there is
   also **no `GeneralSection.test.tsx`** (General is tested entirely through `SettingsPage.test.tsx`
   — which is why the rows-move churn concentrates there).
5. **`SettingsGroupCard` / `SettingsRow` / `SettingsDataRow` / `SettingsBadge` / `SettingsSidebarButton`
   / `closedSelectValue` / `openSelectItems`** are exported from `primitives.tsx` and available to any
   new section without new primitives (the rules rows use `SettingsDataRow`; the posture rows use
   `SettingsRow` via `PolicyRow`).
6. **A new section needs no new commands**: rules persist through the existing `save_settings`
   whole-document write; nothing on the Rust command surface (`get_settings` / `save_settings`) has
   per-field endpoints, and the guard-prompt's rule write goes through the Supervisor relay (out of
   this area). The UI-side write is purely `update({ filePolicy: … })`.

---

## Sources

- Files read (all at HEAD `6fd3740`): `docs/roadmap/permissions-section.md`; `src/components/settings/SettingsPage.tsx`; `src/components/settings/GeneralSection.tsx`; `src/components/settings/McpSection.tsx`; `src/components/settings/primitives.tsx`; `src/hooks/useSettingsDocument.ts`; `src/hooks/useSettingsDocument.test.ts`; `src/lib/settings.ts`; `src/lib/tauri/types.ts`; `src/lib/tauri/commands/settings.ts`; `src/components/settings/SettingsPage.test.tsx`; `src-tauri/src/config.rs`; `src-tauri/src/commands/settings.rs`; `src-tauri/src/agent/policy.rs`; `package.json`; `vite.config.ts`.
- Commits: `c90f5dd` (Rust rule model), `6fd3740` (frontend wire types + `keyof FilePolicy` narrow + the recorded hazard), both commit messages read via `git log`/`git show`.
- Commands verified live: `pnpm test` (153/3240 pass, 95.87 s); `pnpm test -- <path>` (leaks — full suite twice); `npx vitest run <path>` (scopes — 1 file / 83 tests; 1 file / 16 tests).