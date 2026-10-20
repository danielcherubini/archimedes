---
status: accepted
date: 2026-10-13
superseded-by:
---

# Closing a Space tab forgets the Space, and stops nothing the user did not agree to stop

The tab bar (`src/components/SpaceTabs.tsx`) rendered one pill per **Space** with no way to
close one: `removeSpace` existed in `src/store/sessions.ts`, was tested, and had no caller —
the only route to a forgotten Space was the folder picker adding more. Adding the obvious ✕
was the small half of the change. The half that needed deciding is what a close does to a live
**Session**, and the reason it bites is the sidebar's grouping: **Session** rows live under
their **Space** (a Session's `cwd` IS the Space's folder), and nothing in the Client can PARK a
**Session** today. `close_session` is wired in `src-tauri/src/commands/sessions.rs` and in
`src/lib/tauri.ts` and called by no frontend code; `cancel_session` IS called from the
frontend, but only by the composer's Esc, only for the **Session** already on screen, and it
stops a TURN, not a **Worker**. So a silent close would hide a running Session's row while its
Worker kept running, with no surface left to stop it from — and no way to park it either.

We decided:

1. **Closing is forgetting, not deleting.** `closeSpace` delegates the row removal to
   `removeSpace`, which touches no `sessions` row (its own standing decision), so re-opening
   the folder returns the Space WITH its history. Because that is reversible, a Space with
   nothing live in it closes on the spot — no confirm for an action the user can undo by
   opening the folder again.
2. **A Space holding a LIVE Session asks**, through `CloseSpaceDialog`, with three exits:
   *Stop and close* (the emphasized default), *Close anyway*, *Cancel*. The gate is **live**,
   not *turn open*: an idle live Session still has a Worker behind it, and "is there something
   that outlives the tab?" is the question the confirm exists to answer. The Sessions and
   their titles are snapshotted when the close is requested, so the dialog cannot lose its
   subject mid-flight, and the titles come from `titleFor` — the same rule the rows use, so
   the confirm never names a Session differently from the row the user just looked at.
3. **Stopping is best-effort.** `closeSpace` settles every `close_session` it was asked to
   make, logs the rejections, and closes regardless. A Worker that is already gone answers
   `UnknownSession`; letting that fail the close would produce a tab that cannot be closed
   because something is already dead.
4. **Closing the selected tab lands on its neighbour.** `removeSpace` already picks the
   fallback path (first remaining Space, or `null`); `closeSpace` reads the result and routes
   it through `selectSpace`, so the chat shows that Space's most recent Session — live first,
   else newest stored, transcript loaded — instead of leaving a transcript on screen whose tab
   is gone. One rule for the fallback (`removeSpace`), one rule for what opening a Space shows
   (`selectSpace`); `closeSpace` states neither.

## Considered options

- **Refuse to close while a Session is running.** Rejected: it makes the tab bar the thing
  that will not let you leave, and the escape for a BACKGROUND Session does not exist — the
  Esc that stops a turn reaches only the Session on screen.
- **Close and always stop, silently.** Rejected: it kills a turn in flight with no warning,
  which is the one destructive-feeling thing a Close button could do to a tab whose
  conversations are documented as surviving.
- **Close and never stop** (exactly what `removeSpace` does today). Rejected as the default
  for the reason above — the unreachable running Session — but kept as an explicit choice,
  because "finish that turn, I want the tab gone now" is legitimate. That is *Close anyway*.
- **Confirm every close.** Rejected: a browser does not, and neither should a control whose
  undo is re-opening the folder.
- **Middle-click only, no ✕.** Rejected: undiscoverable, and unreachable by keyboard or
  touch. The ✕ is the control; the middle-click is the convention on top of it.

## Consequences

- The ✕ is a SIBLING of the `role="tab"` button inside the pill `div`, never its child: an
  interactive child of a `<button>` is dropped from the accessibility tree (and forbidden by
  its content model), which would have made the tab one opaque control with no close
  affordance in it. The pill keeps the geometry, so the pair still reads as one object; the
  wrapper owns the middle-click (`button: 1`, `preventDefault` — WebView2's autoscroll
  otherwise grabs the tab strip), and a left press is button 0, so the two paths cannot both
  fire.
- `titleFor` moved from `src/components/SpacesList.tsx` to `src/lib/sessionTitle.ts` so the
  rows and the confirm share one label rule. `SidePane`'s header still carries its own inline
  copy (it reads the title across all three session arrays); folding that in is a separate
  change, named in `sessionTitle.ts` rather than slipped in here.
- A Session can still outlive its tab — when the user chooses *Close anyway*. Accepted: its
  frames keep arriving, and its row returns the moment the Space is re-opened.
- The pill markup sits in pre-existing a11y debt that this change neither created nor fixed:
  the app has **no `role="tablist"` parent** for its `role="tab"` pills and **no `←`/`→` tab
  navigation**, so the tabs are announced as loose buttons rather than as a tab list. Recorded
  here as its own gap — the ✕ being a sibling of the tab is the accessibility decision this
  ADR actually made; the missing list semantics is a separate change.
- **Follow-up, not taken here:** there is still no control to STOP or PARK a Session. The only
  route to `cancel_session` is Esc on the Session already on screen, which stops its turn and
  not its **Worker**, so the close-confirm is the one place a stop is reachable at all, and
  only for a Space being closed. A per-Session stop control is its own change, and so is a
  `⌘W`/`Ctrl+W` close-the-tab shortcut beside it.

## Amendment (2026-10-20) — the per-Session stop control this Follow-up anticipated now exists; the tab's rationale stands

**AMENDED 2026-10-20 — the last Consequences bullet's universality, and one rejected option that has come back under a different justification.** What stands unchanged, and unchanged for the reason this ADR gave: closing a Space tab is FORGETTING and deletes nothing, a Space still holding a live **Session** confirms before it closes, the stop it offers is best-effort, the fallback tab is chosen by `removeSpace` and opened by `selectSpace`, and every one of the Considered options' rejections still holds **for the tab close**. This ADR is NOT superseded and its `status` is unchanged; the Follow-up bullet is left standing above exactly as written, and corrected here, because it is the record of what was true on 2026-10-13.

**What changed.** The per-Session stop control that bullet called "its own change" has landed, as its own change: `SessionRow` (`src/components/SpacesList.tsx`) swaps the row's time for **Stop** and **Archive** on hover, on a live row as well as a stored one. `stopSession` (`src/store/sessions.ts`) reads `inTurn` at click time — a turn in flight → `cancel_session` (the **Worker** is kept, the Session stays live and re-promptable); live and idle → `close_session` (the Worker is reaped and the row drops to stored). `archiveSession` on a live id now also closes the Session, after committing the flag (ADR 0016, amended 2026-10-20). So the sentence "there is still no control to STOP or PARK a Session" is false, and so is "the close-confirm is the one place a stop is reachable at all". The `⌘W`/`Ctrl+W` half of that bullet is still unwritten.

**The falsification is NARROW, and the narrowness is the point.** This ADR's own scenario — closing a Space **tab** — is untouched, and its rationale still holds exactly as argued above: closing the tab removes the `spaces` row, the sidebar derives its groups from the Spaces, so it produces NO rows for that Space, so there is still no Stop button for a Session whose tab you closed. The Session keeps running with its **Worker** alive and no surface left to reach it, and the Esc path still reaches only the Session on screen. What is dead is the bullet's UNIVERSAL claim — "no control to stop … **at all**". A Stop button exists; it lives on the sidebar row, and a closed tab has removed the row. That is precisely why the confirm this ADR decided on is still owed: the tab close is the one act that takes away the surface the stop lives on.

**"Close and always stop, silently" is back, in a different place, and that is not an oversight.** The Considered options rejected it FOR THE TAB CLOSE and that rejection stands for the tab: it kills a turn in flight with no warning and destroys the user's view of a running thing: the tab is gone and its rows with it, so the only way back to the Session it was hiding is to remember the folder and re-open it — and while the tab is gone no surface in the Client names the Session that is still running. The sidebar row's **Archive** does stop silently on the way in, and that is a deliberate decision of 2026-10-20, asked for explicitly, justified on grounds the tab case cannot borrow: Archive is **reversible** (ADR 0016), the transcript survives, and the Session stays openable and resumable — the undo is one Unarchive, not a folder re-open that cannot name the Session it hid. So the two controls now differ in whether a confirm is owed, and they differ because their cost differs: the tab close needs a confirm because it is the only one of the two that leaves a running Session unreachable, while Archive's stop is a silence the user can walk back. The asymmetry is intentional, and a future change that "unifies" the two by adding a confirm to Archive — or by dropping the tab's — would be re-opening this ADR rather than tidying it.
