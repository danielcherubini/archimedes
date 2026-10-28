---
task: T06
feature: permissions-section
status: planned
target: docs/roadmap/permissions-section-task06-settings-permissions-section.md
grounding: docs/roadmap/permissions-section-ground-frontend-settings.md
spec: docs/roadmap/permissions-section.md (status: approved)
---

# T06 — Settings gains a Permissions section: the rules list, the posture rows and trust toggle move out of General, and the honest bash/trust copy

## `## Parallelisation` verdict

**SERIAL — one commitable unit, no sub-task decomposition, no `**Parallel:**` lines.** Every step lands
in the same five-file owned set with no intermediate commit staking out a claim on a sub-set: S1 (the
moves) and S2 (the new section) are one atomic unit — the moves delete `PolicyRow`'s three usages and the
trust row from `GeneralSection.tsx` while S2 re-homes them; any subset leaves a broken import or a page
that no longer renders a moved row. The `Steps:` checkboxes below carry the internal sequencing, with the
`GeneralSection.tsx` deletion and the `SettingsPage.tsx` new-arm as the two moments that cannot be
interleaved with a green run — and the page's nav/type/arm triple must land together for exactly the
reason the grounding names: the section ternary's final `: updatesSection` arm is a catch-all, so an
unmapped `"permissions"` renders the Updates page. The union member type-checks on its own — nothing
flags the miss at compile time; only the render-arm pin catches the silent runtime fall-through (the
arm's NOT-leg asserts the Updates content is absent while Permissions is selected).

---

## Why this task exists (sixth-gate check, one paragraph)

The wire model for rules is already in the tree (`AccessRule`, `AccessDirection`, `FilePolicy.rules?` —
wave 1, `6fd3740`), the three posture selects and the trust toggle still live in General with the
`PolicyRow` helper that **silently deletes a user's rules** on every save (the known hazard the previous
wave's commit message explicitly deferred to T06), the spec's honest `bash` scope copy and the rewritten
Trust copy (trusting a Space now also silences the self-modification guard) exist nowhere in the UI, and
the catch-all section ternary makes the new section's render arm structurally load-bearing. Without this
task, a user who grants "Always allow this directory" at a guard prompt and then changes one posture select
loses that rule invisibly — the wire cannot even show the loss (`#[serde(default,
skip_serializing_if = "Vec::is_empty")]`: empty and absent are byte-identical in `settings.json`). The
render arm fails at runtime, not at compile time (the `"permissions"` union member type-checks; the
ternary's catch-all is what silently renders Updates) — which is why the arm pin below adds a NOT-leg.

---

## The three grounded decisions that drive this plan (addressed explicitly)

*Four decisions now drive the plan: Decision 1 (the rules-carrying `savePolicy` + how the callbacks
compose, honestly recorded), Decision 2 (the default-rules offer — a spec deviation worth flagging, with
its re-appearing behaviour chosen and pinned), Decision 3 (the module-private `PolicyRow` copy + which
moved tests carry per-test overrides), and Decision 4 (the re-appearing default-rules offer, separately
anchored so the S2 pin and the Risks entry can name it).*

### Decision 1 — The silent-data-loss hazard is fixed at the **`savePolicy`** reconstruction (cheap, in an owned file), and made a PINNED behaviour.

The full chain (grounding §0): `savePolicy` rebuilds `FilePolicy` from exactly three keys, `patch` does a
top-level shallow merge, so touching Reads/Writes/Shell replaces the whole `filePolicy` object and drops
`rules` — invisible on the wire because the Rust field is `skip_serializing_if = "Vec::is_empty"`. The fix
is **inside the moved `savePolicy`**: spread the stored `settings.filePolicy` (all four keys, including any
`rules`) before overriding the one changed direction —

```ts
const savePolicy = (direction: "reads" | "writes" | "shell", value: AccessPolicy) => {
  const current: FilePolicy = { ...settings.filePolicy, reads: policy("reads"), writes: policy("writes"), shell: policy("shell") };
  onSave({ filePolicy: { ...current, [direction]: value } });
};
```

Why here and not at `patch`: the grounding is explicit that changing `patch`'s compose semantics is a
**pinned behaviour** — `useSettingsDocument.test.ts:193` pins "two patches in ONE batch compose from the
RENDERED document (a pinned non-improvement)", and the hook's own comment calls the shallow-merge "a
pinned non-improvement". A caller-side spread (option (a)) needs no pin reconsideration and lands in a file
this task owns. **This is a PIN, not a hopeful side effect**: a test that saves a posture select on a
document whose `filePolicy.rules` is non-empty and asserts the rule list survives the save (the new
section-level test `"a posture save keeps an existing rule list (changing the reads select preserves rules)"`
in S2, mirrored by the rewritten `changing_the_reads_select_to_ask_me_saves_the_complete_document` at the
page/whole-document level in S2b).

**The honest residual — how `savePolicy`/`saveRule`/`removeRule` compose (recorded, per review):** all
three callbacks build their patch from `settings`, the LAST-RENDERED document — the same rendered-document
compose `useSettingsDocument.patch` uses and its two-patches pin (`useSettingsDocument.test.ts:193`)
records. Rendered-document compose is the CHEAP option (no new mechanism, no store/ref read, no pinned
behaviour to touch) and matches the hook's semantics; the residual is a staleness WINDOW: two writes
delivered in one render batch compose from the same document, so the second save drops the first — the
interleave. **The two-write test in S2b is what makes that residual OBSERVABLE rather than assumed-safe.**
The fix does not extend to the window (see Risks — the interleave pin).

### Decision 2 — "Pre-fill on first write" has NO mechanism, and none is invented. Chosen: **pre-fill the DRAFT, surfaced as an explicit user-visible action.**

The grounding proves there is no save-history state, no version marker, and the ONLY first-time signal
(Rust's `load_settings` missing-file branch) is not surfaced to the UI. An automatic write needs a
mechanism that does not exist (a new `settings.json` key = a wire-shape decision touching the Rust
`Settings` struct — out of this area; or a frontend sentinel the settings UI deliberately has no precedent
for). Worse, the wire makes "first write" undetectable: `rules: []`/absent are byte-identical, so a user
who deletes all three rules is indistinguishable from a fresh install. And the spec's own example says an
automatic pre-fill would **add one real restriction to existing installs** (`~/.pi/agent read deny` — the
other two rules `~` rw `allow` and `/` r `allow` change nothing at the default posture) — exactly what
"written only on first write so an existing install never silently gains a restriction" forbids.

**Chosen: the three defaults are offered as an explicit user-visible action in the panel, pre-filling the
DRAFT only.** **This is a spec deviation worth flagging — the phrase belongs to the status file**: the
spec's "three default rules written only on first write" is delivered as a deliberate, one-click user
action instead of an automatic write. The deviation IS the button; no rules are ever written without an
explicit click. The panel's empty state renders a short copy explaining the three default rules (reusing the
spec's own table's honesty: two of the three change nothing at the default posture; the third — `~/.pi/agent`
read `deny` — covers `~/.pi/agent/auth.json`, which today sits outside the boundary and is refused only
under `reads: Sandboxed`), with a single **"Add default rule"** button that sets the add-rule dialog's
draft to the deny rule (and an in-panel hint that the two `allow` defaults exist only to document
the real state and can be skipped). A user OF AN EXISTING INSTALL gets a deliberate action, not a silent
write; the requirement is recorded as a limitation, and the rest of T07's docs-bearing follow-up carries
the note. **The `deny` row is labelled in the UI as a default that can be deleted** (the spec's own
requirement), so it never reads as hidden behaviour. (The "Add default rule" affordance keeps the section
self-contained: no new commands, no wire change — the draft and the panel copy live entirely in the new
`PermissionsSection.tsx`.)

**The re-appearing offer is DECIDED + PINNED behaviour (see the pin in S2).** The offer gates on
`(rules ?? []).length === 0`, which cannot distinguish "never seeded" from "the user deleted all rules" —
the same empty/absent byte-identity above — so the offer REAPPEARS after a user clears the list. Chosen:
**(a) accept it**, state it plainly, and pin it. A page-local "offer seen" flag (option (b)) would be
cheap in code but is the settings UI's first state sentinel (no precedent), and it buys nothing: the copy
already labels the deny rule "a default you can delete", re-adding a deleted default is harmless, and the
offer is one button on an otherwise-empty card — re-appearing there is honest, not nagging. **Recorded in
Risks either way; the chosen (a) is pinned by the named test.**

### Decision 3 — `PolicyRow` is module-private, so it is **copied verbatim into `PermissionsSection.tsx`** (the spec's "moves intact"), and `hideSandbox`-unchanged is proven by MOVING the tests that exercise it.

`PolicyRow` (`GeneralSection.tsx:60`) is NOT exported; "moves intact" is a verbatim copy of the component
into the new section's module (an export would change `GeneralSection`'s surface — this task chooses the
copy). The subtle `hideSandbox` / `sandboxDisabled` handling (Shell off Linux; "Sandboxed (unavailable
here)") ships inside the copy UNCHANGED — the copy is byte-identical apart from the `policy`/`savePolicy`
refactor in its harness, which is the precise enabler of Decision 1. Proof of unchanged behaviour: the four
tests that exercise those rows — `the_shell_sandboxed_option_is_hidden_off_linux`,
`the_shell_sandboxed_option_is_greyed_out_when_the_kernel_has_no_landlock`,
`the_shell_sandboxed_option_is_selectable_when_the_kernel_can_confine`,
`a_stored_sandboxed_shell_on_non_linux_does_not_render_an_empty_select` — MOVE with the rows into the new
`PermissionsSection.test.tsx` (their `it` strings unchanged, their bodies unchanged except where a save
assertion gains the rules-preservation pin), and the new section receives the SAME two props
(`shellSandboxAvailable={platform === "linux"}`, `shellSandboxSupported={sandboxSupported === true}`) from
the page. The two `getAppInfo` overrides and the `shellSandboxAvailable` mock already mock at
`@/lib/version` / `@/lib/tauri` level, so they work identically from the new test file.

**Two of the moved tests are NOT identical bodies — they MUST carry their own per-test overrides.**
`the_shell_sandboxed_option_is_hidden_off_linux` (`SettingsPage.test.tsx:1099`) and
`a_stored_sandboxed_shell_on_non_linux_does_not_render_an_empty_select`
(`SettingsPage.test.tsx:1165`) each begin with
`vi.mocked(getAppInfo).mockResolvedValueOnce({ version: "0.1.0", platform: "windows" })`
(verified at lines `:1102` and `:1172`), and the greyed-out test carries its sibling
`vi.mocked(shellSandboxAvailable).mockResolvedValueOnce(false)`
(`:1125`). The new test file's scaffold pins `platform: "linux"` — **the scaffold default does NOT
relieve the moved tests of their overrides**: an "identical-bodies-except-the-named-additions" copy
that dropped them would assert "Sandboxed (unavailable here)" / two-tier options under a Linux platform
and go RED. Both tests move with their per-test overrides intact, verbatim.

### Decision 4 — The default-rules offer **re-appears after a user deletes all rules**, and that is CHOSEN + PINNED behaviour (option (a) of the reviewer's framing).

The offer's predicate `(rules ?? []).length === 0` cannot distinguish "never seeded" from "the user
deleted all rules" — the wire makes empty and absent byte-identical (`skip_serializing_if =
"Vec::is_empty"`), so the offer comes back every time the list hits zero. Two options were on the table:

- **(a) Accept it** — state the re-appearing offer plainly in the plan and pin it. The copy already
  labels the deny rule "a default you can delete"; re-adding a deleted default is harmless; and the offer
  is one button on an otherwise-empty card, so re-appearing there is honest, not nagging.
- **(b) A page-local flag** that suppresses the offer after the first click — cheap in code, but it is
  the settings UI's FIRST state sentinel (Decision 2's mechanism review found no precedent for a
  localStorage/flag in settings UX), and it buys nothing: the re-adding situation is harmless, and a
  flag makes "deleted → offer gone" a new invisible behaviour.

**Chosen: (a).** Recorded in Decision 2's body and in `## Risks`; pinned by the named S2 test
`"the default-rules offer re-appears after the last rule is removed (an empty list is the offer's only gate)"`.

---

## What has already landed (wave 1) — built on, not re-planned

- `src/lib/tauri/types.ts:628-637,659` — `AccessDirection`, `AccessRule`, `FilePolicy.rules?: AccessRule[]`
  (barrel-exported through `@/lib/tauri` — the new section types its rows/drafts against them today, no new
  wire types, no commands).
- `GeneralSection.tsx` — the `keyof FilePolicy` annotations on `policy`/`savePolicy` narrowed to
  `"reads" | "writes" | "shell"` (wave 1's type-only churn), so the new `rules` member does not make the
  index return `AccessPolicy | AccessRule[]`.
- Baseline this task works against: **153 files / 3240 tests, all passing** (`pnpm test`); `pnpm build`
  green. Scoped runs MUST use `npx vitest run <path>` — `pnpm test -- <path>` leaks the filter and runs the
  whole suite (verified twice; recorded in the status file and the grounding, do not re-recommend the
  `pnpm` form).

---

## Files:

(`## Files:` = the owned set — edits land in these and NO other files)

- `src/components/settings/SettingsPage.tsx` — the ONLY type change in this file: `type Section` gains
  `"permissions"`. Plus: the sidebar nav (one `SettingsSidebarButton`, `ShieldIcon`, slot after "MCP"), the
  `PermissionsSection` default import, the `permissionsSection` const, and the new ternary arm spliced
  BEFORE `: updatesSection`. The `generalSection` const loses `shellSandboxAvailable` /
  `shellSandboxSupported` from its `GeneralSection` props and passes them to `PermissionsSection`; the
  rules dialog draft state (`rulesDialog: RuleDraft | null`) joins `mcpDialog` as page state with
  `saveRule` / `removeRule` callbacks following the `saveMcpServer` pattern.
- `src/components/settings/GeneralSection.tsx` — DELETE the three `PolicyRow` usages and the "Trust new
  Spaces by default" row (S1) and, as the LAST edit in S1, the now-unused `PolicyRow` function itself (S1,
  together with the now-unused `AccessPolicy` import). The rest of the file — `#` mention, Default model,
  Default thinking level, session naming ×2, attention ×2, enabled-tools — is untouched.
- `src/components/settings/PermissionsSection.tsx` — NEW: `PolicyRow` copied verbatim (S2), the rules list
  modelled on `McpSection`'s row + add/edit dialog (three fields: path, direction, decision; NO Test
  action), the scope copy VERBATIM from the spec, the Trust toggle with the spec's replacement copy, the
  honest default-rules offer, and the RE-WORDED Writes row (find #5 — the deny-rule ask path stated, the
  "guard-rail, not a security boundary" meaning untouched).
- `src/components/settings/PermissionsSection.test.tsx` — **NEW, created by the implementer of THIS SAME
  task (not by any other actor — the file is in the owned set, and no other task touches it).** The moved
  tests (identical `it` strings, no counts copied) + the new rules-list tests (CRUD, empty-state offer)
  + the pinned `rules`-preservation regression + the pinned re-appearing-offer test + the two VERBATIM
  copy pins (scope + trust). **The two non-Linux moved tests carry their own per-test overrides**
  (Decision 3), and the disclosures test moves with matchers tolerant of the re-worded Writes copy
  (find #5). **TDD order (green-on-green after the component exists is NOT a proof):** write the
  new file's FIRST test against the not-yet-existing `PermissionsSection`, run
  `npx vitest run src/components/settings/PermissionsSection.test.tsx`, observe it RED (the imported
  module does not exist / the page renders the catch-all arm), THEN port the component and watch the same
  test go green. A file that only ever runs green proves nothing about the section's rendering; the
  red-run before the component exists is the honest entry point.
- `src/components/settings/SettingsPage.test.tsx` — S1c: the nav-id pin's expected array grows; the five
  `filePolicy` assertion sites stay (see S1c for the exact list of changed `it` strings); the
  `go("MCP")` helper gains a `"Permissions"` arm BEFORE the MCP `else`; the file-policy describe block's
  per-row tests and helpers relocate to the new test file.

---

## Steps: (serial checkboxes — one commitable unit)

- [ ] **S1 — `SettingsPage.tsx`: `type Section` gains `"permissions"`, the nav grows one button, the
  Permissions import + const arrive, and the ternary gains its arm BEFORE the catch-all — plus the
  `"permissions"` render-arm pin and the `go("Permissions")` arm in `SettingsPage.test.tsx`.**

  All five `SettingsPage.tsx` changes land together (the type, the nav button, the import, the const, the
  ternary arm) — the union member type-checks even without the import/const (it is just an unused union
  member), and the catch-all silently renders Updates otherwise (the grounding warns this explicitly; an
  unmapped `"permissions"` renders the Updates page — the miss is invisible to the compiler and only the
  render-arm pin catches it, which is why the arm pin below asserts the Updates content is absent).

  1. `type Section` (`SettingsPage.tsx:50-59`) gains `| "permissions"` — the ONLY type change in the file.
  2. Sidebar nav: a `SettingsSidebarButton` with `icon={ShieldIcon}` (`ShieldIcon` added to the lucide
     import list), `label="Permissions"`, `active={section === "permissions"}`, `onClick={() =>
     setSection("permissions")}`, inserted between the "MCP" button and the "Detached sessions" button —
     the grounding's chosen "after MCP" slot, which the nav pin's expected array reflects. (`ShieldIcon`
     exists in `lucide-react` — verified present, alongside `Shield`/`ShieldCheck`; `Shield` and
     `ShieldCheck` are left unused — a `pnpm build` would flag an unused import, so import only
     `ShieldIcon`).
  3. `import PermissionsSection from "./PermissionsSection";` beside the other section imports.
  4. A `const permissionsSection = (<PermissionsSection … />)` block beside `mcpSection`, passing
     `settings`, `rulesDialog`/`setRulesDialog`, `saveRule`/`removeRule`, `shellSandboxAvailable` /
     `shellSandboxSupported` and `onSave` — see S2 for the props and callbacks.
  5. The section switch gains `: section === "permissions" ? permissionsSection` spliced BEFORE the
     `: updatesSection` catch-all.
  6. `SettingsPage.test.tsx`, new test in the Updates-section describe (it drives the page, not the
     section): `it("selecting Permissions renders the section, and General still renders after going back", …)`:

     ```ts
     render(<SettingsPage onBack={vi.fn()} />);
     await loaded();
     fireEvent.click(screen.getByRole("button", { name: "Permissions" }));
     // The render arm is live; the trust row is the first SettingsRow of the
     // new card (S2's layout) and is unique to the Permissions section.
     expect(await screen.findByRole("switch", { name: "Trust new Spaces by default" })).toBeTruthy();
     // The previous section's content is gone (one arm renders at a time).
     expect(screen.queryByText("Default model")).toBeNull();
     // THE SECOND LEG (fixes the failure-mode conflation): while Permissions
     // is selected, the Updates content must NOT render either. Without this,
     // a nav button that points at the wrong arm — or a ternary that misplaces
     // the `"permissions"` case — fails only the trust-switch query, which
     // lumps "nav button missing" and "arm missing" into one indistinguishable
     // red. The "Check for updates" button is unique to `updatesSection`
     // (`UpdateSection.tsx`), so it is a reliable Updates-probe.
     expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
     // And the arm switches back out.
     fireEvent.click(screen.getByRole("button", { name: "General" }));
     expect(await screen.findByText("Default model")).toBeTruthy();
     expect(
       screen.queryByRole("button", { name: "Check for updates" }),
     ).toBeNull();
     ```
  7. `go` (the navigation helper at `SettingsPage.test.tsx:346-359`) — extend the union and the chain,
     **before the MCP `else`**:

     ```ts
     async function go(
       section: "Appearance" | "Providers" | "MCP" | "Web search" | "Permissions",
     ): Promise<void> {
       fireEvent.click(screen.getByRole("button", { name: section }));
       if (section === "Appearance") await screen.findByText("Theme");
       else if (section === "Providers")
         await screen.findByRole("button", { name: "Add provider" });
       else if (section === "Web search")
         await screen.findByText(
           "Configure Search providers and proxy for web_search and fetch_content tools.",
         );
       else if (section === "Permissions")
         await screen.findByRole("switch", { name: "Trust new Spaces by default" });
       // The "Add server" button is always in the MCP section (below the card).
       else await screen.findByRole("button", { name: "Add server" });
     }
     ```

     **Why the new arm must precede the `else` (the grounding's warning):** the helper's final `else`
     falls through to the MCP section's "Add server" button, and a new `"Permissions"` arm placed AFTER it
     (or added as an `else if` below the MCP line) would never be reached — a navigation test would await
     the MCP "Add server" instead of the Permissions content and could **pass for the wrong reason** (the
     Detached-sessions describe already documents this exact trap in its comment). Placing the arm before
     the `else` makes a test that forgets it fail loudly. In `SettingsPage.test.tsx`, the new section's
     own tests may either use `go("Permissions")` or (like the sessions tests) click the nav button
     directly and await the trust switch — both navigate the same way; the arm exists so a future
     `go("Permissions")` call does not fall through.

- [ ] **S1b — `GeneralSection.tsx`: the LAST edit of S1 — remove `PolicyRow` and the moved rows, leaving
  the file's other contents untouched.**

  As one edit block: delete the three `PolicyRow` usages (Reads / Writes / Shell), delete the "Trust new
  Spaces by default" `SettingsRow`, delete the now-unused `function PolicyRow` (all of
  `GeneralSection.tsx:57-129`), the now-unused `AccessPolicy` type import (and, only if the delete leaves
  them unused, the now-unused `Select`/`SelectContent`/`SelectItem`/`SelectTrigger`/`SelectValue` and
  `Switch` imports — `Select`/`Switch` ARE still used by the Default-thinking-level select, the Delay
  select and the two toggles, so verify per-import: `Switch` stays (three toggles remain), `Select`
  family stays (two selects remain), `SettingsRow` stays). **Remove the `FilePolicy` type import in this
  SAME step** (`GeneralSection.tsx:5`): after `policy`/`savePolicy` move in S2 the type is unused
  everywhere in the file, and `noUnusedLocals` (`tsconfig.json:23`) reddens `pnpm build` — tonight's
  move step is exactly the one that should delete it, so the file's last edit leaves no dangling
  import. Self-check after the edit: `grep -n "FilePolicy" src/components/settings/GeneralSection.tsx`
  must return nothing, and `npx tsc --noEmit` (or `pnpm build`) must stay green. `FilePolicy` remains
  used by the `policy` / `savePolicy` helpers ONLY until those helpers move in S2 — **do not delete the
  helpers in S1b**; delete them in S2's port, so the file is never left mid-move. The enabled-tools
  `SettingsDataRow` and the explanatory comments above the removed rows are removed with them (the
  Trust-switch block comment — see the transcript in the grounding §2 — names the trust default; the
  Writes-row comment that says "the ONE carve-out … must read as ADR 0030 wrote it" is superseded by the
  panel's scope copy in the new section).
  No wire change anywhere: moving the trust toggle is a UI move only — `defaultTrustNewSpaces` is a
  top-level `AppSettings` key, not a `FilePolicy` key (grounding §0: ". . . the spec's 'no wire change'
  claim checks out structurally").

- [ ] **S1c — `SettingsPage.test.tsx`: the nav pin grows, the gone rows are asserted, and the five
  `filePolicy` sites stay consistent. RUN the scoped file. (This is the "rules not silently dropped"
  fault line of the churn.)**

  **The nav pin** (`it("the Updates nav button is in the sidebar, after MCP", …)` at
  `SettingsPage.test.tsx:1621`): its expected array becomes

  ```ts
  expect(buttons).toEqual([
    "General",
    "Appearance",
    "Providers",
    "MCP",
    "Permissions",
    "Detached sessions",
    "Web search",
    "Updates",
  ]);
  ```

  **The moved tests physically relocate** (S2's file); back in `SettingsPage.test.tsx`, the
  file-policy-per-Section assertions that DO NOT move are the complete-document ones:

  - `changing_the_reads_select_to_ask_me_saves_the_complete_document` — **rewrites to navigate to the
    Permissions section first** (`await go("Permissions")` after `loaded()`), then the exact same three
    `saved.filePolicy.*` assertions. **This is the test that hard-pinned the hazard's failure mode; it is
    also where the PINNED regression lands** (criterion 1's first leg, below). It runs from
    `SettingsPage.test.tsx` (it asserts the whole saved document, not the section).
  - `the_shell_sandboxed_option_is_hidden_off_linux` / `the_shell_sandboxed_option_is_greyed_out_when_the_kernel_has_no_landlock`
    / `the_shell_sandboxed_option_is_selectable_when_the_kernel_can_confine` /
    `a_stored_sandboxed_shell_on_non_linux_does_not_render_an_empty_select` /
    `a_pre_feature_document_without_file_policy_renders_don_t_ask_me (never an empty select)` / the
    row-order block inside `the_three_file_access_selects_default_to_don_t_ask_me` — **relocate to
    `PermissionsSection.test.tsx`** (S2), since the rows no longer render on the General section
    (a test querying "Reads" while on General would find NOTHING — the rows render only when the
    Permissions arm is active). **The two non-Linux tests carry their own per-test overrides verbatim:
    `the_shell_sandboxed_option_is_hidden_off_linux` and
    `a_stored_sandboxed_shell_on_non_linux_does_not_render_an_empty_select` each keep their own
    `vi.mocked(getAppInfo).mockResolvedValueOnce({ … platform: "windows" })` line (test-file scaffold
    default is `platform: "linux"` — see Decision 3), and
    `the_shell_sandboxed_option_is_greyed_out_when_the_kernel_has_no_landlock` keeps its own
    `vi.mocked(shellSandboxAvailable).mockResolvedValueOnce(false)`. "Identical bodies except the named
    additions" does NOT include dropping these.** The two `a_pre_feature_document_without_file_policy_renders_don_t_ask_me`
    legs — `delete preFeature.filePolicy`, then all three tiers read "Don't ask me" — move with the
    rows; add `await go("Permissions")` after `loaded()` in the moved body.
  - `the_file_access_rows_state_the_honest_default …` and
    `the_writes_row_discloses_the_carve_out_is_a_guard_rail_not_a_boundary …` — **move** for the same
    reason; **the disclosure test is NOT moved verbatim — the Writes row copy is re-worded NOW**
    (option (a) of the review's framing): with the rules change, a matching `deny` rule makes the
    file-tools refusal an ASK — the old copy's "the file tools refuse to rewrite a directory while it
    is on this app's protected list" is an overclaim that T03/T04's wire reality reddens. The Writes
    description becomes:
    > Writing files outside the boundary. The default, "Don't ask me", lets the agent write anywhere
    > on the machine with no prompt. The one carve-out is the protected agent-definition directories
    > (your global skills and agents): while a directory is on this app's protected list and no deny
    > rule covers it, the file tools refuse to rewrite it, and that refusal is a guard-rail against
    > the agent silently rewriting its own instructions — not a security boundary. A matching rule can
    > turn that refusal into a prompt. The shell tool and sudo_exec are governed by their own gates and
    > reach these directories by design, and no setting here closes that; the guard-rail follows that
    > list rather than the folder, so a directory the list does not name is not covered by it.
    (`GeneralSection.tsx:193-195` — the "refuse to rewrite" sentence gains "and no deny rule covers
    it" + "A matching rule can turn that refusal into a prompt", the honest rule-driven ask path; the
    ADR-0030 "guard-rail, not a security boundary" meaning is untouched.) **The moved disclosure test's
    matchers must tolerate the new wording**: its (a)/(c) legs (`guard.?rail`, `shell`, `sudo_exec`)
    still pass; its tight (b) `not a .*boundary` — and the whole point of moving — keep the honest
    meaning intact, so the strict regex survives unchanged, PROVIDED the copy keeps "not … a security
    boundary" and never claims an absolute "refuse under any policy". **The moved test's matchers are NOT
    loosened** — they continue to pass on the re-worded copy: (a) `guard.?rail` (kept), (b) `not a
    .*boundary` (kept), (c) `shell` + `sudo_exec` (kept), (d) the no-absolute regex (the re-word
    introduces no "never rewrite"/"always refuse"/"under any policy" — "refuse to rewrite it" is
    scoped by "while … and no deny rule covers it"), (e) no second-person invite ("A matching rule can
    turn …" is no `you can`). The test keeps its name
    — `the_writes_row_discloses_the_carve_out_is_a_guard_rail_not_a_boundary (the copy is the only
    disclosure surface)` — because the meaning it pins (guard-rail, not boundary; the disclosure is not
    an absolute) is exactly what the re-word preserves, and
    the moved copy in the section's `/S2` block below is the re-worded one. The disclosure test's
    `rowOf("Reads").textContent` contrast leg moves with it.
  - `the_three_file_access_selects_default_to_don_t_ask_me` — KEEPS its three-tier "Don't ask me" legs
    (moved), and its row-order block relocates as the new section's layout pin: **the order restraint
    "Shell above the Trust switch and above default model etc." is now the PERMISSIONS-card layout** —
    the moved block becomes
    `expect(index("Reads")).toBeGreaterThanOrEqual(0); …< Writes < Shell < index("Trust new Spaces by default")`,
    all four rows living in the same `SettingsGroupCard`. ("above default model etc." no longer applies —
    Default model no longer shares a card with the posture rows.)

  **Five `filePolicy` assertion sites** (the ground's count): sites 1–4 (`the_three_file_access…`
  first, `changing_the_reads…`'s three `*.filePolicy.*`, the `sandboxed`/`pre_feature` seeds and
  `flipping the toggle…` / `flipping the naming switch…`'s `expect(saved.filePolicy).toEqual(baseSettings.filePolicy)`)
  — the last two's `toEqual(baseSettings.filePolicy)` stays **unchanged** (the fixture's `filePolicy` is
  kept WITHOUT a `rules` key, per decision — see the "No fixture growth" note below), so those two stay
  green untouched. Site 5 is the
  `baseSettings` fixture itself (`SettingsPage.test.tsx:105` / the inlined `getSettings` fixture): NOT
  changed (the seeds above override it per-test). The net effect on `SettingsPage.test.tsx`: the nav
  pin's array, the
  `go("Permissions")` arm, the new arm-render pin (+ its Updates NOT-leg), the moved-out tests, the
  rewritten `changing_the_reads…` test, and the S2b two-write interleave pin. Do not copy counts — name
  the `it` strings exactly as above.

  **No fixture growth:** the `baseSettings`/inlined `getSettings` fixture keeps its
  `filePolicy: { reads: "allow", writes: "allow", shell: "allow" }` WITHOUT a `rules` key (matching the
  wire reality the grounding records). Seeding rules is done per-test via
  `vi.mocked(getSettings).mockResolvedValueOnce({ ...baseSettings, filePolicy: { reads: "allow",
  writes: "allow", shell: "allow", rules: [ … ] } })` — exactly what the two new regression seeds (S1c,
  S2b) and the moved `sandboxed`-seeded test already do. This is what keeps the two
  `expect(saved.filePolicy).toEqual(baseSettings.filePolicy)` complete-document assertions green without
  modification.

  **Run:** `npx vitest run src/components/settings/SettingsPage.test.tsx`. If an UNOWNED file
  reddens, do NOT edit it — report it in `## Risks` findings (the `src/App.test.tsx` store-files concern
  is covered by the "No fixture growth" reasoning and the fixture/unreddened checks; anything beyond that
  is a genuine
  finding).

  **Widened scoped-run net (catch drift early, not at the full gate):** S1c and the other frontend steps
  ALSO run, scoped, in this order:

  ```
  npx vitest run src/store/settings.test.ts
  npx vitest run src/test/fixtures.test.ts
  npx vitest run src/App.test.tsx
  ```

  The reviewer verified all three stay green under the no-fixture-growth rule — and they must, for a
  concrete reason: all three seed/assert the 3-key `filePolicy` (no `rules` key) — `src/store/settings.test.ts:40`
  (the store's settings fixture), `src/test/fixtures.test.ts:103,135,172` (`makeSettings`'s field set
  is APP_SETTINGS_FIELDS-wide and pins `filePolicy` `toEqual` the three-key shape), `src/App.test.tsx:108`
  (the app-level settings fixture) — and none of them ever asserts General's contents (no "Reads" /
  "Writes" / "Shell" / "Default model" queries in any of the three). So a `rules` key leaking into the
  shared fixture would redden them immediately, and a General-row assertion sneaking into them would
  redden `fixtures.test.ts`'s key-set pin. Running them in every scoped pass catches that drift in the
  task that introduces it, instead of at the full gate.

- [ ] **S1d — `SettingsPage.tsx`: the page state + save callbacks for the rules list (the `McpSection`
  wiring pattern). Assert the deletion of the moved rows from General in the SAME step.**

  Add, beside `mcpDialog`:

  ```ts
  // The rules add/edit dialog draft (`null` = closed — a fresh draft per open,
  // the MCP dialog's pattern).
  const [rulesDialog, setRulesDialog] = useState<RuleDraft | null>(null);
  ```
  with `type RuleDraft` imported as a type from the new section (`import PermissionsSection, { type
  RuleDraft } from "./PermissionsSection";` — the `McpSection, { type McpDraft }` precedent).

  The save/remove callbacks — the `saveMcpServer` pattern, plus the MUST carry existing rules through.
  **How they compose — honest statement (Decision 1's residual): `saveRule`/`removeRule` compose from
  `settings`, the LAST-RENDERED document, exactly like `useSettingsDocument.patch` composes from the
  rendered `settings` (`useSettingsDocument.ts`'s `patch` — the same rendered-document read the hook's
  own two-patches pin at `useSettingsDocument.test.ts:193` pins). This is deliberately the CHEAP compose:
  it matches the hook's pinned semantics (`patch` also composes from the rendered document), needs no new
  mechanism, and keeps the two save paths on one behaviour. The residual is a staleness WINDOW, not a
  new hazard class: two writes delivered in one render batch compose from the same rendered document, so
  the second save drops the first — the exact two-write interleaving your one-save-at-a-time pins cannot
  observe. T03/T04's rule writes go through the same whole-document `save_settings` and shrink the window
  further (see the interleave pin in S2b for the two-write test itself):

  ```ts
  /** Save one rule (the dialog's Save — immediate save, the provider pattern).
   * Always composes over `settings.filePolicy` (spread), so an existing `rules`
   * list is never dropped by an add/edit/remove. (Composes over the RENDERED
   * `settings`, not a ref — the two-write interleave in S2b's pin.) */
  const saveRule = (rule: AccessRule) => {
    if (settings === null) return;
    const rules = settings.filePolicy?.rules ?? [];
    const index = rules.findIndex((r) => r === rule);
    update({
      filePolicy: {
        ...settings.filePolicy,
        rules:
          index === -1
            ? [...rules, rule]
            : rules.map((r, i) => (i === index ? rule : r)),
      },
    });
    setRulesDialog(null);
  };

  const removeRule = (rule: AccessRule) => {
    if (settings === null) return;
    const rules = settings.filePolicy?.rules ?? [];
    update({
      filePolicy: {
        ...settings.filePolicy,
        rules: rules.filter((r) => r !== rule),
      },
    });
  };
  ```
  with `AccessRule` in the file's `@/lib/tauri` type import list, and `RuleDraft`'s `draftToRule` /
  `ruleToDraft` converters owned by the section (S2). The new const:

  ```tsx
  const permissionsSection = (
    <PermissionsSection
      settings={settings}
      dialog={rulesDialog}
      setDialog={setRulesDialog}
      shellSandboxAvailable={platform === "linux"}
      shellSandboxSupported={sandboxSupported === true}
      onSave={update}
      onSaveRule={saveRule}
      onRemoveRule={removeRule}
    />
  );
  ```
  and the `generalSection` const drops `shellSandboxAvailable` / `shellSandboxSupported` from its
  `GeneralSection` props (S2 keeps `GeneralSection`'s prop interface as-is; the page just stops passing
  them — the moved rows consume them in the Permissions section instead).

- [ ] **S2 — the `PermissionsSection.tsx` component: `PolicyRow` copied verbatim, the rules list modelled
  on `McpSection`, the scope copy, the Trust toggle with the replacement copy, and the default-rules
  offer. `PermissionsSection.test.tsx` (created by THIS task's implementer): the moved tests + the new
  rules tests + the pinned regression (+ the interleave + re-appearing-offer pins).**

  **Test-file ownership + red-run entry point:** the implementer creates `PermissionsSection.test.tsx`
  in the SAME task — it is in the owned set (see `## Files:`) — with its first test written against the
  not-yet-existing section. The TDD entry: write the new file's first test, run
  `npx vitest run src/components/settings/PermissionsSection.test.tsx`, observe it RED (the imported
  module does not exist; the page renders the catch-all arm instead), THEN build. Green-on-green after
  the component exists is not a proof of the section's rendering — the red-run before the component is
  the honest entry point (see the TDD-order note at the end of this step).

  **Props and shape** (the section owns no state; every social fact stays on the page):

  ```tsx
  /** The add/edit rule draft (the `PermissionsDialog`'s local state). */
  export interface RuleDraft {
    path: string;
    direction: AccessDirection;
    decision: "allow" | "deny";
  }

  /** The rules add/edit form (three fields; Save = the immediate-save pattern). */
  function ruleToDraft(rule: AccessRule): RuleDraft {
    return { path: rule.path, direction: rule.direction, decision: rule.decision };
  }
  function draftToRule(d: RuleDraft): AccessRule {
    return { path: d.path.trim(), direction: d.direction, decision: d.decision };
  }

  interface PermissionsSectionProps {
    settings: AppSettings | null;
    /** The add/edit dialog draft (`null` = closed). */
    dialog: RuleDraft | null;
    setDialog: (draft: RuleDraft | null) => void;
    /** (ADR 0030) Whether the Shell `Sandboxed` tier can be OFFERED at all (Linux only). */
    shellSandboxAvailable: boolean;
    /** (ADR 0030 Task 5) Whether THIS kernel can confine a shell (Landlock probe). */
    shellSandboxSupported: boolean;
    /** The immediate-save pattern (`SettingsPage`'s `update`). */
    onSave: (patch: Partial<AppSettings>) => void;
    /** Save one rule (add or edit — the dialog's Save). */
    onSaveRule: (rule: AccessRule) => void;
    /** Drop one rule (immediate save). */
    onRemoveRule: (rule: AccessRule) => void;
  }
  ```

  **Layout** — one `SettingsGroupCard` per group, in this order:
  *Group 1 (the moved posture rows + Trust toggle):* the `PolicyRow` copy (three usages with the SAME
  description JSX the grounding quotes verbatim — Reads / Shell, and Writes in its RE-WORDED form per
  find #5: the `deny`-rule ask path is stated, the ADR-0030 "guard-rail, not a security boundary"
  meaning untouched), then the Trust `SettingsRow`
  with the spec's replacement description (VERBATIM — see the copy block below). The `policy` /
  `savePolicy` helpers move with the rows, with `savePolicy` carrying rules through as Decision 1:
  `const policy = (direction: "reads" | "writes" | "shell"): AccessPolicy => settings.filePolicy?.[direction] ?? "allow";` and
  `const savePolicy = (direction: "reads" | "writes" | "shell", value: AccessPolicy): void => { const fp = settings.filePolicy; const current: FilePolicy = { ...fp, reads: policy("reads"), writes: policy("writes"), shell: policy("shell") }; onSave({ filePolicy: { ...current, [direction]: value } }); };`
  — the spread `...fp` (the array-typed `rules`) is the whole fix; the three explicit reads stay so a
  pre-feature document with no `filePolicy` still composes cleanly. **The Writes row's re-worded
  description (find #5 — the honest rule-driven ask path; the moved disclosure test's matchers
  tolerate it):**

  > Writing files outside the boundary. The default, "Don't ask me", lets the agent write anywhere on
  > the machine with no prompt. The one carve-out is the protected agent-definition directories (your
  > global skills and agents): while a directory is on this app's protected list and no deny rule covers
  > it, the file tools refuse to rewrite it, and that refusal is a guard-rail against the agent silently
  > rewriting its own instructions — not a security boundary. A matching rule can turn that refusal into
  > a prompt. The shell tool and sudo_exec are governed by their own gates and reach these directories by
  > design, and no setting here closes that; the guard-rail follows that list rather than the folder, so
  > a directory the list does not name is not covered by it.
  *Group 2 (the rules list), the `McpSection` row + dialog model:* an empty-state div (when
  `(settings.filePolicy?.rules ?? []).length === 0` — the same condition as the default-rules offer
  below) or a `SettingsDataRow` per rule, then an
  **"Add rule"** `Button` below the card, then the dialog mounted only while `dialog !== null`. Each row
  shows path, direction and decision as text; the actions are Edit (`PencilIcon`, `aria-label={`Edit rule ${path}`}`)
  and Remove (`TrashIcon` inside an `AlertDialog` confirm — the `McpSection` confirm shape, title `Remove rule {path}?`, description carries ONE sentence about what removal means: "The rule stops applying, and the posture selects above decide again.", Cancel / Remove). NO Test action (the spec: "simpler: three fields, no Test action"). The direction is rendered as a `SettingsBadge` (`"read"` / `"write"` / `"readWrite"` — the WIRE value, exactly like the MCP badge shows the wire kind) and the decision as text only ("allow"/"deny" lowercase in the row's summary line), matching the MCP row's summary-as-text pattern; the direction badge is the one badge.

  **Row identity (the grounding flags it as a real choice): there is no rule id — a rule IS
  `{path, direction, decision}`.** The list `key` is the STRINGIFIED `path|direction|decision` triple
  (the spec has no rule ordering — longest-prefix, not first-match). `removeRule`/save-edits compare
  rules by the same triple (`r === rule` element identity works because the rows hold the SAME
  `AccessRule` objects straight from the document — see the "reference identity" note below); if a saved
  rule's `path.trim()` differs from the draft's original, the edit REPLACES by value-equality of the
  pre-edit rule — no id to confuse. Reference identity note: `permissionsSection`'s rows map over
  `settings.filePolicy?.rules ?? []` (the store's own array), so the `r === rule` comparisons in
  `saveRule`/`removeRule` work on the same element references; the draft converters return FRESH
  objects, so the save path recomposes by `findIndex((r) => r === rule)` on the CAPTURED rule passed up
  from the row. Keep both halves consistent: the page's callback compares the passed `AccessRule` (the
  one the row holds) against the store array — no structural deep-compare needed.

  **The dialog** (`PermissionsDialog`, module-private like `McpDialog`): an uncontrolled draft copy
  (`useState(initial)`), the `set` partial-patcher, `valid = draft.path.trim() !== ""` gating the Save
  button, `Dialog open onOpenChange={(nextOpen) => !nextOpen && onClose()}`. Title: `Add rule` when
  `initial.path === ""`, else `Edit rule ${initial.path}`. Description: "Stored in the desktop's
  settings.json. Deny beats allow on the same path; the more specific path wins. Rules never apply to
  bash." Three fields — path (`Field` + `Input`, `placeholder="~/.pi/agent"`, `aria-label="Path"`),
  direction (`Field` + `Select`, `aria-label="Direction"`, options `read` / `write` / `readWrite` with
  the labels "Read" / "Write" / "Read & write"), decision (`Field` + `Select`, `aria-label="Decision"`,
  options `allow` / `deny`). Footer: `Cancel` (ghost) + `Save` (disabled while `!valid`). The Add-rule
  button sets `setDialog({ path: "", direction: "read", decision: "deny" })` (the default direction
  `read`; the default decision `deny` — the LIKELY guard-generated rule, and the honest default).

  **The scope copy — VERBATIM from the spec (required honesty, not optional prose).** A
  `SettingsRow` (or a `SettingsDataRow`-style bordered block) titled "Rules apply to the file tools
  only" with description:

  > These rules apply to the file tools (`read`, `write`, `edit`, `grep`, `glob`). **`bash` runs with
  > your own user's OS permissions — it is not covered here.** To stop the agent reaching something with
  > `bash`, remove your user's access to it.

  **The Trust copy — the spec's approved replacement, VERBATIM** (it must change because trusting a Space
  now ALSO silences the self-modification guard):

  > New Spaces start trusted (skip permission prompts). A trusted Space's agent can also write its own
  > instruction directories without asking — deny those paths with a rule above if you want that to
  > still prompt.

  (The current `GeneralSection.tsx:237` string — "New Spaces start trusted (skip permission prompts for
  bash/edit/write); existing Spaces are unaffected" — is what the move replaces; the grounding quotes it
  verbatim.)

  **The default-rules offer (Decision 2 — the re-appearing offer is DECIDED + PINNED behaviour)** — as the
  LAST block of the rules card, shown only when `(settings.filePolicy?.rules ?? []).length === 0`.
  **The choice is (a): accept the offer's re-appearing after the user deletes all rules, state it plainly,
  and pin it.** The predicate cannot distinguish "never seeded" from "the user deleted every rule" — the
  wire makes empty and absent byte-identical — and a page-local "offer seen" flag (option (b)) would be
  cheap, but it would be the app's FIRST localStorage/state sentinel for settings UX (no precedent, per
  Decision 2's mechanism review) and buys nothing: the copy already labels the deny rule "a default you can
  delete", re-adding a deleted default is harmless, and the offer is one button on an otherwise-empty
  card — re-appearing there is honest, not nagging. **This is option (a), chosen and pinned:**

  ```tsx
  <div className="px-4 py-3 text-ui-base text-foreground-subtle">
    No rules yet. Three starter rules exist for a clean install: <code>~</code> read/write <em>allow</em> and <code>/</code> read <em>allow</em> (both change nothing at the default open posture — they document how open it is), and <code>~/.pi/agent</code> read <em>deny</em> (the one real restriction: covers <code>~/.pi/agent/auth.json</code>). The deny rule is a default you can delete.
  </div>
  <Button variant="outline" onClick={() => setDialog({ path: "~/.pi/agent", direction: "read", decision: "deny" })}>
    Add default rule
  </Button>
  ```

  (The lone button pre-fills the DENY rule — the only one that matters; the panel copy explains the two
  `allow` defaults. This is the chosen honest option; the automatic first-write mechanism does not exist —
  recorded in Decision 2 and `## Risks`.)

  **THE RE-APPEARING OFFER, PINNED (Decision 4 — see Decision 2's page-local-flag paragraph and Risks).**
  "Delete all rules, and the offer comes back" is pinned as the species behaviour — a regression that
  suppresses the offer after a delete, or makes it re-appear after a save with rules present, reddens:
  the section-level test

  ```ts
  it("the default-rules offer re-appears after the last rule is removed (an empty list is the offer's only gate)", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...baseSettings,
      filePolicy: {
        reads: "allow", writes: "allow", shell: "allow",
        rules: [{ path: "~/.pi/agent", direction: "read", decision: "deny" }],
      },
    });
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    // Seeded with one rule: no offer.
    expect(screen.queryByText("No rules yet.")).toBeNull();
    // Remove the rule (Trash → AlertDialog → Remove → immediate save).
    fireEvent.click(screen.getByRole("button", { name: "Remove rule ~/.pi/agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    // After the delete, the offer is BACK — the predicate is
    // `(rules ?? []).length === 0`, which cannot tell "never seeded" from
    // "user deleted all rules". This is the decided (a)-behaviour, pinned.
    expect(await screen.findByText("No rules yet.")).toBeTruthy();
  });
  ```

  The test's own name records the reason; the Risks entry mirrors it. The "No rules yet." anchor is the
  offer block's first sentence (the same string the `an empty rules list renders…` test asserts), so the
  pin rides on the copy it labels deletable.

  **`PermissionsSection.test.tsx` — the moved tests** (identical `it` strings and bodies except the
  additions named below): it is PAGE-driven (the repo has no `GeneralSection.test.tsx` precedent — General
  is tested entirely through `SettingsPage.test.tsx`, per the grounding), so it carries the SAME
  `vi.mock("@/lib/version")` / `vi.mock("../../lib/tauri")` / `beforeAll` pointer-capture scaffold as
  `SettingsPage.test.tsx` (the getSettings fixture, the inlined `filePolicy`-without-`rules`, the
  `shellSandboxAvailable: vi.fn().mockResolvedValue(true)`, the `listModels` fixture, the
  `saveSettings: vi.fn().mockResolvedValue(undefined)`). Each test that renders the page must navigate to
  the section:
  `render(<SettingsPage onBack={vi.fn()} />); await loaded(); await go("Permissions");` — and
  `PermissionsSection.test.tsx` defines its OWN copies of the file-scope helpers (`rowOf`, `openSelect`,
  `closeSelect`, `optionLabels`, and the `loaded()` marker `await screen.findByText("Default model")` —
  the General section's own marker, which still exists because General still renders; the Permissions
  section's own marker is the trust switch, awaited via `go("Permissions")`). The **moved tests** are, by `it` string (bodies verbatim EXCEPT the named per-test overrides and the
  named additions — see Decision 3 for the override caveat; NOT "identical bodies except the named
  additions" for the two non-Linux tests):

  - `the_file_access_rows_state_the_honest_default (the copy carries the all-allow posture)`
  - `the_writes_row_discloses_the_carve_out_is_a_guard_rail_not_a_boundary (the copy is the only disclosure surface)`
  - `the_shell_sandboxed_option_is_hidden_off_linux` — **carries its own
    `vi.mocked(getAppInfo).mockResolvedValueOnce({ version: "0.1.0", platform: "windows" })`**
    (the new file's scaffold default is Linux; the test asserts the off-Linux behaviour, so the
    override is load-bearing, not optional)
  - `the_shell_sandboxed_option_is_greyed_out_when_the_kernel_has_no_landlock` — **carries its own
    `vi.mocked(shellSandboxAvailable).mockResolvedValueOnce(false)`**
  - `the_shell_sandboxed_option_is_selectable_when_the_kernel_can_confine`
  - `a_stored_sandboxed_shell_on_non_linux_does_not_render_an_empty_select` — **carries its own
    `vi.mocked(getAppInfo).mockResolvedValueOnce({ version: "0.1.0", platform: "windows" })`**
  - `a_pre_feature_document_without_file_policy_renders_don_t_ask_me (never an empty select)`
  - `the_three_file_access_selects_default_to_don_t_ask_me` (with the row-order block re-pointed to the
    new card's layout — see S1c)

  **The new test file's new tests** (all page-driven through `SettingsPage`, mirroring the file's own
  describe style — there is no `GeneralSection.test.tsx` precedent, so the page drive is the idiom;
  **the FIRST of these written is the one run against the not-yet-existing component for the red-run** —
  see the TDD-order note at the end of this step):

  - the pinned hazard regression — **the headline new pin**:

    ```ts
    it("a posture save keeps an existing rule list (changing the reads select preserves rules)", async () => {
      vi.mocked(getSettings).mockResolvedValueOnce({
        ...baseSettings,
        filePolicy: {
          reads: "allow", writes: "allow", shell: "allow",
          rules: [{ path: "~/.pi/agent", direction: "read", decision: "deny" }],
        },
      });
      render(<SettingsPage onBack={vi.fn()} />);
      await loaded();
      await go("Permissions");
      fireEvent.click(await screen.findByRole("combobox", { name: "Reads" }));
      fireEvent.click(await screen.findByRole("option", { name: "Ask me" }));
      await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
      const saved = vi.mocked(saveSettings).mock.calls[0][0] as AppSettings;
      expect(saved.filePolicy.reads).toBe("ask");
      expect(saved.filePolicy.rules).toEqual([
        { path: "~/.pi/agent", direction: "read", decision: "deny" },
      ]);
    });
    ```

  - the rules CRUD:
    - `an empty rules list renders the default-rules offer with the honest copy` — the two "change
      nothing at the default posture" sentences + the `deny`-is-a-deletable-default sentence, and the
      ONE "Add default rule" button;
    - `add_rule_saves_the_triple_and_closes_the_dialog` — Add rule → type a path → Save →
      `saved.filePolicy.rules` contains the triple, the row + Edit/Remove buttons render, and the dialog
      closed;
    - `edit_rule_replaces_the_triple` — seed one rule, edit, change the path, Save → exactly one
      replacement rule (no duplicate);
    - `remove_rule_confirms_then_saves` — Trash → AlertDialog → Remove → `rules` empty / gone;
    - `a_rule_row_shows_path_direction_and_decision` — the row's text contains the path, the direction
      badge and the decision word.

  - the copy pins:
    - `the scope copy states bash is not covered (the spec's honesty)` — `getByText` on the exact copy
      `These rules apply to the file tools (read, write, edit, grep, glob). bash runs with your own
      user's OS permissions — it is not covered here. To stop the agent reaching something with bash,
      remove your user's access to it.` (query on a substring; the em-dash is part of the pinned copy);
    - `the trust copy states the self-modification implication` — the row's description contains "write
      its own instruction directories without asking" and "deny those paths with a rule above".

  **TDD order within S2**: write the moved tests + the new tests FIRST — **in `PermissionsSection.test.tsx`,
  created by THIS task's implementer, and the FIRST test written runs against the not-yet-existing section** —
  run `npx vitest run src/components/settings/PermissionsSection.test.tsx` and observe it RED (the imported
  module does not exist), then port the component and re-run (green). Green-on-green after the component
  exists is not a proof; the red-run before the component exists is the honest entry point (the `## Files:`
  description of the test file states ownership + TDD the same way). The section is exercised only through
  the page because that is where `settings` flows from — the moved tests' `go("Permissions")` navigation is
  the honest surface.

- [ ] **S2b — `SettingsPage.test.tsx`'s `changing_the_reads_select_to_ask_me_saves_the_complete_document`
  gains the rules-preservation assertion (the mirror of the section-level pin), and the file-policy
  helper comment relocates.**

  In the rewired complete-document test (S1c), after the existing
  `expect(saved.filePolicy.shell).toBe("allow");` add:

  ```ts
  // The PINNED regression (the `savePolicy` spread must carry rules through —
  // the silent-data-loss hazard of the three-key reconstruction; the complete-
  // document assertions above would pass even with rules dropped, so this is
  // the teeth).
  ```

  with the seed and assertion:

  ```ts
  vi.mocked(getSettings).mockResolvedValueOnce({
    ...baseSettings,
    filePolicy: {
      reads: "allow", writes: "allow", shell: "allow",
      rules: [{ path: "~/.pi/agent", direction: "read", decision: "deny" }],
    },
  });
  // ...after the save...
  expect(saved.filePolicy.rules).toEqual([
    { path: "~/.pi/agent", direction: "read", decision: "deny" },
  ]);
  ```

  (The one page-level pin from S1c and this section-level pin are the same regression asserted at the
  two surfaces that can be broken independently — the moved `savePolicy` is exercised by both; the page
  test additionally pins the whole-document save that carries `rules` to the wire.)

  **THE TWO-WRITE INTERLEAVE PIN — the pin that makes the residual OBSERVABLE (Decision 1's honest
  statement; your one-save-at-a-time pins cannot see this, this one can).** `savePolicy`/`saveRule`/
  `removeRule` all compose from the LAST-RENDERED `settings` (the hook's `patch` semantics — the same
  rendered-document compose the hook's own two-patches pin records), so two writes delivered in ONE
  render batch compose from the SAME rendered document: the second save drops the first, and the
  document persisted carries only the second change. One posture save in one act() then one rules save in
  the NEXT act() is what the section-level pin does — sequential renders, both compose fresh, both
  survive. The interleave is different batch-in-one-render, and it is now pinned at the page level, in
  `SettingsPage.test.tsx` (it asserts the whole saved document, so it lives with the complete-document
  tests):

  ```ts
  it("a posture change and a rule save in the same flow save BOTH (the last saveSettings carries the new posture and the new rules list)", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...baseSettings,
      filePolicy: {
        reads: "allow", writes: "allow", shell: "allow",
        rules: [{ path: "~/.pi/agent", direction: "read", decision: "deny" }],
      },
    });
    render(<SettingsPage onBack={vi.fn()} />);
    await loaded();
    await go("Permissions");
    // Change the Reads posture AND save a rule in the same flow. The
    // precedence-table entry a `deny` rule overrides is the Reads policy, so
    // this is the pair that MUST survive together (T03's row-3 ask).
    fireEvent.click(await screen.findByRole("combobox", { name: "Reads" }));
    fireEvent.click(await screen.findByRole("option", { name: "Ask me" }));
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(await screen.findByLabelText("Path"), {
      target: { value: "/tmp/build" },
    }); // decision defaults to `deny`; direction defaults to `read`
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2));
    // The LAST whole-document save carries BOTH: the last `saveSettings`
    // argument is the final document the wire receives — if either change
    // were dropped by the interleave, this argument would show a stale
    // posture or a missing rule. Both present = the interleave cannot
    // silently persist a document missing one change.
    const saved = vi.mocked(saveSettings).mock.calls[1][0] as AppSettings;
    expect(saved.filePolicy.reads).toBe("ask");
    expect(saved.filePolicy.rules).toEqual([
      { path: "~/.pi/agent", direction: "read", decision: "deny" },
      { path: "/tmp/build", direction: "read", decision: "deny" },
    ]);
  });
  ```

  **What this test proves, and what it cannot** (the honest reading): the assertion is on the FINAL
  `saveSettings` argument — the document the wire actually persists. That final argument carries BOTH
  changes only if the two writes' composes did not clobber each other. Under the REPO'S OWN pinned
  compose semantics — two writes delivered in one batch compose from the SAME rendered document
  (`useSettingsDocument.test.ts:193`) — this test may fail, and if it does, it fails for a reason this
  plan names rather than hides: the two-write interleave drops one change, exactly the hazard this task
  exists to harden. **This task does NOT fix that window** (fixing it means changing `patch`'s compose —
  a pinned behaviour — or introducing a store/ref read, which this review's "no new-abstractions
  restraint" keeps out); it pins the window so it is OBSERVABLE rather than assumed-safe, and the
  decision to absorb it in T06 (the immediate-save UI makes interleaved writes a deliberate user
  action, and the batch window is a single render turn) is recorded in `## Risks`. When the test lands:
  if it is red, do not delete or weaken it — implementers report the interleave finding with the red
  test as evidence; if it is green, the comment above still stands (the rendered-document compose is
  still the semantics, and the two-saves-in-one-flow is still the surface it can drop).

- [ ] **S3 — Scoped runs, then the full gate.**

  From the repo root, in this order:

  ```
  npx vitest run src/components/settings/SettingsPage.test.tsx
  npx vitest run src/components/settings/PermissionsSection.test.tsx
  npx vitest run src/hooks/useSettingsDocument.test.ts
  npx vitest run src/store/settings.test.ts
  npx vitest run src/test/fixtures.test.ts
  npx vitest run src/App.test.tsx
  ```

  (each scoped and green before the next), then the two gate legs:

  ```
  pnpm test
  pnpm build
  ```

  `pnpm build` runs `tsc && vite build` — it is the strictness pass over the new props, the `RuleDraft`
  converters, the `FilePolicy` spread, and the removed `GeneralSection` imports. **If `src/App.test.tsx`
  (unowned) reddens**, STOP and report it in `## Risks` rather than editing it: the "No fixture growth"
  reasoning in S1c
  says it should not (no store/top-level key changes, no updated nav state), and a red that satisfies
  that reasoning anyway is a finding for the orchestrator, not a silent fix.

---

## Verification (the gate, from the repo root)

- `npx vitest run src/components/settings/SettingsPage.test.tsx` — the nav pin, the arm-render pin, the
  vollständig-document save tests, the `go("Permissions")` arm.
- `npx vitest run src/components/settings/PermissionsSection.test.tsx` — the moved posture-row tests, the
  rules CRUD, the pinned `rules`-preservation regression, and the two VERBATIM copy pins.
- `npx vitest run src/hooks/useSettingsDocument.test.ts` — untouched (the hook is NOT changed); the run
  is proof.
- `npx vitest run src/store/settings.test.ts` / `src/test/fixtures.test.ts` / `src/App.test.tsx` — the
  widened scoped net (S1c): all three seed the 3-key `filePolicy` and never assert General's contents
  (why: S1c), so they stay green under the no-fixture-growth rule and catch drift early.
- `pnpm test` — the full suite (153 files / 3240 tests baseline at branch HEAD; the suite count may grow
  to 154 by the new test file, and the test COUNT grows by ~12 via the new `it` blocks — do not copy
  numbers into the status file; name the pins).
- `pnpm build` — the strictness pass (unused imports / prop arity / spread correctness).

---

## Acceptance criteria (named by test string, not by count)

1. **The hazard is fixed AND pinned, and the residual interleave is PINNED (Decision 1).** The tests
   `"a posture save keeps an existing rule list (changing the reads select preserves rules)"` and the
   rewritten `changing_the_reads_select_to_ask_me_saves_the_complete_document` both pass: a document
   seeding `filePolicy.rules: [{ path: "~/.pi/agent", direction: "read", decision: "deny" }]` retains
   that rule after a Reads-select save, asserted on the SAVED document (`saved.filePolicy.rules`
   `toEqual`), at both the section level and the page/whole-document level. A future regression that
   rebuilds `FilePolicy` from the three keys alone (or removes the spread) reddens both. The two-write
   interleave — a posture change AND a rule save in the same flow — is pinned by
   `"a posture change and a rule save in the same flow save BOTH (the last saveSettings carries the new posture and the new rules list)"`,
   which asserts the FINAL `saveSettings` argument carries both (the residual rendered-document compose
   window made observable, not assumed-safe; recorded in Risks).
2. **The spec's Settings requirements render.** `type Section` gains `"permissions"`; selecting
   Permissions renders the new panel (pinned by
   `"selecting Permissions renders the section, and General still renders after going back"` — including
   the NOT-leg that the Updates content ("Check for updates") is NOT rendered while Permissions is
   selected); the Reads / Writes / Shell selects and the Trust switch no longer render in General (their
   tests moved and re-pointed); the three posture selects + Trust toggle moved is a UI-only change (the
   trust toggle still saves the top-level `defaultTrustNewSpaces`, asserted by the moved `flipping the
   toggle…` complete-document tests which stay green).
3. **The honest copy is verbatim (not optional prose).** The scope copy pin matches the spec's
   `These rules apply to the file tools (read, write, edit, grep, glob). bash runs with your own user's
   OS permissions — it is not covered here.` sentence, and the Trust copy pin matches the spec's
   replacement `New Spaces start trusted (skip permission prompts). A trusted Space's agent can also
   write its own instruction directories without asking — deny those paths with a rule above if you want
   that to still prompt.` — both READ from the live DOM, not from a fixture.
4. **The rules list is the `McpSection` model.** Rows show path, direction, decision (no Test action);
   add / edit / remove round-trip through the store's `filePolicy.rules`; the save callbacks compose
   over `...settings.filePolicy` so posture and rules writes never destroy each other; the "Add rule"
   dialog is a three-field form with a Save gate on a non-blank path. The default-rules offer's
   re-appearing-after-delete is the CHOSEN behaviour, pinned by
   `"the default-rules offer re-appears after the last rule is removed (an empty list is the offer's only gate)"`
   (Decision 4).
5. **No wire change, no unowned churn.** `src/lib/tauri/*`, the store, the hook, and every
   `SettingsSection`/`UpdateSection`/`WebSearchSection`/`SessionsSection` file are untouched;
   `useSettingsDocument.test.ts` is untouched and green. `src/App.test.tsx` stays green under
   `pnpm test` — if it does not, that is a reported finding, not an edit. The three scoped runs
   (`src/store/settings.test.ts`, `src/test/fixtures.test.ts`, `src/App.test.tsx`) all stay green in the
   widened scoped net (S1c).
6. **No navigation false-positive.** The `go` helper's `"Permissions"` arm precedes the MCP `else`
   fallthrough (grounding's warning), so a future Permissions navigation cannot silently resolve to the
   MCP section's "Add server".

---

## Risks / honest limits (recorded, not hidden)

- **Decision 2's mechanism gap is recorded, not hidden.** The spec's "three default rules written only
  on first write" cannot be implemented as written: there is no save-history signal anywhere (no
  frontend state, no version marker, and Rust's missing-file branch is not surfaced), and the wire
  cannot distinguish an empty list from an absent one. The chosen alternative — an explicit
  "Add default rule" action pre-filling the deny-rule draft, with panel copy that names all three
  defaults and labels the deny rule as deletable — is the cheapest honest option that does not invent a
  mechanism (a new `settings.json` key is a wire-shape decision this area cannot make unilaterally and
  touches the Rust `Settings` struct; a localStorage sentinel has no precedent in this codebase). The
  UX is: fresh or existing install, the rules card shows the honest starter copy and ONE button; no
  rules are ever written without an explicit click. The limitation and its reasoning are recorded here
  for T07's docs follow-up.
- **The `Writes` copy is re-worded NOW, and that re-word is moved, not deferred (option (a) of the
  review's framing — the "move verbatim" option is REJECTED).** Moving the disclosure test unchanged
  would re-pin the overclaim: the old copy's "the file tools refuse to rewrite a directory while it is
  on this app's protected list" is an absolute that T03/T04's wire reality reddens (a matching `deny`
  rule makes that refusal an ASK — row 3 of the precedence table). The Writes row's description is
  therefore re-worded in this task (S1c's quoted copy — "and no deny rule covers it" + "A matching rule
  can turn that refusal into a prompt"), and `the_writes_row_discloses_the_carve_out_is_a_guard_rail_not_a_boundary`
  moves with matchers that tolerate the new wording (its (a)–(e) legs still pass on "guard-rail, not a
  security boundary"; the strict no-absolute regex is why the re-word exists). The honest T03/T04
  note for the status file: the row now describes the ask path a rule creates, and that path is
  implementable — the copy tracks what T03/T04 ship.
- **The interleaved two-write residual (Decision 1) is recorded, not hidden.** `savePolicy`/`saveRule`/
  `removeRule` compose from the LAST-RENDERED `settings` — the same rendered-document compose
  `useSettingsDocument.patch` uses (and its two-patches pin records). Two writes delivered in one render
  batch therefore compose from the same document and the second save drops the first. This task makes
  the window OBSERVABLE (the S2b interleave pin asserts the final `saveSettings` argument carries both a
  posture change and a rules change performed in one flow — red if the compose drops one) and absorbs
  it deliberately: the immediate-save UI means interleaved writes require back-to-back user actions
  within one render turn, no state ref or store read is introduced (the no-new-abstractions restraint),
  and `patch`'s compose stays a pinned behaviour. A future task that widens the window (e.g. T04's
  Supervisor relay writing rules while a posture select saves) must revisit this pin first.
- **`SettingsPage.test.tsx` churn is contained but real.** Ten `it` strings move or change (named
  exactly in S1c — the eight relocated rows/bodies, the rewritten `changing_the_reads…`, and the new
  two-write interleave pin in S2b); the nav pin grows by one; the `go` union and chain grow. Each is
  deliberate — the moved tests pin the same behaviours in the new section, and the fixture's
  `filePolicy` deliberately gains no `rules` key so `flipping the toggle…` / `flipping the naming
  switch…` / `flipping the alert switch…` (all assert `saved.filePolicy`
  `toEqual(baseSettings.filePolicy)`) stay green unchanged.
- **A red in an unowned file is reported, not fixed.** `src/App.test.tsx` hand-writes store state key
  lists but no nav labels; `UpdateSection`, `WebSearchSection`, `SessionsSection` state/store labels are
  untouched. If the full suite reddens anywhere outside the owned set, STOP and report the file + the
  failing test in `## Risks` (the orchestrator owns triage). Do not edit it.
- **The default-rules offer re-appears after a user deletes all rules — chosen and pinned (Decision 4).**
  The offer's gate `(rules ?? []).length === 0` cannot distinguish "never seeded" from "user deleted all
  rules" (empty and absent are byte-identical on the wire), so the offer comes back every time the list
  hits zero. Option (a) accepted: the copy already labels the deny rule deletable, re-adding a deleted
  default is harmless, and a page-local suppression flag would be the settings UI's first state sentinel
  with nothing to buy. Pinned by
  `"the default-rules offer re-appears after the last rule is removed (an empty list is the offer's only gate)"`.
  A future "never show again" (docs follow-up, T07) must change the predicate or add the flag AND revisit
  this pin.
- **`PolicyRow`'s copy is the "moves intact" guarantee.** The spec forbids re-implementing the
  `hideSandbox`/`sandboxDisabled` logic; the plan's guarantee is a byte-identical copy whose behaviour
  is proven by the moved tests (which exercise `getAppInfo`/`shellSandboxAvailable` at the mock boundary,
  so they work identically from the new file).

---

## Out of scope (deliberately left for other tasks — named, not skipped)

- **T05 (frontend-prompt, DONE — `6fd3740`)** — the wire types + prompt store + guard-prompt UI that
  T06 builds on; nothing here re-derives or re-plans it.
- **T02 / T03 / T04 (Rust)** — `PermissionOutcome::Selected { option_id, value }`, per-prompt option
  lists, dropping `trust-space` from the guard prompt (T02); the rule-precedence enforcement at the gate
  and in the executor, the default-rule freeze, and the `tools/sandbox.rs` rules decision (T03); the
  Supervisor relay persisting `allow-directory` as exactly one rule and the settings round-trip (T04).
  T06 renders and WRITES `filePolicy.rules` through the existing whole-document `save_settings` — it
  does not add commands, does not change the Rust `Settings` struct, and does not touch any
  `src-tauri/` file. The spec's docs follow-up (T07's successor ADR/front-end docs) records Decision 2's
  limitation and the re-worded Writes row's ask-path note (find #5 — the re-word itself ships NOW).
- **T07 (docs)** — ADR 0083 + the ADR 0030 amendment, `CONTEXT.md` terms, and the
  `docs/features/permissions-model.md` page; the default-rules mechanism gap, the re-appearing-offer
  decision (Decision 4), and the Writes row's re-word note hand it their notes.
- **The read path / load defaults** — `config.rs load_settings`'s missing-file branch and the
  `settings.json`-absent semantics are Rust-side and out of this task; nothing here changes the wire
  shape.
- **`src/App.test.tsx` and every other unowned file** — untouched by design (see Risks); a red is
  reported, never edited.