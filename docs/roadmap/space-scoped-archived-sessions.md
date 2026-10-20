---
status: approved
issue: https://github.com/danielcherubini/archimedes/issues/72
done-when: With two Spaces open, the sidebar's Archived section under tab A lists only A's archived sessions and counts only A's; a stored Session of a closed Space is listed in Settings → Sessions with its folder path, and is either reopened into a tab or deleted from there — individually, or in one counted confirm. `pnpm test` and `pnpm build` green.
---

# Space-scoped Archived section, and the Settings surface that makes it safe

Two changes, and only the first is the one that was noticed.

The sidebar's **Archived** section is flat and cross-Space: it lists every archived
Session in the app regardless of which **Space** is selected, so the rows of other
folders clutter the list and the header count reports the app-wide total while a
single Space tab is showing. Scoping it to the active Space is a two-line filter.

That filter is only safe because of the second change. Closing a tab **forgets** the
Space and deletes nothing (ADR 0043 — `closeSpace` → `removeSpace` touches no
`sessions` row), so today that flat section is the *only* place a stored Session of a
closed Space appears anywhere in the UI, and ADR 0016 makes it the *only* door to
**Delete**. Filter it and those rows become unreachable — not merely hidden — which
turns "delete is two deliberate steps away" into "delete is unreachable unless you
remember which folder it came from". So this change ships a second door: a **Settings →
Sessions** section listing every **Detached** Session, from which one is reopened or
deleted.

## 1. The sidebar's Archived section is scoped to the active Space

`ArchivedSection` (`src/components/SpacesList.tsx`) reads the whole
`archivedSessions` slice and filters out only live ids. It gains the same Space
predicate every other list in this pane already uses:

```ts
const activeSpacePath = useSessions((s) => s.activeSpacePath);
const visible = archived.filter(
  (s) =>
    s.cwd === activeSpacePath &&
    !sessions.some((l) => l.sessionId === s.sessionId),
);
```

The live-id filter stays exactly as it is: it is the sticky rule (CONTEXT.md,
"Archived session") that stops a resumed archived Session from rendering in both the
Space group and the Archived section. Only the Space predicate is added.

What follows from it:

- **The header count becomes per-Space.** It reads the number under the tab you are
  looking at, which is the second half of the reported annoyance.
- **The `· {spaceName}` suffix is deleted from `ArchivedSessionRow`.** It existed to
  disambiguate a cross-Space list — its own comment said the Space "is the one thing
  the row cannot omit". In a Space-scoped list it can never be another Space's row:
  `titleFor` falls back to the Space name for an untitled row (so `showSuffix` already
  suppresses itself there), and a model-generated title would print a redundant
  `· alpha` on a row that is already inside `alpha`. Remove `showSuffix` and the
  suffix span; `spaceName` stays, because `titleFor` still needs it as the
  last-resort title.
- **No Space selected** (`activeSpacePath === null`, i.e. the last tab is closed):
  `cwd === null` matches nothing, so the section renders its existing "No archived
  sessions." empty state. Honest — no tab, no Space, nothing archived *here*. The rows
  are not lost; they are Detached, and §2 is where they live.
- The `cross-space` doc comments on `ArchivedSection` and `ArchivedSessionRow` are
  rewritten — they currently assert the opposite of the new behavior, and cite the
  ZCode `WorkspaceArchivedTasksFlatSection` model that this replaces.

No Rust change. `list_sessions(true)` already returns every stored row app-wide and
`App.tsx` already calls it at boot; `spaceViewFor`'s `archivedSessionIds`
(`src/store/sessions.ts`) is view-membership only — it makes a Space whose sessions are
all archived still resolve its `view` — and is untouched.

## 2. **Detached session** — the new term, and why this one

A **Detached session** is a stored Session whose `cwd` matches no Space row. It is a
view property of the sidebar, not of the Session: it changes when a tab is opened or
closed, and it sets no flag and touches no row. Re-open the folder and it is a normal
row again.

The name is chosen against `CONTEXT.md`, which already forbids the obvious candidates:

- **orphaned** is listed under _Avoid_ for **Stalled session** — a Worker that died.
- **abandoned** is wrong in the direction that matters: an archived Session was put
  away by a deliberate user action, it was not left.
- **Stalled** is a lifecycle state with a Resume affordance; a Detached Session's
  Worker may never have run this boot and nothing is wrong with it.
- **hidden** collides with the _Avoid_ list of **Archived session** itself.

The concept also needs to cover **unarchived** rows, not just archived ones: a stored
(unarchived) Session of a closed Space is equally invisible in the sidebar today, and
has been all along. Scoping Archived makes Archived stop being the one pane that sees
everything, so the new surface's rule is "the sidebar cannot show me this", which is
true of both.

## 3. Settings → Sessions

A new section, `src/components/settings/SessionsSection.tsx`, following the shape of
the existing sections: a `SettingsGroupCard` of `SettingsRow`s, its own file, all state
in `SettingsPage`.

- **Nav**: a `SettingsSidebarButton` labelled `Sessions`, added to the `Section` union
  as `"sessions"` and to the nav between **MCP** and **Web search**.
- **Data**: the store directly — `spaces`, `historySessions`, `archivedSessions`. No
  new Rust command, no new fetch, no cache to invalidate. `setHistorySessions` is
  boot-only by design, and that is sufficient here: every stored row is in memory from
  boot, `spaces` is mutated live by `addSpace`/`removeSpace`, and `deleteSession`
  filters all three lists, so the derivation is always current.
- **Derivation** — an exported pure function beside the store's other Space
  derivations, so it is assertable without Settings fixtures:

  ```ts
  export function detachedSessions(
    spaces: { path: string }[],
    historySessions: SessionInfo[],
    archivedSessions: SessionInfo[],
  ): SessionInfo[]
  ```

  A row is detached when no `space.path` equals its `cwd`. Live ids are excluded. In
  practice a live Session always has a tab (`startSession` → `addSpace`), so the
  exclusion is defensive — it makes the rule total rather than accidentally true.
- **Rows** show the title (`titleFor`), the **folder path** (this section *is*
  cross-Space, so unlike §1 the path is load-bearing and never redundant), an archived
  marker, and the relative time when a transcript happens to be loaded.
- **Reopen Space** per row → the existing `addSpace(session.cwd)` then `openSession`,
  which puts the tab back and drops the row out of this list. A row is **not** clicked
  straight into a transcript: `openSession` leaves `activeSpacePath` alone when no
  Space owns the Session (`sessions.ts`, the `owner` lookup), and ADR 0043 is explicit
  that "a transcript with no tab is not a view". Reopen-then-open is the same
  destination with the tab present, and it is the non-destructive answer for the row
  the user actually wanted back.
- **Delete** per row → the existing `DeleteSessionDialog` → the existing
  `deleteSession`, which cascades `messages` / `native_messages` and leaves the agent's
  own on-disk session file untouched (ADR 0016, unchanged).
- **Clear all** in the section header, disabled at zero, confirmed by a new
  `ClearDetachedSessionsDialog` modelled on `DeleteSessionDialog`'s shape —
  `showCloseButton={false}`, so Cancel/Escape are the only exits, `destructive` confirm
  button. Its body names the blast radius: `Delete N sessions from M folders?` plus the
  folder names. N is the number that matters; the folders are what tells you whether
  this is the sweep you meant.

Subagent rows can never appear here: `list_sessions` filters `is_subagent = 0`, so the
derivation cannot see them.

## 4. Testing

TDD order — each pin written and seen to fail first.

1. `src/components/SpacesList.test.tsx` — an archived row with `cwd: "/tmp/beta"` is
   absent while `activeSpacePath` is `/tmp/alpha`; an `/tmp/alpha` archived row is
   present. The header count counts the active Space only. (The file's existing
   `seedArchived` helper seeds `/tmp/alpha` and the default `activeSpacePath` is
   `/tmp/alpha`, so the archived tests already written keep passing untouched — the
   new pins are the negative cases.)
2. `src/components/SpacesList.test.tsx` — an archived row with a model-generated title
   renders no `· ` Space suffix (pins §1's deletion, so it cannot quietly come back).
3. `src/store/sessions.test.ts` — `detachedSessions`: excludes rows whose `cwd` is an
   open Space; excludes live ids; includes archived and unarchived alike; includes a row
   whose `cwd` names no Space at all; empty when every Space is open.
4. `src/components/settings/SessionsSection.test.tsx` (new) + `SettingsPage.test.tsx` —
   rows render with their path; **Clear all** disabled at zero and opens the confirm;
   confirming deletes every listed id and nothing else; **Reopen Space** calls `addSpace`
   with the row's `cwd`; per-row Delete routes through `DeleteSessionDialog`.

Frontend-only, so the bar is `pnpm test` + `pnpm build` from the repo root. No Rust
change means no `cargo test` / `clippy` gate beyond the normal CI run.

## 5. Out of scope

- Any Rust change — no new command, no schema change, no `list_sessions` variant.
- A per-Space Archived *group* inside the Space group itself (the alternative rejected
  in discussion: a flat section per Space, rather than one scoped section).
- A scope toggle between "this Space" and "all Spaces" — rejected: it is a mode the user
  has to remember is on, and it needs persisted UI state that nothing else in this pane
  owns.
- Purging the agent-side session files a delete orphans (already ADR 0016's out-of-scope).
- Bulk actions in the sidebar's Archived section.
