# Grounding report — frontend permission-prompt path

Companion to `docs/roadmap/permissions-section.md` (status: approved). Everything below is
quoted verbatim from the tree at HEAD as of this writing. No design, no recommendations —
what exists today, so a planner never re-reads these files.

Files covered: `src/lib/tauri/types.ts`, `src/lib/tauri.ts` (barrel),
`src/lib/tauri/commands/gates.ts`, `src/lib/tauri/events.ts` (the `listenPermissionRequest`
edge, read only to answer the "how options flow in" question),
`src/store/permissions.ts`, `src/hooks/useChildGates.ts`,
`src/components/PermissionPrompt.tsx`, `src/lib/tauriBarrel.test.ts`,
`src/components/PermissionPrompt.test.tsx`, `src/hooks/useChildGates.test.ts`.

---

## 1. Every relevant type, verbatim (`src/lib/tauri/types.ts`)

These four declarations are contiguous in the file — `PermissionOutcome`, `PermissionOption`,
`PermissionRequest`, then `AcpToolCallStatus`; `PermissionRequestPayload` sits later in the
events section:

```ts
/**
 * The user's decision on a permission prompt. Mirrors the Rust
 * `PermissionOutcome` serde shape: the unit variant serializes to the bare
 * string `"cancelled"`, the struct variant to `{"selected": {"option_id": …}}`.
 */
export type PermissionOutcome =
  | { selected: { option_id: string } }
  | "cancelled";


export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}


/** The agent's `session/request_permission` request (camelCase). */
export interface PermissionRequest {
  sessionId: string;
  toolCall: { toolCallId?: string; title: string };
  options: PermissionOption[];
}
```

```ts
export interface PermissionRequestPayload {
  sessionId: string;
  requestId: string;
  request: PermissionRequest;
}
```

### `FilePolicy`

```ts
/**
 * (ADR 0030) The per-direction file-access policies (the Settings UI's
 * three selects). Every direction defaults to `"allow"`: a pre-feature
 * `settings.json` has no `filePolicy` key and the backend serves
 * all-`allow`, so the UI renders "Don't ask me" everywhere on a fresh
 * install (the UI reads the field nullishly, so a document that predates
 * the field — or a bare mock — still renders the honest default rather than
 * an empty select).
 */
export interface FilePolicy {
  reads: AccessPolicy;
  writes: AccessPolicy;
  /** `bash`. */
  shell: AccessPolicy;
}
```

`AccessPolicy` (the three posture values, quoted for completeness — the `rules` field from
the spec does not exist yet):

```ts
/**
 * (ADR 0030) What happens to a file access that goes BEYOND the boundary.
 * The wire values are the Rust `AccessPolicy`'s serde renames — the UI
 * label for `"allow"` is "Don't ask me" (the label never rides the wire).
 */
export type AccessPolicy =
  /** Refuse it (a tool-result error, never a prompt). */
  | "sandboxed"
  /** Prompt the user. */
  | "ask"
  /** Allow it silently — THE derived default in every direction. */
  | "allow";
```

`FilePolicy` is a field of `AppSettings` (`appSettings.filePolicy: FilePolicy`), but the
`rules` key has no frontend counterpart yet — the only place `FilePolicy` is referenced in
this path is the type re-export (see §2) and `AppSettings`. There is no wire change for
`rules` in the Settings UI today; the spec's `AccessRule` type does not exist anywhere in
`src/`.

### Serde / wire casing convention

The module header of `types.ts` states the convention verbatim:

```
 * Case conventions on the wire (inherited from the file this was split out of):
 * - command arguments: camelCase here (Tauri maps them to snake_case Rust
 *   parameters),
 * - `SessionInfo` (the `start_session` return value): camelCase
 *   (`sessionId`, `cwd`),
 * - event payloads: camelCase (`sessionId`, `requestId`),
 * - ACP update discriminators: snake_case (`agent_message_chunk`, …).
```

The relevant split in this path:
- **Inbound** (event payloads): camelCase — `PermissionRequest` carries `optionId`, `kind`,
  `sessionId`, `toolCall`, `toolCallId`, `title`, `options`.
- **Outbound** (the respond payload): the `PermissionOutcome` struct variant field is
  `option_id` — **snake_case, spelled exactly `option_id`** — while the unit variant is the
  bare string `"cancelled"`. The type's own doc-comment pins how the Rust side serializes:
  `{"selected": {"option_id": …}}`.

### Barrel export of these types

`src/lib/tauri.ts` re-exports all of them in one `export type { … } from "./tauri/types"` block:
`PermissionOutcome`, `PermissionOption`, `PermissionRequest`, `PermissionRequestPayload`,
`AccessPolicy`, `FilePolicy`, `AppSettings` (see §2 for the barrel mechanics).

---

## 2. What `src/lib/tauriBarrel.test.ts` pins about the barrel

The barrel file opens with a "RE-EXPORT BARREL. IT IS LOAD-BEARING" banner; the test file's
header calls itself "THE `lib/tauri` BARREL GUARD … a source scanner, not a linter" protecting
the `vi.mock` seam:

```
 * WHY THIS FILE IS THE ACCEPTANCE CRITERION, NOT A FORMALITY
 * … **35 test files `vi.mock` `@/lib/tauri`
 * BY MODULE PATH** (34 spreading `vi.importActual` — both counts pinned by the
 * assertion below rather than carried by hand; …)
```

The critical answer to "does a planner adding a type need a barrel-test entry": **yes.**
The test asserts the barrel's surface equals a hand-written LITERAL name list, and it
explicitly refuses to derive the expectation from the file under test:

> The list below is the export set of `src/lib/tauri.ts` measured at the commit
> BEFORE the split (107 names: 58 types + 49 functions). It is a LITERAL on
> purpose, for the same reason `tauri.test.ts` pins command names as literals
> and `ipc/events.test.ts` refuses to read `IPC_EVENTS` back: recomputing the
> expectation from the file under test makes the guard green on any change. A
> name may only enter or leave this list on purpose, in a commit that says so.

The relevant assertions, quoted verbatim:

```ts
const TAURI_PUBLIC_API = [
  "AccessPolicy",
  …
  "FilePolicy",
  …
  "PermissionOption",
  "PermissionOutcome",
  "PermissionRequest",
  "PermissionRequestPayload",
  …
];
```

```ts
/** The 49 RUNTIME values (the rest are type-only and vanish at runtime). */
const TAURI_RUNTIME_API = [
  …
  "respondInteractiveRequest",
  "respondPermission",
  …
];
```

The `it` blocks that consume these (enumeration mechanics):

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

`reexportedNames` is a regex over `export (?:type\s+)?\{([^}]*)\}\s*from` lines; `exportedNames`
matches `^export (?:declare )?(?:async function|function|interface|type|const|let|class) NAME`.
The list therefore only changes when a name is added to the barrel's `export type { … }` /
`export { … }` blocks **and** to the `TAURI_PUBLIC_API` literal **and** (for runtime values)
to `TAURI_RUNTIME_API`. A new type exported through the barrel without a matching literal
addition reddens `"the barrel re-exports the exact pinned public API"`.

Also relevant if a planner touches anything outside `src/lib/tauri/`: the direct-import ban
and the mock-seam count:

```ts
  it("no file outside src/lib/tauri/ imports a domain module directly", () => {
    // THE guard. See the header for why a violation is green-but-broken.
    expect(directDomainImports()).toEqual([]);
  });
```

```ts
    // SET SIZE, pinned: 36 files mock the barrel by path. …
    expect(mockers).toHaveLength(36);
    // 35 of the 36 SPREAD `vi.importActual`, …
    expect(
      mockers.filter((f) =>
        /vi\.importActual/.test(readFileSync(f, "utf8")),
      ).length,
    ).toBe(35);
```

Barrel-import rule (from the barrel's own header): nothing outside `src/lib/tauri/` may import
a domain module directly — `import { respondPermission } from "@/lib/tauri"` is the only legal
route.

---

## 3. `respondPermission` (`src/lib/tauri/commands/gates.ts`)

Full signature and body, verbatim:

```ts
export async function respondPermission(
  sessionId: string,
  requestId: string,
  outcome: PermissionOutcome,
): Promise<void> {
  return invoke("respond_permission", { sessionId, requestId, outcome });
}
```

Serialization: the `outcome` value is passed through to Tauri's `invoke` verbatim as the
`outcome` argument — **there is no explicit transformation in this function**. The wire shape
comes from the `PermissionOutcome` type itself: `{ selected: { option_id: "…" } }` or the bare
string `"cancelled"`. Tauri's camelCase↔snake_case argument mapping (stated in the file's
module doc, same convention as the barrel header) handles `sessionId`/`requestId`, and the
`option_id` key is already spelled in the TS object literal — a planner adding an optional
`value` to the selected payload (per the spec's `Selected { option_id: String, value:
Option<String> }`) would extend the `{ selected: { option_id: string } }` arm of
`PermissionOutcome` — nothing in this function would need to change, because it forwards the
object as-is.

The module doc for the file (which a planner should keep accurate — it states the pairing
rationale):

```
 * The two commands that ANSWER a gate — the two shapes of "the Agent is paused,
 * waiting for the user": `session/request_permission` (a permission prompt) and
 * the delegated interactive request (`ask` / `confirm` / `password`).
 *
 * They sit together because the components that call them do too —
 * `InlineGateRow` renders `PermissionPrompt` or `AskQuestionCard` — and because
 * both push a user decision back into an in-flight turn. The `listen*` side of
 * the same two gates is in `../events.ts`; the pairing is by DOMAIN, and the
 * command/listen split is kept because an `invoke` has no business in the events
 * module.
```

The inbound side (how a prompt gets to the store) is `listenPermissionRequest` in
`src/lib/tauri/events.ts`:

```ts
export function listenPermissionRequest(
  callback: (payload: PermissionRequestPayload) => void,
)
```

(It wraps `listen<PermissionRequestPayload>(IPC_EVENTS.permissionRequest, …)`.) The single
production consumer is `src/App.tsx`:

```ts
      listenPermissionRequest((payload) =>
        usePermissions
          .getState()
          .addPrompt(payload.sessionId, payload.requestId, payload.request),
      ),
```

---

## 4. `src/store/permissions.ts`

Whole file is 58 lines; the state shape, verbatim:

```ts
export interface PermissionPromptData {
  /** JSON-RPC id of the agent's request (carried in the event payload). */
  requestId: string;
  toolTitle: string;
  options: PermissionOption[];
}

interface PermissionsState {
  /** Pending prompts, keyed by session id. */
  prompts: Record<string, PermissionPromptData[]>;
  addPrompt: (
    sessionId: string,
    requestId: string,
    request: PermissionRequest | unknown,
  ) => void;
  removePrompt: (sessionId: string, requestId: string) => void;
  /** Dismiss every prompt for a session (session closed). */
  dismissSessionPrompts: (sessionId: string) => void;
}
```

The store is `create<PermissionsState>((set) => ({ … }))` exported as `usePermissions`.
Writer actions: `addPrompt` (filters-then-appends per session, deduping on `requestId`),
`removePrompt`, `dismissSessionPrompts`.

### How `options` flows in — and what survives

`addPrompt` builds `PermissionPromptData`, verbatim:

```ts
  addPrompt: (sessionId, requestId, request) =>
    set((state) => {
      const req = request as PermissionRequest | undefined;
      const data: PermissionPromptData = {
        requestId,
        toolTitle: req?.toolCall?.title ?? "Permission requested",
        options: req?.options ?? [],
      };
      const existing = (state.prompts[sessionId] ?? []).filter(
        (p) => p.requestId !== requestId,
      );
      return {
        prompts: { ...state.prompts, [sessionId]: [...existing, data] },
      };
    }),
```

**Answer to the "would an extra field on an option survive?" question: yes — by nothing.
The store never destructures or re-maps options; the whole array is copied through
(`options: req?.options ?? []`). An extra field on a `PermissionOption` object would survive
the store today only insofar as the type/`tsc` tolerates it.** What is NOT tolerant:
- `PermissionOption` itself (the type says `{ optionId, name, kind? }`).
- `PermissionPrompt.tsx`'s payload construction (§5), which rebuilds the wire object from
  `option.optionId` alone — anything else on the option is **dropped at the respond site**
  unless the component is changed.
- `useChildGates`' `ChildGate.options` typing and both `toStrictEqual` pins in
  `useChildGates.test.ts` (§7), which assert the exact field set of the prompt row.

So today the only field that can survive end-to-end without changes is `optionId` (and `name`
for the button label); `kind` is typed but never read anywhere in the tree (see §5). There is
no store mapping that would silently drop a new field — `addPrompt` passes the object
references through — but the downstream type + payload construction + `toStrictEqual` pins
are where a new field would churn.

`sessionId` is deliberately NOT stored on `PermissionPromptData` (it is the store's key);
`requestId` and `toolTitle` are denormalized from the payload, with `toolTitle` falling back
to `"Permission requested"`.

---

## 5. `PermissionPrompt.tsx`

Signature and props:

```tsx
export default function PermissionPrompt({
  sessionId,
  requestId,
}: {
  sessionId: string;
  requestId: string;
}) {
```

It selects its own prompt: `usePermissions((state) => (state.prompts[sessionId] ?? []).find((p) => p.requestId === requestId))`, returns `null` if absent.

### How it renders options (the map, verbatim)

```tsx
      <div
        data-testid="permission-options-row"
        className="flex min-w-0 flex-wrap items-center gap-2 p-3"
      >
        {prompt.options.map((option, i) => (
          <Button
            key={option.optionId}
            variant={i === 0 ? "default" : "outline"}
            size="sm"
            disabled={busy}
            onClick={() => respond({ selected: { option_id: option.optionId } })}
            className="min-w-0 [overflow-wrap:anywhere]"
          >
            {option.name}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => respond("cancelled")}
        >
          Cancel
        </Button>
      </div>
```

### How it constructs the respond payload (verbatim)

```tsx
  const respond = (outcome: PermissionOutcome) =>
    run(() =>
      respondPermission(sessionId, requestId, outcome).then(() =>
        // The prompt is removed locally on success (and auto-dismissed on
        // session-closed by the store — a MAIN session only).
        removePrompt(sessionId, requestId),
      ),
    );
```

…and the per-option click handler builds the literal `{ selected: { option_id: option.optionId } }`
(sqlite the map above). Cancellation sends the bare `"cancelled"`.

### "A fourth button appears for free" — what the component actually does

The map is fully generic over `prompt.options` — any number of options renders, first
(`i === 0`) gets `variant="default"` (primary), every other gets `"outline"`, all disabled
while `busy`. **Nothing in the component hardcodes three, or any count, and nothing
special-cases an option id.** `kind` is never read by the component (nor anywhere else —
the §1 grep across `src/` found no reader of `PermissionOption.kind`; the field is typed but
unused). The spec's claim in `permissions-section.md` ("`PermissionPrompt.tsx` already renders
`prompt.options.map(...)` generically (`:58-64`), so no UI layout work — a fourth button
appears for free") is accurate for RENDERING.

The two places a new option is NOT free:
1. The respond payload above only carries `option_id` — the spec's `value` (the path) exists
   nowhere on the frontend; `PermissionOutcome`'s selected arm would need to grow it, and this
   component's object literal is where it would be emitted.
2. If the option list must become per-prompt with `trust-space` removed from guard prompts,
   NOTHING in the frontend decides which options appear — the list is whatever the Rust side
   emits in the event; the trust-space test (§7) exists precisely because the component renders
   whatever arrives.

The `trust-space` option id appears today only in `PermissionPrompt.test.tsx` and in
`src/App.test.tsx` / `useChildGates.test.ts` fixtures — never in the component or the store.

---

## 6. `useChildGates.ts`

### `ChildGateKind`, verbatim

```ts
/** The four gates a Subagent session can hold on the user. */
export type ChildGateKind = "ask" | "confirm" | "password" | "permission";
```

### How a child's permission gate reaches the UI

`ChildGate` (verbatim; its doc-comment is long, quoting the field block):

```ts
export interface ChildGate {
  /** The SUBAGENT session id — the key every respond command routes on. */
  childSessionId: string;
  /** `SubagentEntry.parentSessionId` — how the overlay excludes the ACTIVE
   * parent's gates (the render-site partition) and how the pending cue
   * attributes a gate to its parent. */
  parentSessionId: string;
  /** `SubagentEntry.agentName` — the attribution chip's text. */
  agentName: string;
  /** The interactive `requestId`, or the permission prompt's `requestId`. */
  requestId: string;
  kind: ChildGateKind;
  /** `InteractiveRequestData.params`; absent for `permission`. */
  params?: Record<string, unknown>;
  /** `PermissionPromptData.toolTitle`; present only for `permission`. */
  toolTitle?: string;
  /** `PermissionPromptData.options`; present only for `permission`. */
  options?: PermissionOption[];
  /** `SubagentEntry.startedAt` — the sort key for the child's arrival order. */
  childStartedAt: number;
}
```

The derivation `childGatesOf(entries, requests, prompts, parentSessionId)` iterates
`Object.values(entries)`, per child pushes interactive gates first (`kind: r.method` for
`isInteractivePause` methods), then the permission branch, verbatim:

```ts
    for (const p of prompts[entry.sessionId] ?? []) {
      gates.push({
        childSessionId: entry.sessionId,
        parentSessionId: entry.parentSessionId,
        agentName: entry.agentName,
        requestId: p.requestId,
        kind: "permission",
        toolTitle: p.toolTitle,
        options: p.options,
        childStartedAt: entry.startedAt,
      });
    }
```

So for the subagent path, **`options` is carried by reference from `PermissionPromptData`
(the store keeps the whole `PermissionPromptData`; `ChildGate.options` aliases
`promptData.options`)**, keyed under the child's session id (`prompts[entry.sessionId]`). A
guard-prompt option's `path` field would ride through this same assignment if it existed on
`PermissionOption`. The hook wrapper is `useChildGates(parentSessionId: string | null)` →
`[]` for `null`, returning `childGatesOf(…, parentSessionId)` memoised on
`[entries, requests, prompts, parentSessionId]`.

Also exported: `childGateKey(g) => `${g.childSessionId}:${g.requestId}`` and
`isInlineChildGate(g) => g.kind === "ask" || g.kind === "permission"`.

The module doc's comment on `ChildGate` — full context already quoted in §6's type — also
records that the only production `interactive-request` emitters are the `ask_flow` and the
sudo flow's two sub-prompts, both handed `"native"`; permission prompts for children go
through `usePermissions`'s same store the main session uses (keyed by the child's sessionId),
and render inline in the parent transcript / `SubagentModals` overlay.

---

## 7. Test conventions and the strings that churn

### `src/components/PermissionPrompt.test.tsx`

Fixtures are **inline objects** — no factory. The shared two-option fixture:

```ts
const request = {
  toolCall: { toolCallId: "tc1", title: "run a tool" },
  options: [
    { optionId: "opt-1", name: "Allow", kind: "allow_once" },
    { optionId: "opt-2", name: "Deny", kind: "reject_once" },
  ],
};
```

…and the trust-space fixture is built inline inside the test via
`usePermissions.getState().addPrompt("s1", "r2", { … options: [ allow / reject / trust-space ] })`
(see below).

All `it(...)` strings in the file, verbatim:

1. `"renders the tool title and every offered option"`
2. `"renders the confirmation treatment with one button per option + Cancel"`
3. `"renders nothing when no prompt is pending for the request id"`
4. `"calls respondPermission with the selected option id"`
5. `"sends the second option id when a different option is chosen"`
6. `"renders one button per option for the 3-option trusted-space payload (guard)"` — the direct pin on the third option; its body asserts

   ```tsx
   expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
   expect(screen.getByRole("button", { name: "Block" })).toBeTruthy();
   expect(
     screen.getByRole("button", { name: "Don't ask again for this Space" }),
   ).toBeTruthy();
   expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
   // First option is primary, the rest (incl. trust-space) are outline.
   const buttons = container.querySelectorAll("button");
   expect(buttons).toHaveLength(4);
   expect(buttons[0].className).toContain("bg-primary");
   expect(buttons[1].className).toContain("border-border");
   expect(buttons[2].className).toContain("border-border");
   // Clicking the third option answers with its option id.
   fireEvent.click(
     screen.getByRole("button", { name: "Don't ask again for this Space" }),
   );
   await waitFor(() =>
     expect(mockedRespond).toHaveBeenCalledWith("s1", "r2", {
       selected: { option_id: "trust-space" },
     }),
   );
   ```

   The comment above this test (quoted, because it states the current contract):
   ```ts
   // The Rust side (Task 2) appends a third `trust-space` option to the
   // permission payload. The component is generic — one button per option,
   // first = primary, the rest = outline — so the third option must appear
   // with ZERO component changes. This guard pins that assumption.
   ```
   The fixture's three options, verbatim:
   ```ts
   options: [
     { optionId: "allow", name: "Allow", kind: "allow" },
     { optionId: "reject", name: "Block", kind: "reject" },
     {
       optionId: "trust-space",
       name: "Don't ask again for this Space",
       kind: "allow",
     },
   ],
   ```

7. `"cancels via the Cancel button"` — pins `respondPermission("s1", "r1", "cancelled")`.
8. `"removes the prompt from the store after answering"`
9. `"announces a failed answer through role=\"alert\" with the pre-migration classes"` — pins the byte-identical `IpcErrorLine` class `"text-ui-sm text-destructive px-3 pb-2"` and that the prompt is NOT removed on failure.
10. `"renders no alert region while nothing has failed"`
11. `"applies min-w-0 and [overflow-wrap:anywhere] to option buttons / container to handle long text gracefully"`

The IPC mock seam (barrel path, spreading actuals):

```ts
// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    respondPermission: vi.fn().mockResolvedValue(undefined),
  };
});
```

Set-up resets stores via `resetStores()` from `../test/resetStores` plus
`mockedRespond.mockReset()` / `mockResolvedValue(undefined)`.

Assertion pins that churn on option lists (beyond the map-agnosticity): tests 1, 2, 6 count
buttons / assert per-option names, pytest 4/5/6 pin `option_id` values in the respond call,
test 6 pins the exact trust-space id/name AND the `length(4)` count. If the guard prompt
loses `trust-space`, test 6's name/expectation/comment and the count all change together, and
"renders every offered option" style pins must track whatever fixture replaces it.

### `src/hooks/useChildGates.test.ts`

Fixtures are **local helper functions** (not a shared fixture module): `entry(sessionId,
parentSessionId, agentName, startedAt)` builds a `SubagentEntry`; `ask(requestId, question)`
builds an `InteractiveRequestData`; `none()` returns fresh empty `{ requests, prompts }`
("fresh per call so a test cannot leak a mutation into the next one"); `beforeEach` resets
all three stores via `useSubagents.setState` / `useInteractive.setState` /
`usePermissions.setState` with `{ entries: {} }` / `{ requests: {} }` / `{ prompts: {} }`.
All `it(...)` strings, verbatim:

1. `"returns [] when there are no subagent entries"`
2. `"surfaces a child's pending ask with its kind, agentName, childSessionId and parentSessionId"` — asserts the WHOLE gate with `toStrictEqual` (field-set is part of the assertion; `params` present, `toolTitle`/`options`/`source` absent).
3. `"surfaces a child's permission prompt with kind 'permission' and its toolTitle + options"` — **the option-list pin**, verbatim:

   ```ts
   prompts.sub1 = [
     {
       requestId: "p1",
       toolTitle: "Run rm -rf /",
       options: [{ optionId: "allow_once", name: "Allow once" }],
     },
   ];
   ```
   ```ts
   expect(gates[0]).toStrictEqual({
     childSessionId: "sub1",
     parentSessionId: "main1",
     agentName: "reviewer",
     requestId: "p1",
     kind: "permission",
     toolTitle: "Run rm -rf /",
     options: [{ optionId: "allow_once", name: "Allow once" }],
     childStartedAt: 1000,
   });
   ```
   Comment above it: "The WHOLE gate, pinned with `toStrictEqual` so the field SET is the assertion … a card must not read a question out of a prompt that has none."

4. `"surfaces confirm and password too (all four kinds come from one derivation)"`
5. `"does NOT return a child of a DIFFERENT parent when a parent id is given (the inline card's scoping)"`
6. `"parentSessionId: null returns EVERY child's gates — the pure core's 'all children' (the overlay's need, the OPPOSITE of the hook's null)"`
7. `"drops a gate whose child has no SubagentEntry (an evicted entry means an unknown parent — the gate has no home)"` — seeds `prompts.sub1 = [{ requestId: "p1", toolTitle: "bash", options: [] }]`.
8. `"drops a request whose method is not a pause on the user (`isInteractivePause` is the ONE predicate that says so)"`
9. `"orders by child arrival, then request arrival (two children, two asks each)"`
10. `"childGateKey is `${childSessionId}:${requestId}` (every consumer imports this exact string)"`
11. `"isInlineChildGate is `ask`/`permission` ONLY — the two kinds that draw a transcript row"`

Then `describe("useChildGates (the hook — the thin store-reading wrapper)")`:
12. `"THE HOOK returns [] for a null parentSessionId (no active session → nothing to scope to) — deliberately the OPPOSITE of childGatesOf(null), do not 'fix' the pure core to match"`
13. `"hands back the SAME array on a re-render that changed no store (the derivation is memoised)"`
14. `"reads the three stores and returns only the given parent's children's gates"` — seeds `prompts: { sub1: [{ requestId: "p1", toolTitle: "bash", options: [] }] }` and asserts `["r1", "p1"]` ordering and the parent filter.

**The trust-space churn surface here:** tests 3 and 14 build permission prompts inline and
assert with `toStrictEqual` / id lists; the strings use `"Allow once"` and
`"allow_once"`. `childGatesOf` forwards `options` by reference, so the pure core needs no
change for an extra option field — only the fixtures/pins above (and `PermissionPromptData` /
`PermissionOption` types) would.

Other files in the store/hook ecosystem that assert option lists (read but not in scope,
for churn awareness): `src/hooks/useSessionStatus.test.ts`, `src/hooks/usePendingSubagentRequests.test.ts`,
`src/hooks/useAttentionAlert.test.ts`, `src/hooks/useHasPendingRequest.test.ts`, `src/App.test.tsx`,
`src/components/SubagentModals.test.tsx`, `src/components/SubagentTranscript.test.tsx`,
`src/test/fixtures.test.ts` — all seed `usePermissions.getState().addPrompt(...)` and several
use `options: [{ optionId: "allow_once", name: "Allow once" }]`.

---

## 8. Exact commands to run just these tests (repo root)

`package.json`: `"test": "vitest run"`, package manager `pnpm@11.7.0`. Vitest config lives in
`vite.config.ts` (`test: { environment: "jsdom", globals: true, setupFiles:
["./src/test/setup.tsx"], testTimeout: 20_000 }`). No `vitest.config.*` file exists, so the
config path is the Vite root config.

Scoped forms that work from `/home/daniel/Coding/AI/archimedes-desktop`:

```
pnpm test -- src/components/PermissionPrompt.test.tsx
pnpm test -- src/hooks/useChildGates.test.ts
pnpm test -- src/lib/tauriBarrel.test.ts
```

All three at once (space-separated paths are accepted by vitest's positional filter):

```
pnpm test -- src/components/PermissionPrompt.test.tsx src/hooks/useChildGates.test.ts src/lib/tauriBarrel.test.ts
```

Any relative path form vitest accepts also works (a leading `./` or a plain filename is
fine), and the `npx vitest run <path>` equivalent is valid since vitest is a devDependency:

```
npx vitest run src/components/PermissionPrompt.test.tsx
```

Do NOT use a bare `pnpm test` (that is the whole suite — 152 files / 3203 tests at spec
baseline). Note `tauriBarrel.test.ts` needs the full `src/` tree present (it scans all
`.ts/.tsx` under `src/` with Node's `fs`), so it must be run from the repo root.

---

## 9. Already implemented (spec items that exist on the frontend today)

- **Generic option rendering with no hardcoded count**: `PermissionPrompt.tsx` renders
  `prompt.options.map(...)` with `variant={i === 0 ? "default" : "outline"}` — the spec's
  "fourth button appears for free" premise. The trust-space test (#6 in §7) pins that a third
  option renders with zero component changes.
- **`PermissionOption.kind`** — the optional wire field exists in the type and in every
  fixture (values `"allow"`, `"reject"`, `"allow_once"`, `"reject_once"`, `"trust-space"`),
  but nothing reads it.
- **Cancellation path**: `"cancelled"` unit outcome exists in `PermissionOutcome`, the
  component, and the store/UI.

NOT implemented (confirmation that the spec's asks are all absent from the frontend):
- `rules` / `AccessRule` on `FilePolicy` (type, store, or Settings UI) — `FilePolicy` is
  exactly `{ reads, writes, shell }`.
- A `value` field on the selected outcome — `PermissionOutcome` is exactly
  `{ selected: { option_id: string } } | "cancelled"`; the respond payload emits only
  `option_id`.
- Any `"allow-directory"` option id anywhere in `src/` (grep for `allow-directory` across
  `.ts*` files: zero hits; `trust-space` appears only in tests/fixtures as a pass-through
  value, never as frontend logic).
- No per-prompt option-list logic anywhere (the Rust-emitted list is rendered as-is).
- Settings-side: `type Section` in `SettingsPage.tsx:50` is exactly
  `"general" | "appearance" | "providers" | "mcp" | "sessions" | "web-search" | "updates"`
  — **no `"permissions"` member, and no `PermissionsSection` file** in
  `src/components/settings/` (dir listing: `AppearanceSection`, `ClearDetachedSessionsDialog`,
  `controls`, `GeneralSection`, `McpSection`, `primitives`, `ProviderSection`,
  `SessionsSection`, `SettingsPage`, `UpdateSection`, `WebSearchSection` — plus their tests).
- **BUT the pieces the spec says get MOVED exist** and are exactly where the spec says:
  `PolicyRow` is a **local, non-exported function inside `src/components/settings/GeneralSection.tsx`
  (line 60)** — signature `function PolicyRow({ label, description, value, onChange,
  hideSandbox = false, sandboxDisabled = false }: { label: "Reads" | "Writes" | "Shell";
  description: ReactNode; value: AccessPolicy; onChange: (value: AccessPolicy) => void;
  hideSandbox?: boolean; sandboxDisabled?: boolean }): ReactElement`, rendering a `SettingsRow`
  + `Select` with the `sandboxed`/`ask`/`allow` items and the live `hideSandbox` /
  `sandboxDisabled` handling (the `"Sandboxed (unavailable here)"` trigger label when
  `hideSandbox && value === "sandboxed"`; the disabled-with-reason `Sandboxed` item). It is
  instantiated three times in that file (lines 165/186/206), with
  `hideSandbox={!shellSandboxAvailable}` / `sandboxDisabled={!shellSandboxSupported}` on the
  Shell row (lines 232-233). Because it is a module-private function in `GeneralSection.tsx`,
  "the `PolicyRow` component moves intact" requires exporting or relocating it — it is NOT
  importable from anywhere today.

**Sources** (all under `/home/daniel/Coding/AI/archimedes-desktop`):
- `src/lib/tauri/types.ts` (§1)
- `src/lib/tauri.ts` (§1, §2)
- `src/lib/tauri/commands/gates.ts` (§3)
- `src/lib/tauri/events.ts` (§3)
- `src/App.tsx` (§3 — the `listenPermissionRequest` → `addPrompt` edge)
- `src/store/permissions.ts` (§4)
- `src/components/PermissionPrompt.tsx` (§5)
- `src/hooks/useChildGates.ts` (§6)
- `src/lib/tauriBarrel.test.ts` (§2)
- `src/components/PermissionPrompt.test.tsx` (§7)
- `src/hooks/useChildGates.test.ts` (§7)
- `package.json`, `vite.config.ts` (§8)
- `docs/roadmap/permissions-section.md` (the spec this grounds; quoted where the report
  evaluates a spec claim)