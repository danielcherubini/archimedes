---
status: accepted
date: 2026-10-23
superseded-by:
---

# Every IPC call travels through the `@/lib/tauri` barrel, and two modules are permanent exceptions

`src/lib/tauri.ts` is a **pure re-export surface** — 189 lines, 14 `export` statements, exactly **107
names** (58 type-only + 49 values), zero `invoke`/`listen` calls — over nine command modules plus
`events.ts` and `types.ts` under `src/lib/tauri/`. Production code imports `@/lib/tauri` and nothing
else: no file outside `src/lib/tauri/` imports a domain module, and no file outside `src/lib/tauri/`
imports `@tauri-apps/api/core` or `/event` **except `src/lib/update.ts` and `src/lib/version.ts`, which
are allowlisted forever, by name, with the reason written next to the name.** Both directions are enforced
by source scanners: `tauriBarrel.test.ts` guards the INCOMING edges (nothing bypasses the barrel) and
`tauriBoundary.test.ts` guards the OUTGOING edges (nothing outside the IPC modules touches the Tauri wire).

**Why the barrel exists at all: it is a test seam, not a layering preference.** A large set of test files
`vi.mock` `@/lib/tauri` **by module path**, and `vi.mock` intercepts only the calls travelling THROUGH the
path it was given. Import a domain module directly and every test that mocked that function stops
intercepting it. The count of mocking files is pinned inside `tauriBarrel.test.ts` and deliberately stated
nowhere else — every prose copy of it in this repo has gone stale at least once.

**Why the boundary needed its own guard.** The report this program worked from stated the `invoke`
boundary as fact — "0 call sites outside it" — and that was **one commit's measurement restated as a
property**, enforced by nothing. The two guards pin opposite directions of one seam and only one had been
written. A hand-rolled `invoke("delete_session")` typed into a component keeps the whole suite green,
because components mock `@/lib/tauri`, never `@tauri-apps/api/core`: the call simply bypasses the mock the
test believes it is standing on. Verified by planting one — including behind a computed dynamic import,
`await import("@tauri-apps/api/core")`, the idiom this repo already uses to reach `node:fs` — which
reddened two tests. A guard that matches only the literal import shape walks straight through that.

**Considered Options**

- **Fold `update.ts` and `version.ts` into the barrel** (the obvious tidying): rejected, and this is the
  finding a reader will otherwise re-open. Both already have a WORKING mock seam of their own —
  `UpdateSection.test.tsx` and `SettingsPage.test.tsx` `vi.mock` `@/lib/update` and `@/lib/version`
  WHOLESALE, with no `vi.importActual`, which is the one mock shape in this repo where a name the factory
  forgets arrives as `undefined`. Re-point their consumers at `@/lib/tauri` and those two factories stop
  being the seam, while the barrel mockers do not mock `checkUpdate` / `installUpdate` / `relaunchApp` /
  `getAppInfo` — so every one of them begins resolving the REAL updater wrappers. That is precisely the
  green-and-lying regression the barrel guard exists to prevent, manufactured on purpose. It also collides
  with a standing instruction: `update.test.ts` and `version.test.ts` mock `@tauri-apps/api/core` directly
  to pin wire strings as literals, on purpose, and are not to be deduplicated.
- **Recompute the allowlist from the tree** (find the files that import the wire packages and treat that as
  the list): rejected. A list derived from the tree documents nothing and cannot complain when a third
  sibling appears. It is a literal so that a new offender reddens the test and a removed one reddens as a
  stale entry — set equality in both directions, so an addition and a deletion cannot cancel out.
- **One guard instead of two**: rejected — they fail for different reasons and a combined failure names
  neither. The barrel guard's own assertion that the barrel contains no `invoke` CALL is weaker than the
  boundary guard's claim that it contains no wire-package IMPORT, which is the one that catches a function
  creeping back into a pure re-export surface while still typechecking.

**Consequences**

- **Adding an IPC command means adding it to a domain module and re-exporting it from the barrel.** A
  forgotten re-export is caught: the barrel's 107-name surface is pinned as a literal.
- **A third parallel IPC module requires a commit that says so.** The allowlist is a literal with per-entry
  reasons; it cannot grow quietly.
- **`installUpdate`'s promise never resolves on Windows** (the process exits inside the Rust command). That
  contract lives in `src/lib/update.ts` and is part of why these wrappers resist being folded into a
  uniform surface.
- **A scanner must share its own predicate.** The boundary guard's first vacuity check asserted over a
  copy of the string it was looking for, so corrupting the predicate left all its tests green. Both now
  share one predicate, and blinding it turns it red. Any future scanner should copy that shape: a guard
  that cannot fail is not a guard.
- **Source-grep gates are allowed only for conventions, never for behaviour.** These two scanners assert
  which module a name may be imported from and which packages may be named — both invisible to a runtime
  test. Behaviour stays pinned by runtime tests. (An earlier task in this program retired grep gates that
  had drifted into pinning behaviour; the distinction is the reason these two were allowed in.)
- **`docs/roadmap/frontend-component-extraction-follow-ups.md` survives the plan's deletion** and records
  what this program deliberately left undone, including the two `update.ts`/`version.ts` modules' status as
  follow-up item 10.
