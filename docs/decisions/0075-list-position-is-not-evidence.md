---
status: accepted
date: 2026-10-24
superseded-by:
---

# List position is not evidence

A list's position was a *derived* fact — Space tabs ranked by `last_opened_at`,
sidebar Sessions by their transcript's last stamp — and four places in
`src/store/sessions.ts` then read that position back as **evidence of recency**
(`autoSelectActive`, `selectSpace`, `spaceViewFor.newestId`, `removeSpace`'s
fallback, all summarised by the ordering note at `sessions.ts:98`: "input order
IS newest-first — do NOT re-sort"). Making the order user-owned breaks that
circle, so we decided the two facts apart: a `sort_order` column owns **display**
and changes only when the user drags a row, and an explicit `lastActiveAt`
(derived at read time from the existing
`COALESCE(MAX(messages.created_at), sessions.created_at)` expression) owns every
decision that needs recency. Position now means only position.

The obvious alternative — keep sorting, add a manual pin at the top — was
rejected because it preserves the movement the user is asking us to stop: a
pinned list still reshuffles underneath the pin, and the frontend still owns an
order that contradicts the server's.

## Considered Options

- **`localStorage`** (the `lib/leftPaneState.ts` pattern): no migration, but the
  order becomes renderer state shadowing DB rows, so the frontend must re-sort
  after every `setSpaces`/`setSessions` — inverting the "do NOT re-sort" rule
  rather than preserving it — and clearing webview storage silently loses every
  arrangement.
- **`settings.json`** (the `agentOverrides` precedent, ADR 0066): one write path
  already exists, but a per-Session entry in an app-global settings document
  grows unbounded with history and needs its own GC on delete.
- **SQLite** (chosen): both read queries change *only* their `ORDER BY`, so the
  standing "input order IS the order, do NOT re-sort" rule stays **true** instead
  of being inverted, and the frontend still never sorts.

## Consequences

- `Db::list_sessions` no longer returns most-recently-active-first. Anyone who
  wants that order must now ask for it explicitly — which is exactly the point,
  and exactly the trap: the **Archived** section rendered `archived.filter(…)` in
  input order and *inherited* recency for free. It now has to sort by
  `lastActiveAt` itself, or it silently presents a manual order under a recency
  heading while passing every pre-existing test.
- A new Session or Space joins at the **bottom** (`MAX + 1`), and nothing ever
  moves a row again — not a new message, not a close, not a boot.
- HTML5 drag-and-drop is pointer-only, so a keyboard user cannot reorder. Accepted
  and recorded in `docs/features/manual-list-order.md` rather than left implicit.
- `src/lib/sessionActivity.ts` is deleted: `sortByActivity`, `activityKeyOf` and
  `activityFromKey` existed only to feed that one sort, including the
  subscription key built so streaming would not re-sort the list on every token.
- The phase-11 space-backfill `INSERT` in `Db::open` carries the same
  bottom-join expression (`COALESCE((SELECT MAX(sort_order) …), -1) + 1`) as
  `Db::upsert_space`, because on the upgrade path where a database has stored
  sessions but no `spaces` rows the seed numbers nothing — there is nothing to
  number — so a plain `DEFAULT 0` would tie every backfilled row and hand the
  user an alphabetical list on the very boot the spec promises is unchanged.
- The seed queries in `seed_space_sort_order` / `seed_session_sort_order`
  hardcode the OLD display order (`last_opened_at DESC, path ASC` and
  last-activity `DESC, id DESC`) and must never be pointed at `sort_order`: at
  seed time every value in that column is still `DEFAULT 0`, so `ORDER BY
  sort_order` is a pure tie and would pick an order nobody ever saw.
