---
status: approved
issue: https://github.com/danielcherubini/archimedes/issues/43
done-when: `pnpm test` + `pnpm build` green at the repo root with no Rust changes; items 1/5/6 additionally confirmed by running the app under BOTH Dracula and zai dark, because jsdom asserts nothing about pixels.
---

# Lightning round of design fixes

Six presentation and interaction fixes, delivered as ONE branch and ONE
squash-merged PR. The scope is closed: an item that turns out to need more than
a fix still lands in this PR rather than being ejected into a follow-up.

All six are frontend-only (`src/components/**`, `src/styles/**`, `src/lib/**`).
No Rust changes, so the `cargo test` / `clippy` / `fmt` lanes are untouched.

## Why one PR

Each item is a small, independent change to the presentation layer, and six of
them reviewed one-at-a-time cost more attention than they change. Two of them
(items 1 and 4) edit the same `MessageBubble` case, and items 5 and 6 both touch
the token/derivation seams the components read — so they are not six unrelated
commits anyway.

The cost of bundling is accepted knowingly: a reviewer reads six behaviours at
once, and a revert takes all six. That is the trade the round is making.

## Shared language

**Response band** — the surface an assistant reply rides, introduced here: the
same `rounded-xl bg-composer px-3 py-2` treatment the user's message already
uses. It is a *name for an existing treatment applied to a new row type*, not a
new surface.

**Row token family** — `--color-row-icon` + `--color-row-verb`. Named for
`TRANSCRIPT_ROW` (`src/components/lib/transcriptRow.ts`), the class constant the
`Thought` row, the tool rows and the `Changes` group already share. The family
is therefore about the ROW, not about tools — the `Thought` row is a member.

---

## 1. The response band

`src/components/MessageBubble.tsx`, the `agent-text` case. Today it is a bare
`<div className="text-ui-base">` with no surface at all; the user's case paints
the band. The reply gets the same treatment, and specifically the same
**token** (`bg-composer`, not a copied hex) so a palette that moves
`--color-composer` moves both bands in lockstep under every theme.

Full chat-column width, no border — the user band's rules, including the ones
its comment records as load-bearing: no `self-start`, no `inline-block`, no
`max-w-*`, each of which silently re-narrows the band.

### The rhythm

`MessageList` owns vertical spacing as a flex `gap-3` (12px) on the scroll
container plus `mt-4` (16px) "breathing" on a row whose immediate neighbour is
a tool row. Margins **add to** a flex gap and cannot subtract from it, so the
target gaps are expressed as margin *offsets*, not as plain values:

| Gap | Today | After | How |
|---|---|---|---|
| `Thought` → response | 12px | **4px** | band carries `-mt-2` |
| below the response | 12px | **32px** | band carries `mb-5` |
| below a user band | 32px | 32px | unchanged — this is the reference |

4px makes the `Thought` row and the reply read as one unit without fusing them.
32px is *measured-equal* to the user band's existing outer gap, which is what
"the same spacing underneath" means as an observable.

The negative margin is deliberate and gets a comment saying why `mt-0` cannot
produce 4px here — otherwise the next reader "cleans it up" and the pair
separates again.

`Thought` stays a bare row on the column. It is NOT brought inside the band:
the thinking is deliberately not in the surface the user's eye reads as "the
answer".

Applies to `SubagentTranscript` as well, which renders the same `MessageBubble`.

### Accepted consequence

Every assistant message now paints a surface. A turn that interleaves
text → tool → text → tool → text shows four bands with tool rows between them.
That is the requested "look like mine" shape, stated so it is not discovered in
the diff.

## 2. Copy one response

A copy button on the response band — **always visible**, OUTSIDE the band,
below it on the left. Copies `message.text` verbatim: the raw markdown source,
not a rendered plain-text equivalent. Thinking is excluded because it is a
separate render unit and the button lives inside `agent-text`.

The interaction is `ToolCallCardHeader`'s existing failure-copy pattern
verbatim — `CopyIcon` → `CheckIcon` for 1.5s, timer cleared on unmount. There
is no reason to invent a second copy affordance in the same transcript.

Always-visible rather than hover-revealed is a deliberate divergence from the
transcript's hover-only chevrons: a copy affordance nobody finds is not an
affordance, and this one is the primary action on a response.

## 3. Staged screenshots clear at send

`src/components/ChatStream.tsx`, `send()`. The clearing code already exists
(~`:1095-1101`) and is correct — it simply runs AFTER `await sendPrompt(...)`,
i.e. when the turn finishes. So the thumbnails sit in the composer for the whole
turn while the copies they preview are already dead weight.

By the time `addUserMessage` has run, the base64 is read and the images are on
the user message, so the staged attachments have no remaining job.

New order inside `send()`:

```
read base64 → setDraft("") → addUserMessage → beginTurn
  → move staged attachments to a heldForSend ref; setAttachments([])   ← thumbnails go now
  → await sendPrompt
      success → revoke the held object URLs
      failure → restore them, merged with anything staged during the turn
```

The object URLs are deliberately NOT revoked at clear-time. That is what keeps
the existing guarantee alive — "a failed send keeps your attachments, because a
re-pasted image is costly and a re-typed draft is not" — while the thumbnails
still go immediately. `heldForSend` is keyed by session id, so a send started in
one session cannot restore into another; the URLs are released when the turn
settles.

## 4. `[image #N]` markers

Staging an image inserts a `[image #N]` marker into the draft, and the marker is
**sent to the model** as part of the prompt, so a prompt can say "look at
`[image #2]`" and mean a specific attachment.

**`N` counts the attachments of THAT message**, not the session. This is the
only reading that is true on the wire: `src-tauri/src/agent/harness/loop.rs`
(~`:736-750`) pushes the text block first and then the images in send order as
OpenAI `image_url` parts, so "the Nth image of this prompt" is the one thing the
model can actually resolve. A session-wide counter would put `#3` in front of an
image with nothing establishing that two came before it — meaningful to the user
reading their own composer, noise to the model.

### The rules that keep the number honest

- **Every staging path inserts a marker** — paste, the `+` file picker, and
  drag-and-drop. If only paste inserted one, a mixed batch would number
  `#1, #3` and the number would stop matching the strip.
- **Insertion is at the caret**, the way a text paste lands at the caret, so a
  paste into the middle of a sentence labels the image where the user is typing.
- **`AttachmentStrip` thumbnails carry a `#N` badge**, so the number in the text
  is checkable against the picture it names.
- **Removing an attachment renumbers the markers.** Deleting `#2` of three
  leaves the draft saying `#1 #3` while two images attach, so the wire would
  label the second image `#3` — the exact lie the per-message decision exists to
  prevent. The rewrite targets the exact literal `[image #N]` pattern and
  nothing else.

### Collision to pin with a test

`#` is the MCP mention prefix (`MCP_MENTION_RE`, `src/lib/skills.ts`). A marker
is safe today because an unmatched token is left verbatim (invariant 5 of the
composer grammar), but that is an argument, not a gate — a future MCP server
named `3` would turn `[image #3]` into an expanded block. Pin the marker's
immunity explicitly.

## 5. Two row tokens: `--color-row-icon`, `--color-row-verb`

Tool-row icons become orange and the verbs (`Ran`, `Thought`, `Edited`,
`Searched`, …) become light blue, in Dracula `#ffb86c` and `#8be9fd`, behind
reusable tokens so a theme can re-hue them without touching a component.

Both hexes are ALREADY in use in `.theme-dracula`:

| Hex | Already | Signals |
|---|---|---|
| `#ffb86c` | `--color-warning` | context bar 70–89% fill, stalled-session banner, new-session error banner, `SessionStatusMark`, todo/pending dots |
| `#8be9fd` | `--color-interaction-ask-foreground`, `--color-terminal-cyan` | the Ask gate, terminal output |

They are taken deliberately, and the token is what makes that reversible: the
collision becomes a named, documented alias one line wide instead of a hex
scattered through components.

### Readings

| Layer | `--color-row-icon` | `--color-row-verb` | Visible change |
|---|---|---|---|
| `@theme`, `.dark`, `.theme-zai-light`, `.theme-zai-dark` | `var(--color-foreground-subtle)` | `var(--color-foreground-subtlest)` | **none** — today's values |
| `.theme-dracula` | `#ffb86c` | `#8be9fd` | orange icons, cyan verbs |

The alias-back follows the `--color-context-track` precedent in this repo: a
role split out of a text token, aliased straight back in every palette but the
one that needs its own reading, so zai renders byte-identically.

Applies to all three `TRANSCRIPT_ROW` consumers — `ToolCallCardHeader`,
`Reasoning`, `ChangesGroupCard` — since the family is named for the shared row
type, not for tools.

**Pending keeps `animated-gradient-text`.** The shimmer is the "this call is
working" cue; the verb colour lands when the call settles.

### Delete the dead `--color-trajectory-*` family in the same change

There is ALREADY a transcript-row hue family: five tokens
`--color-trajectory-{user,assistant,reasoning,tool-call,tool-result}`, declared
in `@theme`, `.dark`, `.theme-zai-light` and `.theme-zai-dark` (20 declarations),
kept alive by `paletteCompleteness.test.ts`'s `INHERITED` list and described in
`CONTEXT.md` under **Identity color** as "the **Thinking block**/tool/assistant
row hues".

**Nothing consumes them.** No component or `src/lib` module references
`trajectory` — only the completeness test does. They render nowhere.

They are also the wrong axis for this request: they split by *row kind* ("this
row is a tool call") where the request splits by *role within a row* (glyph vs
verb), uniformly. And `--color-trajectory-tool-call`'s dark reading is `#f59e0b`
— already an orange, so it would sit beside `#ffb86c` as a near-twin.

They are deleted here rather than left, because shipping a second "transcript
row hue" family while a phantom one sits in the glossary advertising itself as
live is how the next reader ends up choosing between two things, one of which
does not exist.

Deletion touches: the 20 declarations across the four layers, the 5
`INHERITED` entries and their `59`-count prose in
`paletteCompleteness.test.ts`, the `CONTEXT.md` **Identity color** entry's
reference to them, and `docs/css-theme-tokens.md`'s comparison to them.
ADR 0027's text mentions them and stays as written — it is a record, not a
living document.

### Gates this trips (all intentional)

`src/lib/paletteCompleteness.test.ts` refuses a token declared in `.dark` but
missing from `.theme-dracula`, so its hardcoded counts must move — and the
deletion and the addition move them in **opposite directions**, which means a
partial edit fails rather than silently passing:

| Assertion | Now | After (−5 trajectory, +2 row) |
|---|---|---|
| `INHERITED` | 59 | 54 |
| `diff(DARK, INHERITED)` ("structural + ramp") | 92 | 94 |
| `.theme-dracula` declarations | 117 | 119 |
| `ZAI_DARK.size` | 170 | 167 |
| `ZAI_DARK − DRACULA == INHERITED − 6` | 53 == 53 | 48 == 48 |

Plus the "86 structural" arithmetic comment and the `8 git-* and 5 trajectory-*`
line in the `INHERITED` rationale. Both new hexes are Dracula-spec-published, so
the spec gate passes.

`src/lib/themeTokens.test.ts`'s hex-collision gate inspects only the thinking
ramp, so it will NOT catch the collision below. Add a test pinning both hexes of
the new family per palette, so a later cleanup cannot quietly collapse them back
onto status tokens.

### Accepted consequence

Under Dracula a decorative tool icon is now the same `#ffb86c` as the pending
dot and the stalled banner. Orange stops meaning only "needs attention". The
token makes it one line to reverse; nothing in CI will notice either way.

Note this is a deliberate departure from ADR 0027's doctrine, which classes
transcript-row hues as Identity colors a **Palette** never re-hues. These tokens
are palette-owned on purpose — the request is explicitly "a token we can reuse
when changing themes".

## 6. Model / Reasoning / Context move to the side pane

The context bar, the model selector and the reasoning-level selector leave the
composer's bottom row (`src/components/chat/ComposerRow.tsx`, ~`:292-390`) and
become three lines at the bottom of the right-hand `SidePane`, in the order
Model, Reasoning, Context.

**Placement:** a fixed block AFTER the scroll area, not inside it. The content
area is `flex-1 overflow-y-auto p-3` and the todo boards grow, so a block inside
it would scroll out of reach and drift with board length. As a sibling below it,
the boards scroll and these three lines stay pinned. The pane's collapse toggle
is absolutely positioned at `bottom-2 left-2`, so the block clears it with
padding rather than competing for the corner.

**Sizing:** full line-width. `SessionConfigSelect`'s triggers are deliberately
content-sized (`min-w-0 shrink max-w-72`) for a horizontal row, where hugging
the text prevents dead space. On their own lines in a 240–480px pane that
produces a ragged staircase, and the reason the sizing existed no longer holds.
Delivered as a width variant on the existing component, not a fork.

**Behaviour that must survive the move**, currently held in `ChatStream`:

- `disabled={!isLive}` — a stored session shows populated values with disabled
  selectors; a resume re-emits the fresh ones. `SidePane` re-derives liveness
  from the store with the same predicate.
- The `configOptions` / `contextUsage` four-way fallback (live map → `sessions`
  → `historySessions` → `archivedSessions`) is extracted into ONE shared
  selector both components read. Duplicating that chain in two files is drift
  waiting to happen. `setConfigValue` is one tauri call and reproduces without
  lifting state out of `ChatStream`.
- The traffic-light ramp (success <50, caution <70, warning <90, destructive
  above) comes along as the same shared derivation, so it cannot be re-derived
  into disagreement.

**A perf hazard closes structurally.** `ChatStream.tsx:289-291` records that a
per-option closure re-rendered ~600 mounted model `SelectItem`s on every
composer keystroke at ~140ms each — which is why `setConfigValue` was hoisted
into a stable callback. With the selectors in `SidePane`, typing cannot re-render
them: `SidePane` reads stores, not `draft`. The fix stops depending on someone
remembering it.

**Composer after the move:** the bottom row keeps the `+` attach button and
Send, BOTH right-aligned.

**Accepted consequence:** with the pane collapsed to its 40px rail there is no
model switch, no reasoning switch and no context read — the user expands the
pane to change model. The rail carries no mark for these three, unlike the todo
boards' `TodoRail` marks.
