---
feature: permissions-section
task: T05
area: frontend-prompt
wave: 1
status: planned
---

# T05 — Wire types + prompt store + guard-prompt UI (`value` echo, generic options)

SERIAL consumed-mode plan (one commitable unit; the checkboxes carry the internal
sequencing). Grounding: `docs/roadmap/permissions-section-ground-frontend-prompt.md`
(read; not re-derived). Spec: `docs/roadmap/permissions-section.md` (`status: approved`).

## Purpose

Give the frontend the wire contract the spec fixes for the new outcome shape: the
selected outcome gains an optional `value`, a guard prompt's `allow-directory` option
carries `path` (echoed back as `value` by the UI), and `FilePolicy` gains an optional
`rules` list mirroring T01's Rust DTO. The option rendering is already generic
(`prompt.options.map`, first = primary, rest = outline — verified in the tree, see
`PermissionPrompt.tsx:69-79`), so a fourth button needs **no layout work**.

**This task has NO Rust dependency.** T05 runs in parallel with T01 (Rust, disjoint
files) and must not wait on it or on T02 (wave 2). Every test here asserts the **TS
contract**, never the Rust one. If T02's `PermissionOutcome::Selected { option_id,
value }` / per-prompt option lists have not landed, these tests still pass — the
frontend renders whatever the store holds and echoes whatever field is typed. Do not
go looking for a Rust dependency, and do not gate on `cargo` anything.

## Files

Edits land in the owned set and **no other files**:

| File | Edit |
|---|---|
| `src/lib/tauri/types.ts` | Widen `PermissionOutcome` + `PermissionOption`; add `AccessDirection`, `AccessRule`, `FilePolicy.rules` (S1–S2) |
| `src/lib/tauri.ts` | Barrel re-export of the two new type names (S3) |
| `src/lib/tauriBarrel.test.ts` | `TAURI_PUBLIC_API` literal gains the same two names (S3, same step — one without the other reddens) |
| `src/components/PermissionPrompt.tsx` | Respond site echoes `path` as `value` (S4) |
| `src/components/PermissionPrompt.test.tsx` | Rename/rewrite the guard pin; strengthen the two backward-compat pins' matcher to `toStrictEqual` (S5) |
| `src/hooks/useChildGates.test.ts` | Extend the field-set pin with `path` (S6) |
| `src/store/permissions.ts` | **No functional edit** — see Note A |
| `src/lib/tauri/commands/gates.ts` | **No edit** — see Note B |
| `src/hooks/useChildGates.ts` | **No edit** — see Note C |

**Note A — the store is NOT the drop site.** `addPrompt` copies `options: req?.options ?? []`
through **by reference** (`src/store/permissions.ts:32`), so an extra option field
already survives the store today; the field is dropped at the **respond site**, which
rebuilds the wire object from `optionId` alone. The fix is in `PermissionPrompt.tsx`
(S4), and `src/store/permissions.ts` is deliberately **not** touched: `PermissionPromptData`
keeps its shape and `options: PermissionOption[]` picks up `path?` from the type
automatically. Do not "helpfully" re-map options in `addPrompt` — that would destroy
the by-reference pass-through this task relies on.

**Note B — `respondPermission` forwards `outcome` verbatim** (`src/lib/tauri/commands/gates.ts:21-27`):
`invoke("respond_permission", { sessionId, requestId, outcome })`. The widened
`PermissionOutcome` type IS the change; the function needs none. Leaving it untouched
also keeps the barrel-runtime surface (`TAURI_RUNTIME_API` — the 49-function literal)
byte-identical.

**Note C — the subagent path needs no field plumbing.** `childGatesOf` pushes
`options: p.options` under the child's session id **by reference**
(`src/hooks/useChildGates.ts:157-166`), and `ChildGate.options?: PermissionOption[]`
(`useChildGates.ts:47`) widens automatically. The churn is only in the test's
`toStrictEqual` field-set pins (S6), not in the hook.

**Note D — `src/App.test.tsx` needs NO change in this commit.** T05 adds no store
field (`PermissionsState` / `PermissionPromptData` are unchanged) and no *required*
type field, so the trap named in the dispatch does not apply: `App.test.tsx`'s
hand-written fixtures (`filePolicy: { reads: "allow", writes: "allow", shell: "allow" }`
and `options: [{ optionId: "allow", name: "Allow" }]`) still typecheck and its
`usePermissions.getState().addPrompt(...)` call sites are untouched. Do not add a mock
or a field there. (Grounding §7 lists other seeders — `useSessionStatus.test.ts`,
`usePendingSubagentRequests.test.ts`, `useAttentionAlert.test.ts`,
`useHasPendingRequest.test.ts`, `SubagentModals.test.tsx`, `SubagentTranscript.test.tsx`,
`src/test/fixtures.test.ts` — all seed `options: [{ optionId: "allow_once", name: "Allow once" }]`
or empty arrays; because every new field is **optional**, none of those unowned files
churns **from the type change** either. That is a separate claim from the *behavioral*
name-collision risk that S5's triage covers: a runtime `getByRole(..., { name: "Allow" })`
ambiguity is a S5-fixture concern (fix the fixture's names, NOT the unowned file), not a
"this commit changes that file" concern.)

## Steps

- [ ] **S1 — Widen `PermissionOutcome` and `PermissionOption` in `src/lib/tauri/types.ts`**

  Preserve the wire casing exactly. THE WIRE KEYS, SPELLED OUT (do not guess): the
  Rust side is `enum PermissionOutcome` with `#[serde(rename_all = "snake_case")]`
  on the enum — so the **struct-variant key is `selected`**, and the *fields inside
  it* are `option_id` (the field name) and the new `value`. There is NO wire key
  `option_id` at the top level, and `value` serializes as the bare lowercase key
  `"value"` (a field's serde name is its own — it does not nest under anything).
  So the outbound shape is exactly `{"selected": {"option_id": …, "value": …}}`:
  `selected` is the key, `option_id` and `value` are its fields. Inbound option
  fields stay camelCase (`optionId`; `path` is a single word — the spec's "the
  emitted option carries `path`"). Change the `PermissionOutcome` declaration
  (`types.ts:151-154`) from

  ```ts
  export type PermissionOutcome =
    | { selected: { option_id: string } }
    | "cancelled";
  ```

  to

  ```ts
  export type PermissionOutcome =
    | { selected: { option_id: string; value?: string } }
    | "cancelled";
  ```

  and update its doc-comment (`types.ts:148-150`) — mirroring the spec's
  `Selected { option_id: String, value: Option<String> }`: `selected` is the
  struct-variant wire key, `option_id` and `value` are its fields; `value` is
  **absent**, not `null`, when the chosen option carries no `path` (the Rust field
  is `Option<String>` serde-defaulted, and the UI omits the key — S4). The unit
  variant (`"cancelled"`) is untouched.

  Add `path` to `PermissionOption` (`types.ts:156-160`) — do **not** repurpose the
  existing, never-read `kind?: string`:

  ```ts
  export interface PermissionOption {
    optionId: string;
    name: string;
    kind?: string;
    /** The guard prompt's echoed value: the emitted option carries `path`, the UI
     * sends it back as `value` on the selected outcome. Absent for boundary
     * options (posture-`Ask` prompts), which is what keeps those payloads
     * unchanged. */
    path?: string;
  }
  ```

  Run `pnpm test -- src/lib/tauriBarrel.test.ts` — must stay green here (no new
  barrel names yet; this step only widens existing types).

- [ ] **S2 — Add `AccessDirection`, `AccessRule`, and `FilePolicy.rules` in `src/lib/tauri/types.ts`**

  Insert immediately before `FilePolicy` (`types.ts:621`). WHERE THESE TYPES COME
  FROM: they mirror the **SPEC's `settings.json` example**
  (`docs/roadmap/permissions-section.md`, `"direction": "readWrite"`), NOT T01's
  Rust DTO — T01's landed Rust types do **not exist in the tree yet** (zero
  `AccessRule` / `AccessDirection` occurrences under `src-tauri/` today; T01 is the
  Rust rule-model task that introduces them, wave 1, in parallel with this one).
  T01 names the Rust direction enum `RuleDirection`; this TS mirror is named
  `AccessDirection` per the dispatch. Do NOT go hunting for a Rust type to match —
  the SSOT for this TS shape is the spec's example. The rule has three fields
  (`{path, direction, decision}`, decision `allow`|`deny`, direction **required** —
  there is no direction-less rule). Wire casing per the spec's own `settings.json`
  example: `direction` values are serde renames `"read" | "write" | "readWrite"`.

  ```ts
  /** A rule's direction (the Rust `AccessDirection` serde renames). Required —
   * "`/` has read" is direction-specific, so a direction-less rule is an error. */
  export type AccessDirection = "read" | "write" | "readWrite";

  /** One `{path, direction, decision}` exception in `FilePolicy.rules` (mirror of
   * the Rust `AccessRule`, T01). `decision` is exactly `"allow" | "deny"` — there
   * is NO `ask` rule value: an ask is what happens when no rule matches and the
   * guard applies. `path` may carry a leading `~` and may name a directory that
   * does not exist yet (ADR 0081 leniency is load-bearing for rules). */
  export interface AccessRule {
    path: string;
    direction: AccessDirection;
    decision: "allow" | "deny";
  }
  ```

  Add `rules` to `FilePolicy` (`types.ts:621-626`) — **optional**, so existing
  fixtures and stored settings without the key still typecheck and parse (the Rust
  side keeps `#[serde(default)]` on the container, and the pre-feature file has no
  `rules` key at all):

  ```ts
  export interface FilePolicy {
    reads: AccessPolicy;
    writes: AccessPolicy;
    /** `bash`. */
    shell: AccessPolicy;
    /** (permissions-section) `{path, direction, decision}` exceptions, evaluated
     * by longest canonical prefix. OPTIONAL on purpose: a pre-feature
     * `settings.json` has no `rules` key and the backend defaults it to empty, so
     * read it nullishly. Rules NEVER apply to `bash`. */
    rules?: AccessRule[];
  }
  ```

- [ ] **S3 — Barrel: re-export the two new names AND pin them in the barrel literal, in the SAME step**

  Both halves must land together — the barrel guard
  (`src/lib/tauriBarrel.test.ts`) scans the barrel's surface and compares it against
  the hand-written `TAURI_PUBLIC_API` literal, so exporting without the literal (or
  the literal without the export) reddens `"the barrel re-exports the exact pinned
  public API"`.

  1. `src/lib/tauri.ts`: in the `export type { … } from "./tauri/types"` block, add
     `AccessDirection,` and `AccessRule,` adjacent to the existing `AccessPolicy,`
     (placement inside the block is cosmetic — the guard sorts both sides).
  2. `src/lib/tauriBarrel.test.ts`: there is exactly **ONE literal to update** —
     `TAURI_PUBLIC_API` (line ~180), the source-scanned surface the
     `"the barrel re-exports the exact pinned public API"` `toEqual` compares
     against. Insert `"AccessDirection",` and `"AccessRule",` next to
     `"AccessPolicy",`, with the understood comment that a name may only enter this
     list on purpose, in a commit that says so (the file's own header).
  3. `TAURI_RUNTIME_API` is **not a second literal to touch** — it is a runtime
     assertion over `Object.keys(await import("./tauri"))` (`toEqual` against the
     pinned 49 runtime names), and a type-only export never appears there:
     type-only names vanish at runtime, so the 49-runtime-names pin and the
     36-mockers pin are unaffected. The full barrel test file therefore needs
     exactly ONE edit: the `TAURI_PUBLIC_API` literal.

- [ ] **S4 — `src/components/PermissionPrompt.tsx`: echo the option's `path` as `value` at the respond site**

  The option map is already generic and count-agnostic — **confirmed in the tree,
  not assumed**: `PermissionPrompt.tsx:69-79` renders `prompt.options.map((option, i)`
  with `variant={i === 0 ? "default" : "outline"}` and nothing hardcodes three, any
  count, or an option id. A fourth button appears for free; there is NO layout work
  in this task. The only change is the payload literal at `PermissionPrompt.tsx:72`:

  ```tsx
  onClick={() =>
    respond({
      selected: {
        option_id: option.optionId,
        // The guard's `allow-directory` option carries `path`; echo it back as
        // `value`. An option WITHOUT one emits the OLD payload shape (no `value`
        // key at all) so boundary prompts stay byte-identical on the wire.
        ...(option.path !== undefined ? { value: option.path } : {}),
      },
    })
  }
  ```

  The conditional spread is load-bearing, not cosmetic: the acceptance criterion
  requires an option without `path` to produce the OLD payload unchanged, and omitting
  the key is what keeps the serialized `{"selected": {"option_id": …}}` shape
  identical for boundary prompts. `respond` itself (`PermissionPrompt.tsx:53-60`) and
  the `"cancelled"` path are untouched.

- [ ] **S5 — `src/components/PermissionPrompt.test.tsx`: rename/rewrite the guard pin; strengthen the backward-compat pins' matcher**

  The trust-space pin must be rewritten because T05 owns the only frontend file that
  contains a `trust-space` fixture, and the spec removes `trust-space` from the guard
  prompt: the fixture should teach the spec's new guard contract
  (`allow` / `allow-directory` / `reject`), not a contract the run deletes. (The Rust
  emission change itself is T02's, wave 2; this is fixture-and-pin churn only — the
  component still renders whatever arrives.)

  - Change the `it` string
    `"renders one button per option for the 3-option trusted-space payload (guard)"`
    to
    `"renders one button per option for the 3-option guard payload and echoes the allow-directory path back as value (guard)"`.
  - Rewrite the "ZERO component changes" comment (it references "Task 2" appending
    `trust-space`): record that the guard's option list is per-prompt per the spec —
    **trust-space is deliberately absent** from the guard prompt; the component is
    still generic (one button per option, first = primary, rest = outline, no
    hardcoded count), and the new fixture proves the generic renderer handles the new
    ids and the `value` echo with zero layout work.
  - Replace the fixture's three options with the spec's guard ids, `path` on the
    middle one:

    ```ts
    options: [
      { optionId: "allow", name: "Allow", kind: "allow" },
      {
        optionId: "allow-directory",
        name: "Always allow this directory",
        path: "~/.pi/agent",
        kind: "allow",
      },
      { optionId: "reject", name: "Block", kind: "reject" },
    ],
    ```

  - Keep the 4-button count assertion and the class-treatment assertions **as they
    are** (3 options + Cancel still = 4; first `bg-primary`, rest `border-border`) —
    they are fixture-relative, not contract pins.
  - Change the click + respond assertion: click
    `screen.getByRole("button", { name: "Always allow this directory" })` and pin

    ```ts
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r2", {
        selected: { option_id: "allow-directory", value: "~/.pi/agent" },
      }),
    );
    ```

  - **Scope-aware queries where names collide** — the new fixture introduces TWO
    buttons resolving role+name collisions across a page that may render several
    prompts: this test's own `"Allow"` (the `allow` option) and the shared
    boundary fixture's `"Allow"` (from the other tests' `request`), plus the new
    `"Always allow this directory"` next to any "Allow"-named row. In THIS test
    the "Allow" option button is never clicked, but if any rewritten assertion
    needs it, query **container-scoped** — `within(container).getByRole("button",
    { name: "Allow" })` or a container-scoped `getAllByRole` filtered — never a
    page-wide `screen.getByRole` on a collidable name. `getByRole(..., { name:
    "Always allow this directory" })` is unambiguous (no other fixture uses that
    string) and stays a plain `screen` query.

  - **If an unowned test file reddens, the FIX IS THIS FIXTURE, NOT THE FILE.**
    Four files OUTSIDE the owned set seed options with `optionId: "allow"` / name
    `"Allow"` and assert on that name — `src/App.test.tsx:840,1195` (+ the
    `getAllByRole("button", { name: "Allow" })` length-1 pin at 845),
    `src/components/InlineGateRow.test.tsx:91` (+ clicks/keydowns at 152, 313),
    `src/components/SubagentModals.test.tsx:126,247,330,587,611,713` (+ queries at
    131, 338), `src/components/ChatStream.test.tsx:5970,6019` (+ clicks/keydowns
    at 5977, 6026). A guard-prompt fixture introducing an
    "Always allow this directory" button can make a name query resolve to multiple
    matches when a parent renders several prompts, reddening one of those files.
    If that happens: (a) the suspect is THIS fixture's option ids/names — make the
    fixture's names **distinguishable** (e.g. `"Allow (this call)"` / keep the
    unique `"Always allow this directory"`); (b) do **NOT** edit the unowned file
    (it is out of the owned set and out of this commit). Note the fixture values
    are only ever pass-through strings — the component does not branch on names —
    so renaming is behaviour-neutral for the S5 pin as long as the clicked button
    and its pinned payload stay consistent.

  - **Do not touch the fixtures or click logic of**
    `it("calls respondPermission with the selected option id")` or
    `it("sends the second option id when a different option is chosen")`: both click
    options from the shared two-option boundary fixture (no `path`) and must keep
    pinning `{ selected: { option_id: "opt-1" } }` / `{ selected: { option_id: "opt-2" } }`.
    The ONLY change to these two tests is the final matcher: strengthen it from
    `toHaveBeenCalledWith` to **`toStrictEqual`** on the raw argument (see
    criterion 2 — `toHaveBeenCalledWith`'s asymmetric equality would stay green if
    the payload picked up a stray `value` key, which is precisely the regression
    these pins exist to catch). These two tests ARE the backward-compatibility pins
    for "option without `path` → old payload shape"; do not add a redundant third
    one.

- [ ] **S6 — `src/hooks/useChildGates.test.ts`: extend the field-set pin with `path`**

  Change the test
  `"surfaces a child's permission prompt with kind 'permission' and its toolTitle + options"`:
  give its fixture option a `path` and mirror it in the `toStrictEqual` expectation,
  proving the subagent path carries the new field **by reference with no plumbing**:

  ```ts
  prompts.sub1 = [
    {
      requestId: "p1",
      toolTitle: "Run rm -rf /",
      options: [{ optionId: "allow_once", name: "Allow once", path: "~/.pi/agent" }],
    },
  ];
  ```

  and the `toStrictEqual` options expectation becomes the same object with `path`.
  The test's whole-gate `toStrictEqual` comment already states "the FIELD SET is the
  assertion" — extend the field set deliberately. The other two `options` seeds in
  this file are empty arrays (`options: []` in "drops a gate whose child has no
  SubagentEntry…" and "reads the three stores…") and do **not** change; the hook
  module itself is untouched (Note C).

- [ ] **S7 — Scoped tests, then the full gate**

  From the repo root, in this order:

  ```
  pnpm test -- src/components/PermissionPrompt.test.tsx src/hooks/useChildGates.test.ts src/lib/tauriBarrel.test.ts
  ```

  then the two gate legs:

  ```
  pnpm test
  pnpm build
  ```

  Then the full suite runs from the repo root (that is the task's gate); baseline at
  branch HEAD is 153 files / 3240 tests (the spec's "152 files / 3203" is stale — do
  not use it). The suite size should hold at 153 files; this task adds no new `it`
  blocks (one is renamed, two files' fixtures grown). `pnpm build` runs
  `tsc && vite build`, so it is also the strictness pass over the widened types —
  `tsc` must stay clean with the `value?` / `path?` / `rules?` optionals and the
  conditional spread. NOTE: `src/lib/tauriBarrel.test.ts` scans the whole `src/` tree
  with Node `fs`, so it must be run from the repo root, never from a subdirectory.

## Acceptance criterion

Measurable, all four legs — each named by test string, not by count:

1. **Value echo** — the renamed guard test
   `"renders one button per option for the 3-option guard payload and echoes the allow-directory path back as value (guard)"`
   passes: a click on "Always allow this directory" (the option carrying
   `path: "~/.pi/agent"`) yields a respond payload of
   `{ selected: { option_id: "allow-directory", value: "~/.pi/agent" } }`, and the
   mock is asserted with `toHaveBeenCalledWith` on the asymmetric matcher so the
   test body keeps the shape from S5 verbatim (this leg is about the ECHO
   happening and the wire key landing; exact-key strictness is criterion 2's job).
2. **Backward compatibility — a REAL pin, not a tautology.** The unchanged tests
   `"calls respondPermission with the selected option id"` and
   `"sends the second option id when a different option is chosen"` still pass,
   pinning the raw argument with **`toStrictEqual`** (or a `JSON.stringify`
   round-trip) to `{ selected: { option_id: "opt-1" } }` /
   `{ selected: { option_id: "opt-2" } }` — i.e. the two tests' final matcher
   becomes a strict structural compare instead of `toHaveBeenCalledWith`'s
   asymmetric equality (which would still pass if the actual payload carried a
   stray extra key). This is what catches the real regression: if an implementer
   **drops the conditional spread** and always emits `value` (even as
   `value: undefined` — which at runtime serializes/behaves as a present key),
   criterion 2's strict compare reddens on the extra key, while criterion 1 alone
   would stay green. So: criterion 1 catches "path not echoed when present";
   criterion 2 catches "nothing extra emitted when `path` is absent" — two
   genuinely different lenses, not one test named twice. (The conditional spread
   emits the old shape byte-identically; these two tests' strict runs are the
   proof.)
3. **Barrel guard green with the new exports** — `src/lib/tauriBarrel.test.ts`
   passes with `AccessRule` and `AccessDirection` exported through
   `src/lib/tauri.ts` AND present in the `TAURI_PUBLIC_API` literal (the ONE
   barrel-literal edit; both halves landed in S3). The `TAURI_RUNTIME_API` leg
   (and the 36-mockers pin) must stay byte-identical — type-only exports vanish
   at runtime.
4. **No Rust dependency** — the full gate (`pnpm test` + `pnpm build` from the repo
   root, 153 files baseline) is green on the TS contract alone; nothing here imports
   or asserts anything from `src-tauri/`.

## Out of scope

- **T06 (frontend-settings, wave 2)** — the Settings → Permissions section:
  `SettingsPage.tsx` gains the `"permissions"` member, `PermissionsSection.tsx` (new)
  with the rules list, moving the posture rows (`PolicyRow`, currently a module-private
  function in `GeneralSection.tsx:60` — NOT importable today) and the "Trust new
  Spaces by default" toggle out of General, and the bash/trust copy. T05 does not
  touch any `src/components/settings/` file and does not render `rules` anywhere.
- **T02 (permission-wire, wave 2)** — the Rust shape: `PermissionOutcome::Selected
  { option_id, value: Option<String> }`, per-prompt option lists, the approve
  predicate, and dropping `trust-space` from the Rust-emitted guard prompt (including
  the second verbatim prompt literal in `worker/sink.rs`). The TS side already
  reflects that contract (S1–S5); T05 does not change Rust.
- **T04 (supervisor-relay, wave 4)** — persisting an `allow-directory` selection as
  one rule in `settings.json` via the relay. T05 only echoes the `value`; it never
  writes rules.
- **`server`-side / post-write validation of `rules`** — the frontend types the DTO
  (S2) and does not validate rule precedence (longest canonical prefix is T01/T03's
  Rust resolver).
- **`PermissionOption.kind`** — remains typed-but-unread (there is no reader in `src/`
  today); it is deliberately not repurposed for the path, per the dispatch.