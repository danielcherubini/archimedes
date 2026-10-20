---
status: committed
issue: https://github.com/danielcherubini/archimedes/issues/72
done-when: With two Spaces open, the sidebar's Archived section under tab A lists only A's archived sessions and counts only A's; a stored Session of a closed Space is listed in Settings → Detached sessions with its folder path, and is either reopened into a tab or deleted from there — individually, or in one counted confirm. `pnpm test` and `pnpm build` green.
---

# Space-scoped Archived section + Settings → Detached sessions — Plan

**Goal:** Stop the sidebar's Archived section listing every Space's archived sessions, and add the Settings surface that keeps a session with no open Space tab reachable (and deletable) once it no longer appears in the sidebar.

**Architecture:** Frontend-only. Two independent halves: (1) a one-predicate filter in `src/components/SpacesList.tsx`; (2) a new `Settings → Detached sessions` section listing every **Detached** session (CONTEXT.md — a stored session whose `cwd` matches no Space row), driven by one new pure derivation in `src/store/sessions.ts` and one new confirm dialog. No Rust change: `list_sessions(true)` already returns every stored row app-wide and `App.tsx` already calls it at boot.

**Tech Stack:** React 19 + TypeScript, zustand (`useSessions`), Vitest + Testing Library, Tailwind, lucide-react, the app's `ui/dialog` primitives.

Spec rationale: `docs/decisions/0016-session-archive-first-delete.md` (amendment, 2026-10-21) and CONTEXT.md's **Archived session** / **Detached session** entries.

## Two corrections to the approved spec

Both were found by reading the code the plan must call. They are recorded here so the executed plan and the reviewer see the reasoning, not just the difference.

1. **`detachedSessions` takes a fourth parameter.** The spec sketched `(spaces, historySessions, archivedSessions)`. Live ids are NOT absent from those two lists: `CloseSpaceDialog`'s "Close anyway" path calls `closeSpace(path)` with no `stopSessionIds` (ADR 0043), which removes the Space row and leaves the **Workers live**, and a resumed archived session stays in `archivedSessions` by the sticky rule. So a LIVE session with no Space row is reachable, and excluding live ids requires the live list. Task 1 takes `liveSessions: SessionInfo[]` as the fourth argument.
2. **"Reopen Space" must also leave Settings.** `SettingsPage` is a full content-area view swapped in by `App`'s `view` state, and it already receives `onBack`. A row that only called `addSpace` + `openSession` would vanish from the list while the user stayed in Settings with nothing visibly happening. Task 4's section therefore takes `onBack: () => void` and calls it after the reopen.

---

## Parallelisation

**Verdict:** PARALLEL — 2 waves

- **Wave 1:** Task 1, Task 2, Task 3 — pairwise disjoint `Files:` (store vs. sidebar vs. the new dialog), no cross-imports, each provable by its own test file.
- **Wave 2:** Task 4 — imports Task 1's `detachedSessions` and Task 3's `ClearDetachedSessionsDialog`, and edits `SettingsPage.tsx` + `SettingsPage.test.tsx`, so it cannot join Wave 1 (gate 2).

Gate 3 checked against the commands, not just the file lists: every in-wave verification is a scoped `pnpm exec vitest run <one test file>`. This repo has **no** snapshot files (`find src -name '*.snap'` → none) and no tree-wide formatter or lint step (`package.json` has no `lint`/`format` script), so a scoped Vitest run writes no shared artifact. `pnpm exec` does not re-resolve `pnpm-lock.yaml`. The full suite runs once after Wave 1 and again after Task 4, serially.

---

### Task 1: The `detachedSessions` derivation

**Parallel:** wave 1 — disjoint from Task 2 (`src/components/SpacesList.tsx`, `src/components/SpacesList.test.tsx`) and Task 3 (`src/components/ClearDetachedSessionsDialog.tsx` and its test); imports nothing either creates.

**Context:**
The sidebar files every session row under a **Space** tab, so a stored **Session** whose `cwd` matches no Space row is invisible in the sidebar entirely. CONTEXT.md now names this a **Detached session**. Closing a tab *forgets* the Space and deletes nothing (ADR 0043 — `closeSpace` → `removeSpace` touches no `sessions` row), so such rows are normal, not corrupt, and once the sidebar's Archived section is Space-scoped (Task 2) they need their own surface. That surface (Task 4) needs one derivation, and the derivation goes where the store's other Space derivations already live so it is assertable without mounting Settings.

**Files:**
- Modify: `src/store/sessions.ts` (add an exported pure function beside `liveSessionsInSpace` / `mostRecentLiveInSpace` / `spaceViewFor`, i.e. in the 135–260 region)
- Test: `src/store/sessions.test.ts` (append a new `describe`)

**What to implement:**

Add to `src/store/sessions.ts`:

```ts
export function detachedSessions(
  spaces: { path: string }[],
  historySessions: SessionInfo[],
  archivedSessions: SessionInfo[],
  liveSessions: SessionInfo[],
): SessionInfo[]
```

Behaviour, precisely:

- A row is detached when **no** `space.path` equals its `cwd`. This is the same raw string equality every other Space↔session join in this file already uses (`liveSessionsInSpace`, `spaceViewFor`'s `storedSessionIds`/`archivedSessionIds` filters) — do NOT normalise or canonicalise the path here, because the equality those sites rely on is byte-for-byte and a normalised key here would silently disagree with them.
- Live ids are excluded: build a `Set` from `liveSessions.map((s) => s.sessionId)` and drop any row whose `sessionId` is in it. Required, not defensive — see correction 1 above.
- Input order is preserved, `historySessions` first then `archivedSessions`: `[...historySessions, ...archivedSessions].filter(...)`. Do **not** sort. `sortByActivity` cannot be used here because it needs loaded transcripts, which this section has none of, and `SessionInfo` carries no `createdAt` (the store's ordering note says so explicitly). Say this in the doc comment, because the resulting order — stored rows in `list_sessions` order, then archived rows — is the kind of thing a later reader would otherwise "fix".
- Doc comment must name the term (**Detached session**, CONTEXT.md), the ADR (0016 amendment, 2026-10-21), and the fact that this is a view property of the sidebar and sets no flag.
- Do NOT add a store field, action, or subscription, and do NOT touch `setHistorySessions` (boot-only by design — every stored row is in memory from boot and `deleteSession` already removes ids from all three lists, so no invalidation is needed).

**Steps:**
- [ ] Write the failing `describe("detachedSessions", …)` in `src/store/sessions.test.ts` with these pins:
  - a row whose `cwd` is an open Space (`spaces: [{ path: "/tmp/alpha" }, …]`) is **not** returned;
  - a row whose `cwd` matches no Space path **is** returned, whether `archived: true` or `archived: false`;
  - a row whose `sessionId` appears in `liveSessions` is **not** returned even when its `cwd` matches no Space (the Close-anyway case);
  - a row whose `cwd` matches no Space and whose folder does not exist on disk is returned (the deleted-folder case — nothing here touches the filesystem);
  - `[]` when every row's `cwd` is an open Space;
  - order: stored-then-archived, input order preserved.
  Build the `SessionInfo` literals inline (`{ sessionId, cwd, capabilities: {}, archived }`, the shape `src/components/SpacesList.test.tsx:336` already uses) — nothing in these pins needs the store's `setState`.
- [ ] Run `pnpm exec vitest run src/store/sessions.test.ts`
  - Did it fail with `detachedSessions is not a function` / an import error? If it passed unexpectedly, stop and investigate.
- [ ] Implement the function in `src/store/sessions.ts`.
- [ ] Run `pnpm exec vitest run src/store/sessions.test.ts` — all green?
- [ ] Run `pnpm build` — `tsc` clean (note `noUnusedLocals` / `noUnusedParameters` are on)?
- [ ] Commit: `feat(store): a detachedSessions derivation for sessions with no open Space`
  - **Wave task:** do NOT commit — the orchestrator commits `src/store/sessions.ts src/store/sessions.test.ts` with this message after the wave.

**Acceptance criteria:**
- [ ] `detachedSessions` is exported from `src/store/sessions.ts` and returns exactly the rows whose `cwd` matches no Space path, minus live ids, in stored-then-archived input order.
- [ ] No new store state or actions; `git diff` on `src/store/sessions.ts` adds only the one function.

---

### Task 2: Space-scope the sidebar's Archived section, and drop its Space suffix

**Parallel:** wave 1 — disjoint from Task 1 (`src/store/sessions.ts` + its test) and Task 3 (the new dialog); `ArchivedSection` does not import `detachedSessions` (its predicate is `cwd === activeSpacePath`, inline).

**Context:**
`ArchivedSection` (`src/components/SpacesList.tsx:964`) reads the whole `archivedSessions` slice and filters out only live ids, so it lists every Space's archived sessions while one Space tab is selected, and its header count reports the app-wide total. It was written as a deliberate cross-space flat list (its comment cites ZCode's `WorkspaceArchivedTasksFlatSection`) and its row carries a `· {spaceName}` suffix to disambiguate that. Scoping it to the active Space removes the noise; the suffix becomes dead weight, because a Space-scoped row can never belong to another Space. Reachability is Task 1 + Task 4's job — do not add a fallback listing here.

**Files:**
- Modify: `src/components/SpacesList.tsx` (`ArchivedSection`, `ArchivedSessionRow`)
- Test: `src/components/SpacesList.test.tsx`

**What to implement:**

1. In `ArchivedSection`, subscribe to the active Space and add the predicate, keeping the live-id filter exactly as it is (that filter is the sticky rule — CONTEXT.md "Archived session" — which stops a resumed archived session rendering in both the Space group and this section):

```ts
const activeSpacePath = useSessions((s) => s.activeSpacePath);
const visible = archived.filter(
  (s) =>
    s.cwd === activeSpacePath &&
    !sessions.some((l) => l.sessionId === s.sessionId),
);
```

2. Delete the `showSuffix` variable and the `{showSuffix && (<span …> · {spaceName}</span>)}` block from `ArchivedSessionRow`. Keep `spaceName` itself — `titleFor(messages, spaceName, session.title)` still needs it as the last-resort title. Keep the `maskImage` styling on the title span.
3. Rewrite both doc comments. They currently assert the opposite of the new behaviour: `ArchivedSection`'s says "The flat, cross-space Archived section (ZCode's `WorkspaceArchivedTasksFlatSection` model …)" and `ArchivedSessionRow`'s says the suffix is needed because the section "is cross-space". Replace with: the section is the **active Space's** archived rows; the header count is that Space's count; with no Space selected (`activeSpacePath === null`) `cwd === null` matches nothing and the existing "No archived sessions." empty state renders, which is honest — those rows are **Detached** and live in Settings → Detached sessions.
4. Keep the empty-state paragraph text unchanged, so the existing "No archived sessions." assertions still read.

**What NOT to change:** `spaceViewFor` / `SpaceView.archivedSessionIds` (view membership only — it makes a Space whose sessions are all archived still resolve its `view`, and Task 2's change does not affect it); the `Archived` header's icon/chevron/count markup; the Unarchive and Delete buttons; `handleSessionClosed`'s sticky guard; anything under `src-tauri/`.

**Steps:**
- [ ] Write the failing pins in `src/components/SpacesList.test.tsx`, in the `describe("SpacesList (archive, ADR 0016)", …)` block. Reuse the file's `seedArchived` helper (it seeds `cwd: "/tmp/alpha"`, and `seed()` sets `activeSpacePath: "/tmp/alpha"`):
  - an archived row with `cwd: "/tmp/beta"` is **absent** from the expanded section while `activeSpacePath` is `/tmp/alpha` (add a second row to the store with `archived: true`, `cwd: "/tmp/beta"`);
  - the header count counts the active Space only: seed one `/tmp/alpha` + two `/tmp/beta` archived rows → the header badge reads `1`, not `3`;
  - with `activeSpacePath: null` the section renders "No archived sessions." even though archived rows exist;
  - the suffix is gone: the existing test at ~line 2553 (`shows the titled archived row as \`{title} · {spaceName}\` (the space cue stays for a GENERATED title)`) must be **rewritten, not deleted** — assert `textContent` is exactly the generated title with no `· ` suffix, and retitle it to say the Space cue is gone because the section is Space-scoped. Use an EXACT `getByText("Archiving the log rotation")`, not the current `/^Archiving the log rotation/` prefix regex: the prefix form exists only because the suffix used to make a second nested span (the comments at `:1922` and `:1978` say so), and leaving the regex in place would let a future re-added suffix span throw on a multi-node match instead of failing the assertion.
- [ ] Run `pnpm exec vitest run src/components/SpacesList.test.tsx`
  - Do the new negative pins fail, and does the rewritten suffix test fail with `· alpha` still present? If any passes early, stop and work out why before implementing.
- [ ] Implement 1–4 above in `src/components/SpacesList.tsx`.
- [ ] Run `pnpm exec vitest run src/components/SpacesList.test.tsx` — all green? The file's other archived tests (`the Archived section is collapsed by default…`, `unarchive moves the row back`, `delete from the Archived section confirms and removes`, `a live session that is also archived is view-filtered out…`, `New Session with an archived session active…`) must still pass: they all seed `/tmp/alpha` and match on prefix regexes, so the filter and the dropped suffix are both invisible to them. If one breaks, that is a real regression, not a fixture to adjust.
- [ ] Run `pnpm build` — `tsc` clean (an unused `showSuffix` removal must not leave `spaceName` unused: it is still passed to `titleFor`).
- [ ] Commit: `feat(sidebar): the Archived section is scoped to the active Space`
  - **Wave task:** do NOT commit — the orchestrator commits `src/components/SpacesList.tsx src/components/SpacesList.test.tsx` with this message after the wave.

**Acceptance criteria:**
- [ ] With `activeSpacePath` `/tmp/alpha`, an archived `/tmp/beta` row renders nowhere in the sidebar.
- [ ] The header count equals the active Space's non-live archived row count.
- [ ] No archived row anywhere renders a `· {spaceName}` suffix.
- [ ] A resumed (live) archived session still renders exactly once, in its Space group.

---

### Task 3: The `ClearDetachedSessionsDialog` confirm

**Parallel:** wave 1 — creates its own new component + test file; takes plain props (`count`, `folderNames`, `onConfirm`, `onClose`) so it imports neither Task 1's derivation nor anything Task 2 touches.

**Context:**
Task 4's section carries the app's only bulk destructive action: delete every Detached transcript at once. ADR 0016's amendment accepts it *because* it sits in a surface reached only on purpose, and requires the confirm to name the blast radius — the count is the number that matters, the folder names are what tell you whether this is the sweep you meant. `DeleteSessionDialog` is the shape to follow: `ui/dialog` with `showCloseButton={false}`, so Cancel/Escape are the only exits, and a `destructive` confirm button.

**Files:**
- Create: `src/components/settings/ClearDetachedSessionsDialog.tsx`
- Test: `src/components/settings/ClearDetachedSessionsDialog.test.tsx`

**What to implement:**

```ts
export default function ClearDetachedSessionsDialog({
  count,
  folderNames,
  onConfirm,
  onClose,
}: {
  count: number;
  folderNames: string[];
  onConfirm: () => void;
  onClose: () => void;
}): ReactElement
```

- `Dialog open` + `onOpenChange={(open) => { if (!open) onClose(); }}` and `<DialogContent showCloseButton={false} className="sm:max-w-md">` — copy `src/components/DeleteSessionDialog.tsx`'s structure exactly, including the `DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogFooter` composition and the `<Button variant="ghost" onClick={onClose}>Cancel</Button>` + `<Button variant="destructive" onClick={onConfirm}>` footer.
- `DialogTitle`: `Delete {count} detached sessions from {folderNames.length} folders?` — the count AND the folder count, because ADR 0016's amendment requires the confirm to "name the count and the folders". The folder count is `folderNames.length` and NOT a separate prop: Task 4 passes DISTINCT folder names, so a second `folderCount` prop would be one more thing that can disagree with the list beneath it. Keep the title and the list both — the title is the number you read, the list is the evidence.
- Above the description, a list of `folderNames` — one per line, `truncate text-ui-sm text-foreground-subtle`, each in a plain `<div>`, inside a `<div className="max-h-40 space-y-0.5 overflow-y-auto">`. The scroll container is required, not cosmetic: `src/components/ui/dialog.tsx`'s `DialogContent` sets no `max-h` and no `overflow-y-auto`, so a dialog whose body is long grows past the viewport and puts the footer's Cancel/Delete out of reach — `DeleteSessionDialog` gets away with it only because its body is one line. Do not inherit that precedent.
- Sort with `[...folderNames].sort()` at the render site so the dialog's own text is deterministic (the caller may pass them in store order).
- `DialogDescription`: state plainly that this permanently removes these sessions' transcripts from Archimedes' storage and cannot be undone — and that the sessions belong to Spaces that are not open, so they can also be removed one at a time from this list. Do not soften it: this is the widest destructive action in the app.
- Confirm button label: `Delete {count} sessions`.
- Keep it presentational: no store access, no IPC, no `useSessions`. Task 4 owns the deletion.

**Steps:**
- [ ] Write `src/components/settings/ClearDetachedSessionsDialog.test.tsx`: render with `count={3}`, `folderNames: ["/tmp/beta", "/tmp/gamma", "/tmp/delta"]`, and pin (a) the title reads `Delete 3 detached sessions from 3 folders?`, (b) all three folder names are in the document, (c) clicking Cancel calls `onClose` and not `onConfirm`, (d) clicking the destructive button calls `onConfirm`, (e) the rendered folder list is in sorted order when the props arrive unsorted. Use the `within(screen.getByRole("dialog"))` scoping pattern from `src/components/SpacesList.test.tsx:2575` so the row/dialog text ambiguity cannot bite.
- [ ] Run `pnpm exec vitest run src/components/settings/ClearDetachedSessionsDialog.test.tsx`
  - Fails on the missing module? Good. If it passes, stop and investigate.
- [ ] Implement the component.
- [ ] Run `pnpm exec vitest run src/components/settings/ClearDetachedSessionsDialog.test.tsx` — green?
- [ ] Run `pnpm build` — `tsc` clean?
- [ ] Commit: `feat(settings): the counted confirm for clearing detached sessions`
  - **Wave task:** do NOT commit — the orchestrator commits the two new files with this message after the wave.

**Acceptance criteria:**
- [ ] The dialog names the count in both the title and the confirm button, and lists every folder passed to it.
- [ ] Cancel and Escape/overlay both route to `onClose`; only the destructive button reaches `onConfirm`.
- [ ] The component imports nothing from `src/store/`.

---

### Task 4: Settings → Detached sessions, the Detached sessions surface

**Parallel:** none — runs after Wave 1. It imports Task 1's `detachedSessions` and Task 3's `ClearDetachedSessionsDialog` (gate 2), and it is the only task editing `SettingsPage.tsx` / `SettingsPage.test.tsx`. As the lone task in its wave it commits normally.

**Context:**
Scoping the sidebar's Archived section (Task 2) makes it stop being the one pane that shows every stored session, so this section is the second door ADR 0016's amendment requires: it lists every **Detached** session — archived or not, because an unarchived session of a closed Space has always been equally invisible — and offers **Reopen Space** (the non-destructive answer) and **Delete** (the existing per-row confirm), plus the counted **Clear all**. It reads the sessions store directly: no new Rust command, no new fetch, nothing to invalidate — `App.tsx:305` loads `listSessions(true)` at boot and `deleteSession` removes ids from all three lists.

**Files:**
- Create: `src/components/settings/SessionsSection.tsx`
- Create: `src/components/settings/SessionsSection.test.tsx`
- Modify: `src/components/settings/SettingsPage.tsx` (the `Section` union at ~line 40, the nav block at ~line 430, the render chain at ~line 475)
- Modify: `src/components/settings/SettingsPage.test.tsx` (the exact nav-order assertion at ~line 1513, and the `section:` helper type at ~line 354)
**What to implement:**

`src/components/settings/SessionsSection.tsx`:

```ts
export default function SessionsSection({
  onBack,
}: {
  onBack: () => void;
}): ReactElement
```

- Read the store with individual selectors (the pattern `SpacesList` uses): `spaces`, `sessions`, `historySessions`, `archivedSessions`, `deleteSession`, `addSpace`, `openSession`, and `messages` for a row's title/time.
- `const detached = useMemo(() => detachedSessions(spaces, historySessions, archivedSessions, sessions), […])`. **The fourth argument is the LIVE list — the store's `sessions` slice, not `historySessions`.** Task 1 excludes live ids because the Close-anyway path can leave a live session with no Space row; passing the stored list there would exclude nothing and let live rows leak into the section.
- Folder names for the dialog: distinct `basenameOfPath(row.cwd)` values (import from `src/lib/paths`) — the dialog shows folder names, not full paths, while each **row** shows the full `cwd`, because this section is cross-Space and the path is the one thing that says which folder a row came from.
- Markup: a `SettingsGroupCard` (`./primitives`) containing a local `DetachedSessionRow` per detached session, following `McpSection.tsx`'s `McpRow` markup (a `<div className="border-t border-border px-4 py-3 first:border-t-0">` with a `min-w-0 flex-1` text column and `variant="ghost" size="icon-sm"` action buttons) rather than `SettingsRow`, which is a label/control grid and wrong for a list. Each row: title via `titleFor(messages[sessionId], basenameOfPath(cwd), title)` (import from `src/lib/sessionTitle` — the one title rule), then the full `cwd` in `truncate text-ui-sm text-foreground-subtle`, then a `SettingsBadge` reading `archived` when `row.archived` is true, then the relative time (the same `<60s`/`<60m`/`Nh` reading `ArchivedSessionRow` prints, from `messages[row.sessionId]`'s last message, rendered ONLY when a transcript happens to be loaded this boot — otherwise an empty `<span className="size-4" />` slot so the buttons stay aligned; copy `relativeTimeFor`'s shape from `src/components/SpacesList.tsx` rather than exporting it, since it is a small local formatter and moving it would mean touching Task 2's file in Task 4's commit), then two ghost buttons: `aria-label={`Reopen space for ${title}`}` (`FolderOpenIcon`) and `aria-label={`Delete ${title}`}` (`Trash2Icon`).
- Empty state: when `detached.length === 0`, render the card with a single `<div className="px-4 py-3 text-ui-base text-foreground-subtle">` reading `No detached sessions. Every stored session belongs to an open Space.` (mirror `McpSection.tsx`'s "No MCP servers yet" row).
- `Clear all` — a `<Button>` below the card (mirroring `McpSection`'s "Add server" button), `disabled={detached.length === 0}`, opening `ClearDetachedSessionsDialog` via local `const [clearOpen, setClearOpen] = useState(false)`. Its `onConfirm`:
  - `const ids = detached.map((r) => r.sessionId);` captured BEFORE the first `await` (the store mutates as each delete lands, and a list read afterwards would be missing the rows already gone);
  - `await Promise.allSettled(ids.map((id) => deleteSession(id)))`, then `console.error` each rejected reason — the precedent for "best-effort, log each failure, still close the dialog" is `closeSpace`'s `Promise.allSettled` + per-rejection `console.error` loop in `src/store/sessions.ts`;
  - `setClearOpen(false)` unconditionally, including on partial failure (a dialog stuck open after a swallowed failure is worse, and the surviving rows stay listed so they can be retried).
- Per-row `Delete` → local `const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null)` → `DeleteSessionDialog` (import from `../DeleteSessionDialog`) with `title` from the same `titleFor` call the row used, `onConfirm` calling `deleteSession(id)` then clearing the target on success AND failure with a `console.error` on failure — copy `SpacesList.tsx:776`'s existing handler shape.
- Per-row **Reopen Space** → `addSpace(row.cwd); openSession(row.sessionId); onBack();` in that order. `addSpace` inserts (or re-touches) the Space row and selects it; `openSession` then finds its owner and loads the transcript; `onBack` leaves Settings so the user lands on the tab they just re-opened (correction 2). `addSpace` is synchronous and takes a plain `path: string`.

`src/components/settings/SettingsPage.tsx`:
- Add `"sessions"` to the `Section` union.
- Add the nav button **between MCP and Web search**: `<SettingsSidebarButton icon={FolderXIcon} label="Detached sessions" active={section === "sessions"} onClick={() => setSection("sessions")} />`. `FolderXIcon` exists in `lucide-react@1.17` (`FolderRestoreIcon` does not — do not reach for it); add it to the existing `lucide-react` import.
- **The label is `Detached sessions`, not `Sessions`, and that is load-bearing twice over.** (a) `src/App.test.tsx:469` (`the_gear_icon_swaps_to_the_settings_view`) asserts `screen.queryByText("Sessions")` is **null** while the Settings view is mounted, to pin that the workspace UNMOUNTS — a nav button whose text is exactly `Sessions` matches that query and reddens an unrelated test. `Detached sessions` does not (Testing Library's string matcher compares normalised whole text content), so `App.test.tsx` needs no edit. (b) The section lists ONLY sessions with no open Space; a nav entry called `Sessions` would promise the full list and show a partial one.
- Extend the render chain ternary with `: section === "sessions" ? <SessionsSection onBack={onBack} />` before the `updatesSection` fallthrough. The `Section` union member stays the short `"sessions"` slug — it is an internal discriminator, never rendered. **Keep the chain's fallthrough order intact** — `updatesSection` is the final `:` arm, so the new arm must be inserted as a tested branch, not left to swallow Updates.

`src/components/settings/SettingsPage.test.tsx`:
- The existing test `the Updates nav button is in the sidebar, after MCP` asserts the nav array with `toEqual` on an EXACT list built from each button's `aria-label` — it must gain `"Detached sessions"` between `"MCP"` and `"Web search"` or it fails.
- **Do NOT route the new section through the file's `go` helper** (~line 353). Its union is `"Appearance" | "Providers" | "MCP" | "Web search"` and its final `else` arm awaits the MCP section's `Add server` button — so a `"Sessions"` member would fall through to that arm and time out. Click the nav button directly and await the Sessions section's own text instead. Leave `go` and its union untouched.

**What NOT to change:** `App.tsx` (Settings routing already exists), `DeleteSessionDialog.tsx`, `primitives.tsx`, the store (Task 1 owns it), `SpaceTabs.tsx`, anything under `src-tauri/`. Do not add sorting, search, grouping-by-folder, a select-rows checkbox UI, or an unarchive control to this section — list, reopen, delete, clear, that is the surface.

**Steps:**
- [ ] Write the failing `src/components/settings/SessionsSection.test.tsx`. Mock `@/lib/tauri`'s `deleteSession` (the pattern `src/components/settings/WebSearchSection.test.tsx` uses: `vi.importActual` + one `vi.fn()`), then seed `useSessions.setState({ spaces: [{ path: "/tmp/alpha", createdAt, lastOpenedAt, trusted: false }], sessions: [], historySessions: [an /tmp/beta stored row], archivedSessions: [an /tmp/gamma archived row], activeSessionId: null, activeSpacePath: "/tmp/alpha", messages: {} })`.
  **How to observe the store actions:** `addSpace` and `openSession` are zustand actions read by selector, so `vi.spyOn(useSessions, …)` cannot see them — override them in the seed, on top of the `setState` above, then **read the fns back out of the store** and assert on those references:

  ```ts
  useSessions.setState({ addSpace: vi.fn(), openSession: vi.fn() });
  const addSpace = useSessions.getState().addSpace as ReturnType<typeof vi.fn>;
  const openSession = useSessions.getState().openSession as ReturnType<typeof vi.fn>;
  ```

  Do not capture the actions before the `setState` (that snapshot holds the real ones) and do not wrap them in `vi.mocked()` (they are store fields, not module mocks). Overriding `openSession` also keeps the Reopen pin from firing a real `loadHistory` IPC into jsdom. The component reads each action with its own selector, which is exactly why a seeded replacement is what it sees.
  Pins:
  - both `/tmp/beta` and `/tmp/gamma` rows render, and each row's full path text is present;
  - `/tmp/alpha`'s rows do NOT render (Task 1's derivation is doing its job — this is the integration pin);
  - `Clear all` is disabled with zero detached rows, and enabled with two;
  - clicking `Clear all` opens the confirm showing `Delete 2 detached sessions from 2 folders?` (the seeded rows are `/tmp/beta` + `/tmp/gamma`, so count 2 and 2 distinct folder names), and confirming calls the mocked `deleteSession` with both ids and closes the dialog;
  - a row's Delete button opens `Delete session?` and only the dialog's Delete button calls `deleteSession`;
  - a row's Reopen button calls `addSpace("/tmp/beta")`, `openSession("…")` and the `onBack` prop;
  - the archived row carries its `archived` badge and the unarchived one does not;
  - a row with a loaded transcript in `messages` renders its relative time, and a row without one renders no time text.
- [ ] Run `pnpm exec vitest run src/components/settings/SessionsSection.test.tsx` — fails on the missing module? If it passes, stop.
- [ ] Implement `SessionsSection.tsx`.
- [ ] Run `pnpm exec vitest run src/components/settings/SessionsSection.test.tsx` — green?
- [ ] Write the failing `SettingsPage.test.tsx` changes: the nav array gains `"Sessions"` in position, plus one test that clicking `Sessions` renders the section and that clicking back to `General` renders `Default model` again (mirror the Updates section tests at ~line 1530). **Do not rely on the file's default store state.** `SettingsPage.test.tsx` seeds `getSettings` but not `useSessions`, and several tests in it call `useSessions.getState().loadSession()` (around `:533`/`:572`/`:615`), so the sessions store is NOT reliably empty by the time a later test in the file runs. The new Sessions test must set what it needs in its own body — `useSessions.setState({ spaces: [], sessions: [], historySessions: [], archivedSessions: [], messages: {} })` — then await `screen.findByText(/^No detached sessions\./)`, and do not assert `Clear all` is enabled here (it is disabled at zero rows). `detachedSessions` is total over empty input (Task 1 pins the `[]` case), so mounting this section against a partially-seeded or empty store cannot throw for the tests that never navigate to it.
- [ ] Run `pnpm exec vitest run src/components/settings/SettingsPage.test.tsx` — the nav test fails before the wiring?
- [ ] Implement the `SettingsPage.tsx` wiring.
- [ ] Run `pnpm exec vitest run src/components/settings/SettingsPage.test.tsx` — green?
- [ ] Run `pnpm test` — the FULL suite green (this is where Task 2's sidebar change is proven not to have broken `App.test.tsx` or `SidePane.test.tsx`)?
- [ ] Run `pnpm build` — `tsc && vite build` clean?
- [ ] Commit: `feat(settings): Sessions section for detached sessions`

**Acceptance criteria:**
- [ ] Settings → Detached sessions lists every stored session whose Space tab is closed, with its folder path, and lists nothing whose Space is open.
- [ ] Reopen Space puts the folder's tab back, opens the session, and leaves Settings.
- [ ] Per-row Delete goes through `DeleteSessionDialog`; Clear all goes through the counted confirm and deletes every listed row best-effort.
- [ ] `pnpm test` and `pnpm build` are green.
