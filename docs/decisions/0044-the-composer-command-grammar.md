---
status: accepted
date: 2026-10-13
superseded-by:
---

# The composer gains a fourth prefix and a third semantics: `/name` is a COMMAND the Client consumes, not text it sends

A **Composer command** is a `/name` token the **Client** intercepts on send: it runs a
**Client**-side action and NOTHING is sent to the **Agent**. It joins the three prefixes that
already share one picker (`src/lib/skills.ts:268`) without joining their semantics — a
**Mention** (`$ @ #`) EXPANDS into a block on send (ADR 0031), **File completion** (`?`) inserts
a PATH and expands nothing (ADR 0033), and a Composer command is CONSUMED: no user row, no
prompt, no model call. The picker is shared; the meaning is not.

**Why:** the user needs to trigger a compaction by hand (a context full enough to fail is
exactly when an agent that only compacts on its own threshold is useless), and the composer is
the only place the user already types intent. A button on the context bar was the obvious
shape and was rejected: it puts a fourth control in a row that already carries `+`, the bar,
the model selector and the thinking selector, and it makes the second such command a layout
argument. `/compact` is also the name the user's other tool already uses. The grammar is free:
the `?` picker only arms on a leading `?` (so ADR 0035's "`/` leaves the Space" rule lives
INSIDE a `?` token), and mention expansion fires only on `$ @ #`, so a bare `/compact` is inert
prose today — nothing is redefined, one namespace is opened.

**Considered Options**

- **A button/popover on the context bar (rejected)** — discoverable, but the composer row is
  already full, and Radix will not let one trigger be a Tooltip and a Popover at once, so the
  existing counts tooltip would have to move into the popover body.
- **A keyboard shortcut only (rejected)** — this app has no command palette, so a shortcut with
  no visible affordance is undiscoverable for a feature that is ALSO the recovery path for a
  stuck session.
- **Special-casing the literal `"/compact"` (rejected)** — smallest diff, but "our first slash
  command" means the second one re-opens this exact decision, and the picker machinery a real
  entry needs already exists.
- **Whole-draft-only dispatch (rejected)** — `/compact <args>` would fire only when nothing
  else is on the line. Chosen against in favour of pi's rule (a leading `/` claims the
  message, trailing text becomes args), accepting that "is this prose or a command?" now
  depends on the first character of the draft.

**Consequences**

- **An unmatched `/foo` MUST fall through byte-identically as prose, and that is load-bearing,
  not courtesy.** A **File completion** file row CONSUMES its `?` and inserts the absolute path
  verbatim (ADR 0033/0035), so a draft can legitimately BEGIN `/etc/hosts ` or
  `/home/you/notes.md `. A command namespace that claims a leading `/` would swallow those
  drafts. Pinned by a test whose fixture is exactly that insert at position 0. `/compactme` is
  prose, not a near-miss — the match is EXACT, the same property ADR 0031's tag-safety rests on.
- **ADR 0031's byte-identity contract is deliberately narrower now.** "Live bubble = stored row
  = model input" governs text that IS SENT; a Composer command sends nothing, so there is no
  `mergeDedupeKey` to match and nothing to re-hydrate on resume. A future reader must not read
  that exception as a licence to special-case the display of sent text.
- **`CONTEXT.md`'s `Mention` entry lists "Slash command" under `_Avoid_`, and still means it.**
  That entry rejects calling a **Mention** a slash command; after this change "slash command"
  names a different thing — a **Composer command** — so the two terms must never be conflated.
- A command is only ever typed while **idle**, because the composer is locked during a turn.
  That is what lets the manual trigger be a single idle-time control command and leaves the
  forced-compaction flag to the overflow path alone.
- `/compact` on a **stored (non-live)** session is a no-op with a one-liner: resuming a session
  in order to compact it is a larger flow than the command is worth, and the resume's own
  re-estimate is what reveals whether compaction is even needed.
