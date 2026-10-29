# Grounding — task #101c: the Rust→TS DTO wire for Agent permission rulesets and the **Agents** modal renderer

Branch: `feature/agent-permission-and-pins` (working tree clean at read time, HEAD `2b6bd26`).
Area: **modal-wire** — the TypeScript mirror of `AgentConfigDto` / `OverrideFields` / `SourceFields` (`src/lib/tauri/types.ts`), the `list_agent_config` wrapper (`src/lib/tauri/commands/catalogs.ts`), the barrel (`src/lib/tauri.ts`, ADR 0074), and the **Agents** modal renderer (`src/components/AgentsDialog.tsx` + `.test.tsx`).

> All quotes below are VERBATIM from the tree (paths relative to the repo root, `src-tauri/` where noted). Line numbers are for navigation, not guaranteed stable. No front-matter, in accordance with dispatch.

---

## 1. `src/lib/tauri/types.ts` — the Agent-config wire declarations

### 1a. The file header's conventions (documented IN the file, quoted)

The file opens with this doc-comment, which sets the wire-case conventions and the "one module for all wire shapes" rule:

```ts
/**
 * The TypeScript mirror of the Rust IPC surface: every shape the desktop sends
 * or receives over `invoke` / `listen`, declared ONCE.
 *
 * ONE module rather than a type per command module, deliberately: these
 * interfaces CROSS-CUT. ...
 *
 * Case conventions on the wire (inherited from the file this was split out of):
 * - command arguments: camelCase here (Tauri maps them to snake_case Rust
 *   parameters),
 * - `SessionInfo` (the `start_session` return value): camelCase
 *   (`sessionId`, `cwd`),
 * - event payloads: camelCase (`sessionId`, `requestId`),
 * - ACP update discriminators: snake_case (`agent_message_chunk`, …).
 */
```

Conventions, in order of relevance to this task:

- **Wire types are adapted to camelCase explicitly** (even when the Rust field is snake_case or a keyword — `SessionInfo` is documented as `camelCase (sessionId, cwd)`). The `AgentConfigDto.override` field is the keyword precedent: Rust spells it `override_`, the wire name is `override` (`#[serde(rename = "override")]` in `src-tauri/src/commands/agents.rs`).
- **No `as const` patterns and NO named `AgentScope` type exist in this file.** `grep "as const"` → no matches in `types.ts`; `grep AgentScope` → no matches. `"space" | "user"` is spelled as an inline literal union on every interface that carries scope (see 1b). A new `permission` ruleset type should follow the file's standing approach of a **dedicated camelCase-named interface** (like `AccessRule` / `FilePolicy`, section 5 identity) — there is no "wire enum object" convention here to extend.
- **Re-exports are NOT in this file** — they live in the barrel `src/lib/tauri.ts` (section 2).
- **Never `skip_serializing_if` is documented as the ONLY contract for "always present" fields**: the doc-comments state, repeatedly, that a Rust field without `skip_serializing_if` arrives as `null` (or `[]`) — `… | null`, NOT optional. E.g. `SessionInfo.costUsd` ("PRESENT AND NULL"), `AgentOverrideFields` ("The three `Option`s are serialized ALWAYS PRESENT … so the fields are `… | null`, NOT optional"), and `shadowed` ("REQUIRED, not optional: the Rust DTO always serializes the Vec (empty as `[]`)"). B2's widened DTO fields must be declared against this exact rule, and the task must NOT flag a present-but-`null` / `[]` field as a mock-breaking "required" field (its blast radius is nil — the Rust side always emits the key, see item 4).

### 1b. The Agent-config declarations, VERBATIM (with their doc comments)

```ts
/** One discovered agent definition (camelCase over IPC — the Rust `AgentDefinitionDto`). */
export interface AgentDefinitionDto {
  name: string;
  description: string;
  model: string | null;
  scope: "space" | "user";
}
```

```ts
/** One agent's override (ADR 0066: `settings.json`'s `agentOverrides[<name>]`). An ABSENT field means "this override does not speak" (ADR 0067) — never send `null` to mean inherit. */
export interface AgentOverride {
  model?: string;
  thinking?: string;
  /** An EMPTY list speaks NOTHING (ADR 0067) — no override can zero out a child's tools. */
  tools?: string[];
}
```

```ts
/** `settings.json`'s `agentOverrides` (ADR 0066): agent name → override. One global map — there is NO per-Space map, and keys are matched case-insensitively by the backend. */
export type AgentOverrides = Record<string, AgentOverride>;
```

```ts
/** Which layer supplied a field. `parent` = nothing below the explicit `subagent` param spoke (ADR 0068) — a dispatch that passes the param still overrides it. */
export type OverrideSource = "override" | "file" | "parent";
```

```ts
/**
 * One field-triple of the Agents modal's report (the Rust `OverrideFields`).
 * The three `Option`s are serialized ALWAYS PRESENT — no `skip_serializing_if`
 * — so "this column has no value" arrives as `null` and the fields are
 * `… | null`, NOT optional. That is the deliberate opposite of `AgentOverride`,
 * where absence is the only meaning of "does not speak": these are ROWS of a
 * report the modal renders (as `Inherits parent`), not the stored document.
 */
export interface AgentOverrideFields {
  model: string | null;
  thinking: string | null;
  tools: string[] | null;
}
```

```ts
/** Which layer supplied each of the report's three fields (the Rust `SourceFields`). */
export interface AgentOverrideSources {
  model: OverrideSource;
  thinking: OverrideSource;
  tools: OverrideSource;
}
```

```ts
/** One row of `list_agent_config` (camelCase over IPC — the Rust `AgentConfigDto`). */
export interface AgentConfigDto {
  name: string;
  description: string;
  scope: "space" | "user";
  /** The DEFINITION FILE's path. */
  path: string;
  /** The frontmatter VERBATIM — before any filtering, so the row can say what the file actually said. */
  file: AgentOverrideFields;
  /** The STORED entry VERBATIM (not the resolver's output), so a stale pin stays visible. Rust spells this `override_` (a keyword); the wire name is `override`. */
  override: AgentOverrideFields;
  /** What the dispatch will launch with — produced by the resolver itself. */
  effective: AgentOverrideFields;
  /** Which layer supplied each of those three values. */
  source: AgentOverrideSources;
  /** The entries this name EXCLUDED by shadowing (ADR 0065) — a REPORT
   *  rendered on this row, never a row of its own. REQUIRED, not optional:
   *  the Rust DTO always serializes the Vec (empty as `[]`), exactly like
   *  `SkillInfo.shadowed`, and `SkillsDialog`'s `?? []` tolerance is a
   *  defence for old rows, not a licence to omit it here. */
  shadowed: ShadowedAgent[];
}
```

```ts
/** One Agent definition excluded by **shadowing** (camelCase over IPC — the same
 *  Rust `skills::Shadowed<T>` the Skill row above is). A DELIBERATE two-line NAME
 *  duplicate of `ShadowedSkill`, not a shape duplicate: Rust ships ONE generic
 *  `Shadowed<T>` for both surfaces, but this file names its wire types per
 *  surface (`SkillInfo` / `AgentDefinitionDto`), and reusing `ShadowedSkill` on
 *  an Agent row would make that interface's own doc-comment ("One Skill excluded
 *  by shadowing") a lie. Two lines of structural duplicate is the cheaper lie. */
export interface ShadowedAgent {
  name: string;
  /** Canonical path to the shadowed agent definition file. */
  path: string;
  scope: "space" | "user";
}
```

`Shadowed<T>` itself has NO TS declaration — the file declares the two per-surface `ShadowedSkill` / `ShadowedAgent` interfaces instead (the naming rationale is in `ShadowedAgent`'s doc-comment, quoted above). A new `permission` type would follow the same "name the wire type for its surface" rule.

### 1c. The Rust DTO side (what B2 will widen — current shape)

`src-tauri/src/commands/agents.rs` (VERBATIM, lines 110–197):

```rust
/// The `Option`s are `null` on the wire (no `skip_serializing_if`) — the three
/// columns are ROWS of a report, not the stored document, and "this column has
/// no value" is information the modal renders (as `Inherits parent`) rather
/// than a state ADR 0067 forbids. The store keeps the opposite rule because
/// there, absence is the ONLY meaning of "this override does not speak".
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideFields {
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub tools: Option<Vec<String>>,
}
```

```rust
/// Which layer supplied each of the three fields (ADR 0068's label space:
/// `override` / `file` / `parent`, and NOTHING else). `pub` for the same
/// `private_interfaces` reason as [`OverrideFields`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFields {
    pub model: OverrideSource,
    pub thinking: OverrideSource,
    pub tools: OverrideSource,
}
```

```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigDto {
    pub name: String,
    pub description: String,
    /// `"space" | "user"` (the `AgentScope` Display form).
    pub scope: String,
    /// The DEFINITION FILE's path (the modal prints it; `AgentDefinitionDto`
    /// deliberately omits this one).
    pub path: String,
    /// The frontmatter VERBATIM — before the filter, so the row can say what
    /// the file actually said even when none of it survived.
    pub file: OverrideFields,
    /// The stored override for this name as the SUPERVISOR read it, VERBATIM
    /// (not the resolver's output). ... Named
    /// `override_` in Rust (`override` is a keyword); the wire name is
    /// `override`.
    #[serde(rename = "override")]
    pub override_: OverrideFields,
    /// What the dispatch will launch with — produced by the resolver itself.
    pub effective: OverrideFields,
    /// Which layer supplied each of those three values.
    pub source: SourceFields,
    /// The definitions this name collision EXCLUDED (ADR 0065) — carried
    /// verbatim from `AgentDefinition::shadowed`, which is already a
    /// `Serialize`-deriving `Shadowed<AgentScope>` (camelCase, `{name, path,
    /// scope: "space"|"user"}`). REQUIRED on the wire, not `Option`: the Rust
    /// side always serializes the `Vec` (empty as `[]`), exactly like
    /// `SkillInfo::shadowed` ...
    pub shadowed: Vec<crate::skills::Shadowed<crate::agents::AgentScope>>,
}
```

Key facts for planning: the DTO is **wire-out only** ("Wire-out only (no `Deserialize`)"), and `AgentDefinitionDto` is **deliberately NOT widened** to carry the modal's fields — the `@`-mention picker surface uses it and its own doc-comment in `agents.rs` pins that separation. B2's `permission` field goes on `AgentConfigDto` (+ possibly `OverrideFields`/`SourceFields`), NOT on `AgentDefinitionDto`; the TS mirror of `AgentDefinitionDto` (quoted in 1b) stays four fields.

---

## 2. `src/lib/tauri.ts` barrel + `src/lib/tauri/commands/catalogs.ts` + the barrel guard

### 2a. ADR 0074 (the barrel rule) — `docs/decisions/0074-all-ipc-travels-through-the-tauri-barrel-and-two-modules-are-permanent-exceptions.md`

VERBATIM (status: `accepted`), relevant passages:

> `src/lib/tauri.ts` is a **pure re-export surface** — 189 lines, 14 `export` statements, exactly **107 names** (58 type-only + 49 values), zero `invoke`/`listen` calls — over nine command modules plus `events.ts` and `types.ts` under `src/lib/tauri/`. Production code imports `@/lib/tauri` and nothing else: no file outside `src/lib/tauri/` imports a domain module, and no file outside `src/lib/tauri/` imports `@tauri-apps/api/core` or `/event` **except `src/lib/update.ts` and `src/lib/version.ts`, which are allowlisted forever, by name, with the reason written next to the name.** Both directions are enforced by source scanners: `tauriBarrel.test.ts` guards the INCOMING edges (nothing bypasses the barrel) and `tauriBoundary.test.ts` guards the OUTGOING edges (nothing outside the IPC modules touches the Tauri wire).

> **Why the barrel exists at all: it is a test seam, not a layering preference.** A large set of test files `vi.mock` `@/lib/tauri` **by module path**, and `vi.mock` intercepts only the calls travelling THROUGH the path it was given. Import a domain module directly and every test that mocked that function stops intercepting it.

> **Conclusions — Consequences**: **Adding an IPC command means adding it to a domain module and re-exporting it from the barrel.** A forgotten re-export is caught: the barrel's 107-name surface is pinned as a literal. … **A third parallel IPC module requires a commit that says so.** The allowlist is a literal with per-entry reasons; it cannot grow quietly.

The two permanent exceptions (`src/lib/update.ts`, `src/lib/version.ts`) are NOT relevant to this task — the task adds a TYPE, not a third IPC module — but the rule the planner needs is: **a new exported type must be added to BOTH `src/lib/tauri.ts`'s `export type { … } from "./tauri/types"` block AND to `TAURI_PUBLIC_API` in `src/lib/tauriBarrel.test.ts`** (section 2c), or the barrel guard reddens.

### 2b. `src/lib/tauri/commands/catalogs.ts` — the `list_agent_config` wrapper, VERBATIM

File header (verbatim):

```ts
/**
 * The per-Space CATALOG commands: the fetchers that are handed to the ONE shared
 * row-cache machine (`useSkillCatalog`, `useAgentCatalog`,
 * `useMentionCatalogs` — all through `useCatalogRow`), plus the Agent-config
 * listing that shares their Space-scoping contract.
 *
 * This grouping is Phase C's, measured, not the improvement report's: the report
 * filed all six under `spaces`, but they have nothing in common with Space
 * BOOKKEEPING (`./spaces.ts` — a row, a trusted flag, a delete) and everything in
 * common with each other: one cache, one eviction contract, and one
 * "`spacePath`/`cwd` is `null` for user scope" rule that every command here
 * repeats and no command there has.
 */
```

```ts
/** The effective Agent config for the Space's definitions — the sidebar Agents modal's data source (ADR 0068). `cwd: null` = app-scope (user-level definitions only; the override map is global and unaffected). */
export async function listAgentConfig(
  cwd: string | null,
): Promise<AgentConfigDto[]> {
  return invoke<AgentConfigDto[]>("list_agent_config", {
    cwd: cwd ?? null,
  });
}
```

The wrapper is a one-line `invoke` with a camelCase-to-snake_case arg mapping (`cwd` is single-word so no rename) and a `?? null` pass-through; a widened DTO does not change the wrapper's signature — only the generic `AgentConfigDto[]` payload's shape changes, which needs NO wrapper edit (invoke generics are erased at runtime). The adjacent wrapper `listAgentDefinitionsForSpace` echoes the same Space-scoping contract (`cwd: spacePath ?? null`).

### 2c. `src/lib/tauriBarrel.test.ts` — what it asserts (quotations)

Header (verbatim):

```ts
/**
 * THE `lib/tauri` BARREL GUARD (finding 12a, Task D1) — a source scanner, not a
 * linter, in the shape this repo already runs ...
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS THE ACCEPTANCE CRITERION, NOT A FORMALITY
 * ---------------------------------------------------------------------------
 *
 * `src/lib/tauri.ts` was split by domain into `src/lib/tauri/*.ts`. It survives
 * as a RE-EXPORT BARREL for one reason: **35 test files `vi.mock` `@/lib/tauri`
 * BY MODULE PATH** (34 spreading `vi.importActual` — both counts pinned by the
 * assertion below rather than carried by hand; ...). A `vi.mock` on a module
 * path intercepts only the calls that travel THROUGH that path. So the moment
 * any consumer imports a moved function from `lib/tauri/sessions.ts` directly,
 * every test that mocked it through `@/lib/tauri` **silently stops
 * intercepting — and still passes, against real IPC.** ...
 */
```

The pinned assertions (the two that a new exported type touches), verbatim:

```ts
/** The names a file RE-EXPORTS: `export { a, b as c } from "…"` and
 *  `export type { a } from "…"` and `export * from "…"`. */
const reexportedNames = (file: string): string[] => { ... };
```

```ts
/** --------------------------------------------------------------------------
 * THE PINNED PUBLIC API.
 *
 * The list below is the export set of `src/lib/tauri.ts` measured at the commit
 * BEFORE the split (107 names: 58 types + 49 functions). It is a LITERAL on
 * purpose, for the same reason `tauri.test.ts` pins command names as literals
 * and `ipc/events.test.ts` refuses to read `IPC_EVENTS` back: recomputing the
 * expectation from the file under test makes the guard green on any change. A
 * name may only enter or leave this list on purpose, in a commit that says so.
 * -------------------------------------------------------------------------- */
const TAURI_PUBLIC_API = [ ... ];
```

The `TAURI_PUBLIC_API` array currently contains (relevant entries): `"AgentConfigDto"`, `"AgentDefinitionDto"`, `"AgentOverride"`, `"AgentOverrideFields"`, `"AgentOverrides"`, `"AgentOverrideSources"`, `"ShadowedAgent"`, `"ShadowedSkill"`, `"OverrideSource"`, plus the permissions-section rule-model names `"AccessPolicy"`, `"AccessDirection"`, `"AccessRule"`, `"FilePolicy"` (the last three added "ON PURPOSE per the header above … Type-only — they vanish at runtime, so `TAURI_RUNTIME_API` (the pinned 49) does NOT gain them." — the precedent for how a type-only addition should land).

The assertion that catches a forgotten registration, verbatim:

```ts
  it("the barrel re-exports the exact pinned public API", () => {
    const through = reexportedNames(BARREL);
    const declared = exportedNames(BARREL);
    // Before the split the names are DECLARED in the barrel; after, they are
    // re-exported. Either way the barrel's surface is the pinned set.
    const surface = [...new Set([...through, ...declared])].sort();
    expect(surface).toEqual([...TAURI_PUBLIC_API].sort());
  });

  it("the runtime export set of the barrel is exactly the pinned 49", async () => {
    // The strongest form: what the module ACTUALLY exposes at runtime, which is
    // what `vi.importActual` spreads into the 35 mock factories. A forgotten
    // `export { fn }` here is a `undefined is not a function` in the app and a
    // silently-unmocked IPC call in a test — this catches it at the seam.
    const mod = await import("./tauri");
    expect(Object.keys(mod).sort()).toEqual([...TAURI_RUNTIME_API].sort());
  });
```

Also (all relevant to the plan's shape):

```ts
  it("no file outside src/lib/tauri/ imports a domain module directly", () => {
    // THE guard. See the header for why a violation is green-but-broken.
    expect(directDomainImports()).toEqual([]);
  });

  it("the barrel holds NO implementation — it is a pure re-export surface", () => {
    ...
    expect(src).not.toMatch(/^export type\s+[A-Za-z_]/m);   // only `export type { … } from` re-exports allowed
    expect(src).not.toMatch(/^export \*/m);
  });
```

And the mock-seam count (`37` mockers, `36` spreading `vi.importActual`) — verbatim:

```ts
    // SET SIZE, pinned: 37 files mock the barrel by path. The number may only
    // move when a test file is added or removed, in a commit that says so — this
    // one moved 34 -> 35 when D2 wired `useAgentOverridesWrites` into `SpacesList`
    // and landed its test file, which mocks the barrel the documented way, and
    // 35 -> 36 when #85 added `store/modelCatalog.test.ts` ..., and 36 -> 37 when the Permissions section
    // landed `components/settings/PermissionsSection.test.tsx`, which mocks the
    // barrel the documented way.
    expect(mockers).toHaveLength(37);
```

Implication for the task: if B2's widened DTO introduces a NEW TS type name (e.g. `AgentPermission` / `AgentPermissionRule` — the exact name is B2's wire decision, not this ground report's), that name must (a) be `export type`-ed from the barrel's `types` block, and (b) be added to `TAURI_PUBLIC_API` in this test. **It must NOT be added to `TAURI_RUNTIME_API`** — type-only names vanish at runtime, and the `AccessRule`/`AccessDirection` comment above is the precedent. A type that only EXISTS as an inline property of `AgentConfigDto` (no new top-level name) needs no barrel change at all.

---

## 3. `src/components/AgentsDialog.tsx` — the row structure and where a fourth piece of info goes

### 3a. The row and its props

The component is **prop-driven** (`AgentsDialogProps` = `rows: AgentConfigDto[]`, `noSpaceOpen`, `settings`, `models`, `tools`, `rolledBackWrites?`, `onPatch`, `onClose` — quoted in 1/heading paragraphs of the file). Rows flow through a `CatalogSearchDialog` whose per-row view is `{ row, stored }` (`stored` = the ASCII-fold lookup of `settings.agentOverrides`, resolved at the top of the render, not inside the row callback — the comment says "`renderRow` is a callback, and the `settings === null` arm of the ladder beneath it does not narrow a variable captured by one").

The row itself is `AgentRow` — header (verbatim):

```tsx
/**
 * One definition's row: identity + description, then one line per overridable
 * field (its value, the layer that supplied it, and the control), then the
 * shadowing report.
 *
 * NOT a `role="button"` row: unlike `SkillsDialog`'s rows, clicking an Agent row
 * would have nothing honest to do — the definition is addressed by name from the
 * model's `subagent` call, not from this modal.
 */
function AgentRow({
  row, needle, stored, models, providers, thinkingLevelUnion, tools, edited, onPatch,
}: {
  row: AgentConfigDto;
  ...
}): ...
```

Row skeleton, in DOM order: identity line (`row.name` + `global` cue + `row.path`) → optional description → **stored-pin disagreement line** (conditional) → **Model line** → **Thinking line** → **Tools block** → **`<ShadowReport row={row} needle={needle} />`**. This order is load-bearing for the plan: the model/thinking/tools "field lines" are one `flex` row each (a `w-16` label span, a `runs …` MutedCaption, a `LayerTag`, an `in the file …` MutedCaption, then the control), and the tools block is a two-line cluster (label line + checkbox cluster). A fourth piece of information (the permission ruleset) renders either as a NEW field-line after Tools — before the shadow report — or as a plain-text block below Tools like `ShadowReport`; both precedents exist in the file, and the "where should it go" decision belongs to the planner with these anchors.

### 3b. The `tools` cell, VERBATIM

```tsx
      {/* TOOLS (ADR 0067): the empty state is LABELLED, never silent. Unticking
          everything writes NO key — which is "this override does not speak", not
          "no tools" — so the line says so in words. The cluster is rendered in
          BOTH states (nothing ticked is a reachable, editable state, not a
          read-only one); only the sentence above it changes. `subagent` /
          `list_agents` are stripped by the harness at this layer too, and the
          `tools` prop is the harness's own list, so they never appear here. */}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="w-16 shrink-0 text-ui-sm text-foreground-subtlest">
            Tools
          </span>
          {stored?.tools === undefined ? (
            <MutedCaption className="min-w-0 truncate">
              {/* Two spans, not one interpolated sentence: ADR 0067's labelled
                  empty state has to be findable as ITS OWN text (the
                  `Inherits parent tools` string is what the ADR names, and the
                  test — and a screen reader's announcement — should be able to
                  point at it). */}
              <span>file: {(row.file.tools ?? []).join(", ") || "—"}</span>
              <span> · </span>
              <span>{toolsInheritLabel(row.source.tools)}</span>
            </MutedCaption>
          ) : (
            <MutedCaption className="min-w-0 truncate">
              file: {(row.file.tools ?? []).join(", ") || "—"} · runs:{" "}
              {(row.effective.tools ?? []).join(", ") || "—"} (
              {sourceLabel(row.source.tools, "tools")})
            </MutedCaption>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-16">
          {tools.map((name) => (
            <label
              key={name}
              className="flex items-center gap-1.5 text-ui-sm text-foreground"
            >
              <input
                type="checkbox"
                checked={stored?.tools?.includes(name) ?? false}
                // "tick this override", so the label names what the control
                // actually does (the deleted cluster said `Enable tool …`,
                // which reads as the app-wide enabled-tools toggle — a
                // different setting on a different screen).
                aria-label={`Override tool ${name} for ${row.name}`}
                onChange={(e) =>
                  onPatch(
                    row.name,
                    "tools",
                    e.target.checked
                      ? [...(stored?.tools ?? []), name]
                      : (stored?.tools ?? []).filter((t) => t !== name),
                  )
                }
              />
              {name}
            </label>
          ))}
        </div>
      </div>
```

### 3c. The `model` cell, VERBATIM

```tsx
      {/* MODEL. The three spans are SEPARATE nodes on purpose: the source label
          is the fact ADR 0068 exists to show, so it must be pointable-at rather
          than buried inside a sentence — and the two CONTEXT columns are worded
          `runs …` / `in the file …` so neither of them is the string `override`
          or `file`. A column literally headed `override:` would make any query
          for the `override` SOURCE LABEL trivially true (a test that cannot
          fail); the wording difference is what keeps the pin honest. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="w-16 shrink-0 text-ui-sm text-foreground-subtlest">
          Model
        </span>
        <MutedCaption className="min-w-0 truncate">
          runs {row.effective.model ?? "—"}
        </MutedCaption>
        <LayerTag>{sourceLabel(row.source.model, "model")}</LayerTag>
        <MutedCaption className="min-w-0 truncate">
          in the file {row.file.model ?? "—"}
        </MutedCaption>
        <ModelPicker
          label={`Model for ${row.name}`}
          value={stored?.model ?? ""}
          placeholder="Inherits"
          items={[
            // The composed `provider + "/" + id` keys — the exact call the
            // deleted `SubagentSection` made — plus the "Inherits" item as an
            // `items` entry (NOT a "leading" flag: `ModelPickerDialog` re-sorts
            // items alphabetically by name and DISCARDS caller order, so nothing
            // could lead anywhere). Picking it DELETES the key (ADR 0067).
            ...modelItemsFromCatalog(
              models.map((model) => `${model.provider}/${model.id}`),
              providers,
            ),
            { value: "", name: "Inherits" },
            ...(staleModel !== null
              ? [{ value: staleModel, name: staleModel, disabled: true }]
              : []),
          ]}
          onSelect={(value) =>
            // `""` (the "Inherits" item) maps to `undefined` = DELETE the field.
            onPatch(row.name, "model", value === "" ? undefined : value)
          }
        />
      </div>
```

### 3d. The `thinking` cell, VERBATIM

```tsx
      {/* THINKING (the same three-node shape as Model, for the same reason). */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="w-16 shrink-0 text-ui-sm text-foreground-subtlest">
          Thinking
        </span>
        <MutedCaption className="min-w-0 truncate">
          runs {row.effective.thinking ?? "—"}
        </MutedCaption>
        <LayerTag>{sourceLabel(row.source.thinking, "thinking")}</LayerTag>
        <MutedCaption className="min-w-0 truncate">
          in the file {row.file.thinking ?? "—"}
        </MutedCaption>
        <Select
          value={stored?.thinking ?? ""}
          onValueChange={(value) =>
            onPatch(row.name, "thinking", value === "" ? undefined : value)
          }
        >
          <SelectTrigger aria-label={`Thinking for ${row.name}`} className="w-48">
            <SelectValue placeholder="Inherits" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Inherits</SelectItem>
            {thinkingLevelUnion.map((level) => (
              <SelectItem key={level} value={level}>
                {level}
              </SelectItem>
            ))}
            {staleLevel !== null && (
              // DISABLED, symmetric with the stale MODEL item: ...
              <SelectItem value={staleLevel} disabled>
                {staleLevel}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>
```

### 3e. The shadowed / "Inherits parent" rendering (ADR 0068's layer labels), VERBATIM

The layer-label helpers the task MUST reuse (per the dispatch: "ADR 0068's layer labels must be reused, not reinvented"):

```ts
/** A field's label for the layer that supplied it (ADR 0068's label space).
 *
 * `parent` means "nothing below the explicit `subagent` tool param spoke" — the
 * row does NOT claim the child will inherit, because a dispatch that passes
 * `model:` overrides what this row shows. That is why the rung is worded
 * "Inherits parent" and not "the child inherits". */
function sourceLabel(source: OverrideSource, field: string): string {
  switch (source) {
    case "override":
      return "override";
    case "file":
      return "file";
    case "parent":
      return `Inherits parent${field === "tools" ? " tools" : ""}`;
  }
}
```

```ts
/**
 * The tools row's inherit copy (ADR 0067: the tools control's empty state must
 * be LABELLED, not silent — "an empty picker that implies no tools would be a
 * lie users act on"). With no `tools` key written, the child falls to the next
 * layer, and the wording names it.
 *
 * Anything that is not `file` reads the parent rung, which is ADR 0067's literal
 * copy: the only layers Rust can report beneath an ABSENT override are `file` and
 * `parent`, so a stale `override` (a row fetched before the key was cleared) is
 * the just-cleared state, and "Inherits parent tools" is what the user needs to
 * read there.
 */
function toolsInheritLabel(source: OverrideSource): string {
  return source === "file" ? "Inherits the file's tools" : "Inherits parent tools";
}
```

```ts
/**
 * The shadowing report's heading for one row (ADR 0065: disclosed, never listed).
 *
 * The clause names the WINNER's scope (the CAUSE), never the excluded entry's —
 * the rule `SkillsDialog`'s `shadowGroups` comment earns and this inherits: ... 
 */
function shadowHeading(winnerScope: "space" | "user", count: number): string {
  return `${count} ${count === 1 ? "agent is" : "agents are"} hidden by a ${
    winnerScope === "space" ? "project" : "global"
  } agent with the same name`;
}
```

The `LayerTag` node (the findable source-label element — tests point at it with `within(line).getByText("override")`), verbatim:

```tsx
function LayerTag({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded bg-input px-1 text-ui-xs text-foreground-subtlest">
      {children}
    </span>
  );
}
```

And the shadow report render site (the "plain text under the row" precedent the permission display will most likely mirror — muted text, never a control):

```tsx
      {/* The shadowing report (ADR 0065) — muted PLAIN TEXT under the winning
          row: never a `Button`, never `role="row"`, never clickable, because a
          control naming a loser resolves to the WINNER's file (name, not path,
          is a definition's identity). ... */}
      <ShadowReport row={row} needle={needle} />
```

(Full `ShadowReport` body in the file, lines ~700–772; it renders a `MutedCaption as="p"` heading plus one `text-ui-xs text-foreground-subtlest` line per loser with the loser's name and path.)

ADR 0068's label-space consequences, VERBATIM from `docs/decisions/0068-…-rendered-by-the-dispatch-path-not-the-renderer.md` — the contract that constrains any NEW layer the permission ruleset might add to `source`:

> - **The command calls the resolver with an EMPTY `LaunchConfig`, so `source` names at most three layers.** ... A row's `source: "parent"` therefore means "nothing below the explicit param speaks", not "the child will certainly inherit" — a dispatch that passes `model:` overrides what the row shows. The label is worded for that.
> - **The label space is `override` / `file` / `parent`, and nothing else needs a word.** ...

### 3f. Where a fourth piece of information would go

- The DOM-order anchor is: identity → description → (pin-diff cue) → Model → Thinking → Tools → ShadowReport. A permission display slots either as a new field line after Tools (matching the Model/Thinking "three-node shape" — label span + value + `LayerTag` + source label) or as a muted plain-text block just above `ShadowReport` (matching "the shadowing disclosure at the bottom of the row" precedent, which the pin-diff comment itself calls "PLAIN TEXT like the shadowing disclosure at the bottom of the row"). The test file (section 4) already asserts rows have exactly these blocks; a new block needs the test-file fixture + assertion shape aligned with whichever slot the planner picks.
- If B2 adds a per-agent `permission` with its own `file`/`effective`/`source`-style provenance, the display would need the layer labels — and any NEW `OverrideSource`-like vocabulary must be run past ADR 0068's "label space is `override` / `file` / `parent`, and nothing else needs a word" consequence (a ruleset layer was not in ADR 0068's three and an ADR amendment would be the honest route if it rides `source`).
- NO rule-authoring UI (per dispatch): the block is display-only, which side-steps the biggest row-shape question (no `onPatch` extension needed, no picks/bindings).

---

## 4. `src/components/AgentsDialog.test.tsx` — fixture builders and blast radius

### 4a. The `row()` fixture builder, VERBATIM

```ts
function row(overrides: Partial<AgentConfigDto> = {}): AgentConfigDto {
  return {
    name: "scout",
    description: "Fast recon",
    scope: "space",
    path: "/p/.agents/agents/scout.md",
    // Every column `null` = nothing below the explicit `subagent` param speaks.
    file: { model: null, thinking: null, tools: null },
    override: { model: null, thinking: null, tools: null },
    effective: { model: null, thinking: null, tools: null },
    source: { model: "parent", thinking: "parent", tools: "parent" },
    shadowed: [],
    ...overrides,
  };
}
```

And the `shadow()` fixture, VERBATIM:

```ts
/** One `ShadowedAgent` fixture: an entry the row above it EXCLUDED (ADR 0065).
 *  Its `name` EQUALS its winner's by construction (the name is the dedupe key),
 *  so a fixture must never invent an "unrelated" loser name. */
function shadow(overrides: Partial<ShadowedAgent> = {}): ShadowedAgent {
  return {
    name: "scout",
    path: "/u/.pi/agent/agents/scout.md",
    scope: "user",
    ...overrides,
  };
}
```

### 4b. Blast radius count: how many tests construct a row

- **One** shared `row()` builder (line 21).
- `grep -c "row("` on the file → **24** occurrences; `grep -c "it("` → **27** tests. Occurrences split into: `row(`/`row()`/`rows={[row({…})]}` call sites across **~23 individual construction sites** (all tests EXCEPT the pure-`openDialog()`-default ones — `openDialog()` with no `rows` prop falls back to `rows={props.rows ?? [row()]}` at line 152, and several tests rely on that default singleton).
- **Every** one of the 24 constructions flows through `row()`. So: **one fixture function to update, 24 call sites to re-typecheck, in ONE file** — but they all inherit the builder's update, so the mechanical edit is a single place.

### 4c. Would a NEW REQUIRED field break every test?

- **If the new TS field is REQUIRED on `AgentConfigDto`**: yes for `tsc` across the whole repo — the single `row()` builder fails to typecheck (so all 24 call sites fail to COMPILE, though not 24 separate edits), and the `AgentConfigDto` literal inside `src/lib/tauri.test.ts`'s `listAgentConfig` describe block (section 6) also fails. That is the exact "required field breaks fixtures" hazard `doc types.ts` documents elsewhere (e.g. `SessionInfo.costUsd` is deliberately `?`-optional "because a required field would break `tsc` at every fixture that builds a `SessionInfo`" — quoted in section 1b context).
- **But the Rust side can SIDESTEP it**: B2 should follow the `shadowed` precedent (section 1b) — the Rust DTO "always serializes the Vec (empty as `[]`)", so the TS field is *required* yet *always present* over the wire, and the only upstream cost is updating the two fixture literals (the `row()` builder here and the row literal in `tauri.test.ts`). If B2 instead opts for an `Option`-typed Rust field / `skip_serializing_if`, the honest TS mirror is `permission?: … | null` (the `costUsd`-style precedent), and ZERO tests break on the TS side because the fixtures legitimately predate the field — but then the modal must render nullishly (the "read it nullishly" convention `FilePolicy`/`shadowed` comments use).
- **Net**: the blast radius is bounded to `row()` in `AgentsDialog.test.tsx` + the row literal in `tauri.test.ts` + the `App.test.tsx` `getSettings` mock IF the permission ruleset also appears in `AppSettings.agentOverrides`-adjacent shape (it does NOT per this task's scope — the ruleset rides `AgentConfigDto`, which `App.test.tsx` does not mock, see section 8). If the new field is kept required-and-always-serialized, expect exactly **2 fixture literals** to update; if optional, **0** required edits (the modal stays nullish-tolerant).

---

## 5. Is there an existing pattern-mapping / rule-display component to reuse?

**Yes — the Settings `filePolicy` rules renderer is the ONLY existing rule/policy display, and it is the one to reuse/pattern-match.**

- `src/components/settings/PermissionsSection.tsx` — `PolicyRow` (posture select rows, `AccessPolicy`), `RuleRow` (one `{path, direction, decision}` rule: path + a `SettingsBadge` showing `rule.direction` + the decision as text, Edit/Remove controls), and the `PermissionsDialog` (three-field add/edit). The `RuleRow`'s structure, VERBATIM:

```tsx
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
        ...
```

- The matching TS wire types already exist in `src/lib/tauri/types.ts` and are ADR-0074-visible: `AccessPolicy` (`"sandboxed" | "ask" | "allow"`), `AccessDirection` (`"read" | "write" | "readWrite"`), `AccessRule` (`{ path, direction, decision: "allow" | "deny" }`), `FilePolicy` (`{ reads, writes, shell, rules? }`). These are the closest existing "allow/deny/ask" + "pattern→action map" vocabulary in the frontend, and the `AccessRule` doc-comment even documents leading-`~` / non-existent-directory leniency — directly relevant if B2's per-agent permission patterns are path-ish.
- `SettingsBadge` and `PolicyRow` come from `src/components/settings/` (the Settings group). **Nothing in `AgentsDialog.tsx` or the Agents row currently imports from `settings/`** — `AgentsDialog` imports only `ModelPicker`, `CatalogSearchDialog`, `MutedCaption`, `modelItemsFromCatalog`, `ui/button`, `ui/select` and `lib/agentOverrides`. Whether a new permission display inside the Agents row reuses `SettingsBadge` (an import reach across the settings/ui boundary — `classNameConvention`-safe since it's a component import, not an IPC import) or renders its own badge span is a planner call; `MutedCaption`/`LayerTag` inside the row are the in-file building blocks.
- Shell/permission-prompt gating UI (`PermissionPrompt.tsx`, `InlineGateRow.tsx`, gate cards) is a DIFFERENT surface — runtime per-call prompts, NOT a ruleset display; grep shows no reuse candidate there for a static ruleset list.

Named candidate for the pattern story: **`PermissionsSection`'s `RuleRow` + `AccessRule`/`AccessDirection`** (for the "pattern → action" half), plus the **`ShadowReport`** block in `AgentsDialog.tsx` itself (for the "muted plain-text block under the row" half).

---

## 6. `src/lib/tauri.test.ts` — what it pins about the DTO shapes

The `listAgentConfig` describe block (full, verbatim — it is the ONLY place the TS side pins the AgentConfigDto wire shape):

```ts
describe("listAgentConfig (the sidebar Agents modal's IPC boundary, ADR 0068)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("invokes `list_agent_config` with the `cwd` argument key", async () => {
    mockedInvoke.mockResolvedValue([]);
    await listAgentConfig("/p/space");
    // Same trap as `list_space_files` above: Tauri maps a camelCase arg KEY to
    // the snake_case Rust parameter, and `listSkills` proves the rule costs a
    // rename (its Rust `space_path` is sent as `spacePath`). `cwd` is ONE word,
    // so it must stay `cwd` — `cwdPath`/`spacePath` here is a runtime-only
    // failure no Rust test can see (the Rust tests call `agent_config`
    // directly, never over IPC) and no hook test can see (Task 5 mocks THIS
    // wrapper). `listAgentDefinitionsForSpace` is the neighbouring precedent
    // for the exact same key on the same-shaped command.
    expect(mockedInvoke).toHaveBeenCalledWith("list_agent_config", {
      cwd: "/p/space",
    });
  });

  it("sends `cwd: null` for the app-scope call — NEVER an omitted key", async () => {
    mockedInvoke.mockResolvedValue([]);
    await listAgentConfig(null);
    // `cwd` is `Option<String>` on the Rust side, so an ABSENT key would also
    // deserialize to `None` — which is exactly why the explicit `null` is
    // asserted as a CONTRACT and not as a necessity: it is what the
    // neighbouring wrappers do (`{ cwd: spacePath ?? null }`), and a future
    // `cwd ? { cwd } : {}` would silently change the wire shape.
    // `toHaveBeenCalledWith` already distinguishes `null` from absent; the `in`
    // check says it out loud, as the `externalOpen` pin above does.
    const args = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(mockedInvoke.mock.calls[0][0]).toBe("list_agent_config");
    expect("cwd" in args).toBe(true);
    expect(args.cwd).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("list_agent_config", {
      cwd: null,
    });
  });

  it("returns the rows UNCHANGED (no reshaping of the report)", async () => {
    // The row shape is pinned here rather than left to the modal's tests,
    // because every name below crosses IPC: `override_` in Rust (a keyword)
    // ships as `override`, and the three column structs serialize their
    // `Option`s ALWAYS PRESENT as `null` (no `skip_serializing_if`) — which is
    // why the TypeScript fields are `string | null` and not optional. A rename
    // on either side is invisible to both suites and shows up as a modal that
    // renders "Inherits parent" for a value the file actually set. The payload
    // is a REAL serialized row (ADR 0068's `shadowed` included, required and
    // empty-as-`[]`).
    const row: AgentConfigDto = {
      name: "scout",
      description: "Fast recon.",
      scope: "space",
      path: "/p/scout.md",
      file: { model: "fake/m1", thinking: null, tools: null },
      override: { model: null, thinking: null, tools: null },
      effective: { model: "fake/m1", thinking: null, tools: null },
      source: { model: "file", thinking: "parent", tools: "parent" },
      shadowed: [{ name: "scout", path: "/u/scout.md", scope: "user" }],
    };
    mockedInvoke.mockResolvedValue([row]);
    await expect(listAgentConfig("/p/space")).resolves.toEqual([row]);

    // And the column is read as `override`, never Rust's `override_` (a
    // keyword): this compile-time field access IS the pin — a TS type that
    // declared `override_` would not type-check here, and the modal's editor
    // would read a column that never arrives.
    const [out] = await listAgentConfig("/p/space");
    expect(out.override).toEqual({ model: null, thinking: null, tools: null });
    expect(out.source.model).toBe("file");
    expect(out.shadowed).toHaveLength(1);
  });
});
```

So the file pins (a) the command name `list_agent_config`, (b) the `cwd` arg key incl. explicit `null` pass-through, and (c) the row shape via the literals above. The third test is where a new always-present `permission` field (or a new shape on `file`/`effective`) typechecks at compile time — the comment "no reshaping of the report" is exactly the pin B2's TS mirror must stay consistent with. Note the fixtures here use `source` values in `["file","parent","override"]` and `shadowed` as an arr — same shape as `row()` in 4a.

---

## 7. Exact frontend gate commands + scoped vitest run

From `package.json` (`"packageManager": "pnpm@11.7.0"`, `pnpm-lock.yaml` present):

```json
  "build": "tsc && vite build",
  "test": "vitest run"
```

- Full gate: **`pnpm test`** (= `vitest run`) and **`pnpm build`** (= `tsc && vite build`).
- Scoped run for just the modal: **`pnpm exec vitest run src/components/AgentsDialog.test.tsx`** (this file is self-contained — prop-driven, no IPC mock, see section 4).
- The barrel guard after a type addition: **`pnpm exec vitest run src/lib/tauriBarrel.test.ts`** before running the whole suite (the pinned-API assertion in section 2c is the fast fail).

---

## 8. The AGENTS.md trap: `src/App.test.tsx`'s `vi.mock("./lib/tauri")` spread

### 8a. What the factory is and why the trap applies

`src/App.test.tsx` line 40 (verbatim):

```ts
vi.mock("./lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./lib/tauri");
  return {
    ...actual,
    ...
  };
});
```

The file's own header comment names the trap (verbatim, lines ~29–39):

```ts
// THE TRAP THIS FILE'S SHAPE SETS. Because the factory spreads `importActual`,
// a boot fetch NOT listed below resolves to the real wrapper, which rejects
// outside a webview — the boot `Promise.all` then rejects, its `.catch` swallows
// the reason, and every test in this file goes red looking unrelated. Add the
// mock in the same commit that adds the fetch.
```

Consequence for the task: **adding a new RUNTIME export to the `./lib/tauri` surface (a new command wrapper) that `App` (or anything `App` mounts) actually calls at boot requires a mock entry in this factory.** But this task adds only a TYPE + a renderer change; `listAgentConfig` is NOT mocked in `App.test.tsx` today (verified: `grep -n listAgentConfig src/App.test.tsx` → `NOT mocked`), and the modal is not part of App's boot path — Agent rows fetch only when `SpacesList` mounts the dialog's `AgentsDialog` site, gated by `settings &&`, and any fetch failure is caught by `useCatalogRow`'s `.catch` (log + degrade-to-`[]`, `src/hooks/useCatalogRow.ts:96`). So:

- **No `App.test.tsx` change is required for `#101c`'s TS-mirror scope** unless B2 also adds a NEW runtime wrapper for a NEW command (it does not — `list_agent_config` already exists and is mocked nowhere in App tests because nothing in `App`'s boot path calls it). The one caveat: a `getSettings` payload shape change (a `permission` key inside `AppSettings.agentOverrides`) WOULD require updating the `getSettings` return literal in this factory (section 6/8c). Per this task's scope the ruleset rides `AgentConfigDto`, not `AppSettings`, so that is out of scope — flagging it so the planner does not get surprised if B2's wire design differs.

### 8b. What this file currently mocks for agent commands

- **`listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([])`** — mocked, with the comment "The three `useMentionCatalogs` fetches (`ChatStream`'s composer catalogs) … must be mocked here: the factory spreads `importActual`, so an un-mocked export still calls the REAL `invoke`, which rejects in jsdom".
- **`listAgentConfig`: NOT mocked** (see 8a) — because App's boot path never calls it; `useAgentCatalog` is invoked from `SpacesList`'s dialog mount only.
- **`getSettings`** IS mocked with a full `AppSettings` literal (29 lines inline, including `agentOverrides: {}` and `filePolicy: { reads: "allow", writes: "allow", shell: "allow" }`), and **`saveSettings: vi.fn().mockResolvedValue(undefined)`**.
- `listSkills`, `listMcpServersEffective`, `listSpaceFiles`, `listCompletionEntries` are mocked (the three `useMentionCatalogs` fetches), plus every `listen*` registration resolving a no-op unlisten, `startSession`, `attentionArm`/`Disarm`, `externalOpen`, `getWindowState`, `sessionRecency`. Verbatim comment on the group: "The three `useMentionCatalogs` fetches (`ChatStream`'s composer catalogs). They MUST be mocked here: the factory spreads `importActual`, so an un-mocked export still calls the REAL `invoke`, which rejects in jsdom (`window.__TAURI_INTERNALS__` is undefined) and the hook logs `"<name> failed:"` — 11 lines of stderr noise per test in this file (green-but-noisy tests hide a real fetch failure)."

---

## 9. Anything already implemented toward this — the grep and its result

`grep -rn "permission" src/ --include="*.ts" --include="*.tsx" -i` (all of `src/`), after removing the runtime-permission-prompt/gate matches (`PermissionPrompt`, `PermissionRequest`, `request_permission`, gate stores, `InlineGateRow`, `SubagentModals`, `responses/permission-request` event plumbing):

- **On the agent-config path: NOTHING.** No `AgentConfigDto` / `AgentOverrideFields` / `OverrideFields` / `SourceFields` / `AgentOverride` / `AgentDefinitionDto`-adjacent file references a `permission`, `allow`, `deny`, or `policy` concept. The only `allow`/`deny`/`policy` hits in `src/` are the Settings `filePolicy` machinery: `src/lib/tauri/types.ts` (`AccessPolicy`, `AccessDirection`, `AccessRule`, `FilePolicy` — section 1/5), `src/components/settings/PermissionsSection.tsx`/`.test.tsx` (the rules UI), plus settings-store spread sites.
- **On the Rust side** (`src-tauri/`): `src-tauri/src/commands/agents.rs` currently has NO permission field (section 1c — the DTO is exactly the five fields quoted); the last commit `2b6bd26` ("Permissions: the agent's own dirs become an ask, plus a rule model (#119)") touched the **file-access** permission surface (`FilePolicy` rules), NOT per-agent tool rulesets. Grep for a `permission` field on `AgentConfigDto`/`OverrideFields` → **no matches anywhere in the tree**.
- Net result: **this task starts from zero on the agent path.** The only pre-existing vocabulary worth borrowing is Settings' `AccessPolicy`/`AccessRule` (types) + `PermissionsSection`'s `RuleRow` (display) — item 5.

---

## 10. Is there a Rust↔TS wire-shape/contract test? — PLAINLY: NO

Searched: `src/lib/tauri.test.ts` (mocks `@tauri-apps/api/core` and pins the TS side only), `tauriBarrel.test.ts`, `tauriBoundary.test.ts` (import-graph scanners, not shape checkers), every `src/**/*.test.ts(x)` and the Rust test suites (`src-tauri/src/commands/agents.rs` tests call `effective_catalog` / `agent_config` directly with the Rust DTO). Findings:

- **Nothing cross-checks the Rust serde DTO against the TS `types.ts` declarations.** There is no compile-time wire-shape pin (no serde test that consumes the TS type, no TS test that parses a Rust-produced serialized buffer — the frontend mocks `invoke` at the module boundary, and the Rust tests never emit IPC).
- Every boundary test on the TS side pins only *wrapper call shapes* (`invoke("list_agent_config", { cwd })`) or *self-consistent fixture literals* against the TS type — the `tauri.test.ts` "returns the rows UNCHANGED" test documents that "a rename on either side is invisible to both suites and shows up as a modal that renders 'Inherits parent' for a value the file actually set" — i.e. the repo KNOWS there is no cross-check and relies on the DTO doc-comments as the contract.
- **Therefore #101c cannot be verified independently.** The TS mirror, the `row()` fixture, and any new modal render assertions would be written against a guessed wire shape unless B2 lands first and this task's author reads the ACTUAL widened `AgentConfigDto`/`OverrideFields`/`SourceFields` in `src-tauri/src/commands/agents.rs`. This task MUST be planned strictly after B2 (the dispatch's premise), and the planner should make "read B2's final serde shape and mirror it field-for-field" an explicit task-0 step, with the `tauri.test.ts` row-literal and the `row()` fixture as the two ground-truth anchors to update.

---

## Sources (all read from the tree)

- `src/lib/tauri/types.ts` (AgentConfigDto, AgentOverrideFields, AgentOverrideSources, AgentOverride, AgentOverrides, OverrideSource, ShadowedAgent, ShadowedSkill, AgentDefinitionDto, AccessPolicy/AccessDirection/AccessRule/FilePolicy; file-header conventions)
- `src/lib/tauri/commands/catalogs.ts` (`listAgentConfig` wrapper + file header)
- `src/lib/tauri.ts` (barrel re-export surface)
- `src/lib/tauriBarrel.test.ts` (`TAURI_PUBLIC_API`/`TAURI_RUNTIME_API` pins, the pinned-API + runtime-set + direct-import assertions, mock-seam counts 37/36)
- `src/lib/tauri.test.ts` (the `listAgentConfig` describe block)
- `src/components/AgentsDialog.tsx` (`AgentRow`, `sourceLabel`, `toolsInheritLabel`, `shadowHeading`, `LayerTag`, tools/model/thinking cells, `ShadowReport`, `storedPinDiff`, props)
- `src/components/AgentsDialog.test.tsx` (`row()`, `shadow()`, `openDialog`, `renderControlled`, 27 tests / 24 `row(` sites)
- `src/components/SpacesList.tsx` (the `AgentsDialog` render site, `useAgentCatalog` usage)
- `src/hooks/useAgentCatalog.ts`, `src/hooks/useCatalogRow.ts` (fetch cache, rejection handling)
- `src/components/settings/PermissionsSection.tsx` (`PolicyRow`, `RuleRow`, `PermissionsDialog`; the only rule-display UI)
- `src/App.test.tsx` (the `vi.mock("./lib/tauri", …)` factory + header comment; `listAgentConfig` NOT mocked)
- `src-tauri/src/commands/agents.rs` (current `OverrideFields` / `SourceFields` / `AgentConfigDto`)
- `docs/decisions/0074-all-ipc-travels-through-the-tauri-barrel-and-two-modules-are-permanent-exceptions.md`
- `docs/decisions/0068-the-agents-modal-effective-config-is-resolved-by-the-dispatch-path-not-the-renderer.md`
- `package.json` (`build` = `tsc && vite build`, `test` = `vitest run`, packageManager `pnpm@11.7.0`)