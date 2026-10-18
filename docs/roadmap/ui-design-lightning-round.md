---
status: committed
issue: https://github.com/danielcherubini/archimedes/issues/43
done-when: A user sees the assistant's reply on the same band as their own message with a copy button under it, sees staged screenshots vanish the instant they hit Send (and come back if the send fails), sees `[image #N]` in the draft naming the attachment the model receives, sees orange tool glyphs and light-blue verbs under Dracula with zai unchanged, and finds Model / Reasoning / Context as three lines at the bottom of the right pane — with `pnpm test` + `pnpm build` green and no Rust touched.
---

# Lightning round of design fixes — Plan

**Goal:** Six small presentation/interaction fixes to the transcript, the composer's attachments, and the side pane, delivered as one squash-merged PR.

**Architecture:** All six are frontend-only. Two live in `MessageBubble.tsx`'s `agent-text` case (band + copy button), two in the composer's attachment path (`ChatStream.tsx` staging/send + a new pure helper module in `src/lib/chatAttachments.ts`), one is a CSS token change with gate arithmetic (`src/styles/*.css` + `paletteCompleteness.test.ts`), and one relocates three controls from the composer to the side pane behind a new shared derivation module.

**Tech Stack:** React 19 + TypeScript `strict` (with `noUnusedLocals` + `noUnusedParameters` — **an unused prop or destructured variable FAILS `pnpm build`**), Tailwind v4 `@theme` tokens, vitest + `@testing-library/react` in **jsdom**.

---

## Read this before starting

### Where the work happens

```
/home/daniel/Coding/AI/archimedes-wt-ui-lightning      ← WORK HERE (branch feature/ui-design-lightning-round)
/home/daniel/Coding/AI/archimedes-desktop              ← the OTHER worktree, on main, doing unrelated bugfixes
```

This is a `git worktree`, not a clone. Do **not** `cd` to the main checkout to run commands, and do not create another worktree.

**Disk is 95% full (13 GB free) and `src-tauri/target` is 137 GB.** The two sharing arrangements already in place:

- `node_modules` is a btrfs reflink copy — costs zero real space. Leave it.
- `src-tauri/target` is a **symlink to `/tmp/archimedes-wt-ui-target`** (an empty dir). Cargo's dep-info files embed absolute source paths, so a second checkout at a second path cannot reuse the main cache anyway.

**Therefore: run NO cargo command in this worktree.** `cargo test`, `cargo clippy`, `cargo fmt`, `pnpm tauri build`, `make check` — none of them. This branch touches **zero Rust**, so the cargo lanes are not part of its bar (AGENTS.md: the Rust lanes run from `src-tauri/`, and there is nothing here to validate). Building Rust would allocate a fresh 137 GB tree into `/tmp` and fail. Do not delete the symlink.

### The commands that actually work here

| Purpose | Command | Note |
|---|---|---|
| One test file | `npx vitest run src/path/file.test.ts` | ~1–2 s |
| Full suite | `npx vitest run` or `pnpm test` | ~70 s, expect **94 files / 2054 tests** at baseline |
| Type-check + build | `pnpm build` | runs `tsc && vite build` |

`pnpm test -- <path>` does **not** filter — it runs all 94 files. Always use `npx vitest run <path>` for a single file.

### Baseline (verified on this branch before Task 1)

`npx vitest run` → 94 files / **2054 tests passed**. `npx tsc --noEmit` → clean. `npx vite build` → clean (one pre-existing chunk-size warning; ignore it).

### Two corrections to the approved spec (found by reading the code)

The spec at this file's earlier revision made two claims the code contradicts. Both are resolved below and the resolutions are **decisions, not open questions** — do not re-open them.

1. **The spec's "zai renders byte-identically" is false for one icon.** `Reasoning.tsx:396` paints the brain glyph `text-foreground-subtlest`, while `ToolCallCardHeader.tsx:87` and `ChangesGroupCard.tsx:153` paint theirs `text-foreground-subtle`. One `--color-row-icon` cannot alias back to two different values. **Resolution:** alias to `foreground-subtle` and accept that the zai `Thought` glyph becomes slightly more opaque — that is the three row glyphs becoming consistent, which is the point of the family. Recorded in ADR 0062's amendment (Task 4, Step 1).
2. **The spec said "three controls move"; thirteen tests move with them.** Thirteen `it(` blocks in `ChatStream.test.tsx` assert this behaviour through the composer's DOM (`:955`, `:1324`, `:1364`, `:1410`, `:1446`, `:1471`, `:1498`, `:1520`, `:1542`, `:1563`, `:1576`, `:1587`, `:1646`). They must be **relocated and rewritten against the pane**, not deleted. Task 5 lists every one by line and title.

### What NOT to change (throughout)

- No Rust. No `src-tauri/**` file. No `Cargo.toml`.
- Do not touch `.theme-zai-light` / `.theme-zai-dark` beyond the exact line edits Task 4 names.
- Do not "unify" the composer mention regexes or the marker/`#` interaction beyond pinning the test Task 3 specifies (ADR 0031's invariants).
- Do not re-indent, re-order or "clean up" the long rationale comments you encounter. They are load-bearing documentation and several tests parse this file's text.

---

### Task 1: The response band + the copy button

**Context:** Today an assistant reply (`kind === "agent-text"`) renders as a bare `<div className="text-ui-base">` with no surface, while the user's message rides a full-width `bg-composer` band. The user wants their reply to wear the same surface, with the `Thought` row kept *outside* it, the pair sitting close together and the same air underneath as a user message has. Separately, each reply gets a copy button that copies the reply's raw markdown and never the thinking. Both changes land in the same `case "agent-text":` block, so they are one task.

Decisions already made: the band reuses the **token** `bg-composer` (never a copied hex) so a palette moving `--color-composer` moves both bands together; the copy button is **always visible** and sits **outside/below** the band; it copies `message.text` verbatim (markdown source); thinking is excluded because it is a different render unit. This applies to `SubagentTranscript` too — it renders the same `MessageBubble`, and no prop gate is wanted.

**Files:**
- Modify: `src/components/MessageBubble.tsx` (the `case "agent-text":` arm, currently ~line 658)
- Test: `src/components/MessageBubble.test.tsx`
- Test: `src/components/chat/MessageList.gap.test.tsx` (update the two rhythm tests named below)

**What to implement:**

1. Replace the `agent-text` arm's return with a band wrapper. The current code is:

   ```tsx
   case "agent-text":
     return (
       <div className="text-ui-base">
         <AgentMarkdown text={message.text} />
       </div>
     );
   ```

   The band carries: `data-testid="agent-band"`, `data-testid`-style hook for tests, `rounded-xl bg-composer px-3 py-2 text-ui-base text-foreground`, plus the two margin classes `-mt-2 mb-5`. Mirror the user band's own class list (`MessageBubble.tsx:625`) but **keep `[overflow-wrap:anywhere]` off** — `AgentMarkdown` renders block elements and prose wraps correctly without it.

2. Then the copy button, as a **sibling after** the band (not inside it). Give it `data-testid="copy-response"`, `aria-label="Copy response"` (and `"Copied"` while confirmed — the two-state label is what the tests select on, matching `MessageBubble.codeblock.test.tsx`'s existing `"Copy code"` / `"Copied"` convention). Copy `message.text` — the prop, not the rendered output.

3. Reuse the **exact** copy pattern already in this codebase at `ToolCallCardHeader.tsx:62-79`: `const [copied, setCopied] = useState(false)`, a `useRef<number | null>` holding the timer, `navigator.clipboard?.writeText(text)?.then(...)` setting `copied` and a 1500 ms `window.setTimeout` to clear it, and a `useEffect` cleanup that clears the timer on unmount. `CopyIcon` and `CheckIcon` are **already imported** at the top of `MessageBubble.tsx` — do not add imports for them. Since the `agent-text` arm currently returns JSX inline from a `switch` inside the memoized default export, extract a small named component (e.g. `function AgentText({ text }: { text: string })`) above the default export so the hooks are legal — hooks cannot live directly in a `switch` arm of a component that has other early-returning arms.

4. **The margins, and why they are negative.** `MessageList`'s scroll container is `flex flex-col gap-3` (12px) and adds `mt-4` (16px) to a row whose neighbour is a tool row. Flex margins **add to** a gap and cannot subtract from it, so `mt-0` cannot make the `Thought → reply` gap smaller than 12px. To reach the agreed 4px the band carries `-mt-2` (−8px): 12 − 8 = **4px**. `mb-5` (20px): 12 + 20 = **32px**, which is measured-equal to the user band's existing gap below a user message (`data-testid="user-message"` carries `my-5`, pinned at `MessageBubble.test.tsx:197`). Put a comment on the `-mt-2` saying exactly this, and that removing it silently re-separates the `Thought` row from its reply — otherwise the next reader "cleans up" the negative margin.

5. **Do not** put `my-*` on the band the way the user case puts it on its *unit* — the user case deliberately puts `my-5` on the unit and not the band because its mention cards and image grid are siblings; `agent-text` has no siblings, so the margins belong on the band itself.

6. Update `MessageList.gap.test.tsx`. Its `extra()` helper reads the **row wrapper**'s classes (the wrapper `MessageList` renders), so the band's own margins are invisible to it and every existing assertion stays green — but two test *names/intents* now describe the old world, and one needs a real new assertion:
   - `"thinking → chat keeps the tight base gap (unchanged)"` — keep the wrapper assertions (they still hold) and add an assertion that the rendered `agent-text` row contains `[data-testid="agent-band"]` whose class list contains `-mt-2` and `mb-5`, with a comment that the wrapper carries no margin *on purpose* and the 4px lives inside.
   - `"tool → prose: the breathing gap is symmetric"` — unchanged; do not touch it.

**Acceptance criteria:**
- [ ] `npx vitest run src/components/MessageBubble.test.tsx src/components/chat/MessageList.gap.test.tsx` passes.
- [ ] `npx vitest run src/components/MessageBubble.codeblock.test.tsx src/components/MessageBubble.markdown.test.tsx` still passes (both render agent text through the changed arm).
- [ ] A new test asserts the band has `bg-composer`, `rounded-xl`, `-mt-2`, `mb-5`.
- [ ] A new test asserts `data-testid="user-band"` still has **no** `my-*` and `user-message` still has `my-5` (the user case must not regress).
- [ ] Copy test: stub clipboard with `Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })`, click, assert `writeText` was called with the raw `message.text` (including markdown characters like `` ` `` and `|`), then assert the button's accessible name becomes `Copied`.
- [ ] A test asserts the copy button is in the DOM **without** any hover/focus step (it is always visible).
- [ ] `npx tsc --noEmit` clean; `npx vitest run` green at 94 files.

---

### Task 2: Staged screenshots leave the composer at send, and return if the send fails

**Context:** The clearing code already exists in `send()` but runs *after* `await sendPrompt(...)`, so the thumbnails sit in the composer for the entire turn while the base64 copies of them have already been put on the user message. By the time `addUserMessage` has run, the staged `File`/object-URL pair has no remaining job. The existing guarantee "a failed send keeps your attachments, because a re-pasted image is costly and a re-typed draft is not" must survive, so the thumbnails go immediately and the attachments are **restored** on failure.

Decision already made: hold the sent attachments in a session-keyed ref instead of releasing them at clear-time, and release them when the turn settles.

**Files:**
- Modify: `src/components/ChatStream.tsx` (the `send()` function, ~lines 1077–1125, plus a new ref beside the other refs ~line 357)
- Test: `src/components/ChatStream.test.tsx` (the attachment group, ~lines 2060–2200)

**What to implement:**

1. Add a ref next to `attachments` / `attachmentsRef` (~line 357):

   ```ts
   /** Attachments handed to a send that has not settled yet, keyed by session id.
    * They are OUT of `attachments` (so their thumbnails leave the composer
    * immediately) but NOT released — a failed send puts them back. */
   const heldForSendRef = useRef<Map<string, ChatComposerAttachment[]>>(new Map());
   ```

2. In `send()`, immediately **after** `addUserMessage(targetSessionId, text, imageRefs)` and **before** `beginTurn(targetSessionId)` (~line 1081), move exactly the sent attachments out:

   ```ts
   if (sentIds.size > 0 && activeSessionIdRef.current === targetSessionId) {
     const held = attachmentsRef.current.filter((a) => sentIds.has(a.id));
     heldForSendRef.current.set(targetSessionId, held);
     const staged = attachmentsRef.current.filter((a) => !sentIds.has(a.id));
     attachmentsRef.current = staged;
     setAttachments(staged);
   }
   ```

   Note `sentIds` is already computed a few lines above (~line 1077) and `setDraft("")` / `addUserMessage` / `beginTurn` are already in that order — keep it.

3. In the success path, **replace** the existing release block (~lines 1091–1101, the one that filters `attachmentsRef.current` by `sentIds` and calls `releaseAttachment`) with: take `heldForSendRef.current.get(targetSessionId)`, `releaseAttachment` each, and delete the map entry. Keep the `activeSessionIdRef.current === targetSessionId` guard on the state-touching part.

4. In the `catch` block, restore **before** anything else that touches attachments: take the held list, and merge it back in front of whatever is staged now (the user can stage during a turn), de-duplicating by `id` so a re-staged item is not doubled:

   ```ts
   const held = heldForSendRef.current.get(targetSessionId);
   if (held && held.length > 0 && activeSessionIdRef.current === targetSessionId) {
     const live = attachmentsRef.current;
     const ids = new Set(live.map((a) => a.id));
     const back = held.filter((a) => !ids.has(a.id));
     const merged = [...back, ...live];
     attachmentsRef.current = merged;
     setAttachments(merged);
   }
   heldForSendRef.current.delete(targetSessionId);
   ```

   Do **not** revoke the restored attachments' object URLs — that is what makes the restored thumbnail render again. Leave the existing comment about a failed send keeping attachments, and update it to say the thumbnails now go at send and come back here.

5. Unmount cleanup already releases `attachmentsRef.current` (~line 396). Add the held ones too, or a send interrupted by unmount leaks object URLs. Same for the session-switch cleanup (~line 435), which must clear the held entry for the session being left.

6. **Do not** change `hasImages`, the `MAX_CHAT_ATTACHMENTS` caps, or the `imageCapable` fail-closed gates.

**Acceptance criteria:**
- [ ] New failing-first test, then green: paste an image, click Send, and assert the composer (`[data-testid="composer-island"]`) contains **no** `img` with that alt text **before** the mocked `sendPrompt` resolves — do this by leaving `sendPrompt` pending on a deferred promise and asserting while it is pending. This is the test that pins the actual bug and it must fail before step 2.
- [ ] Existing `"a failed send keeps attachments staged"` (`ChatStream.test.tsx:2165`) still passes **unmodified** — it waits for the `"boom"` error line and asserts the composer contains the thumbnail again. That is precisely the restore path.
- [ ] Existing success-path test (`~:2159`) still passes: composer has no thumbnail, the transcript renders the `data:` URL.
- [ ] Both existing `expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-s.png")` assertions (`:2067`, `:2120`) still pass, and a new test asserts `revokeObjectURL` was **not** called on the failed-send path.
- [ ] `npx vitest run src/components/ChatStream.test.tsx` green; `npx tsc --noEmit` clean.

---

### Task 3: `[image #N]` markers on every staging path

**Context:** The user wants a pasted screenshot to leave a `[image #N]` marker in the draft, and the marker is **sent to the model** as part of the prompt so a prompt can name a specific attachment. `N` counts the attachments **of that message**, never the session — that is the only reading true on the wire, because `src-tauri/src/agent/harness/loop.rs` (~`:736-750`) pushes the text block first and then the images in send order as OpenAI `image_url` parts, so "the Nth image of this prompt" is the one thing a model can resolve. A session-wide number would be meaningful to the user and unresolvable by the model.

Two decisions already made, both load-bearing:

- **Insert in `stageFiles`, not in the callers.** `stageFiles` (`ChatStream.tsx:1183`) is the single funnel for all four staging paths — paste-with-file-items (`:1224`), the WebKitGTK empty-paste clipboard fallback (`:1250`), drag-and-drop (`:1262`) and the `+` file picker (`:1312`). One edit covers all four. If only paste inserted markers, a mixed batch would number `#1, #3` and the number would stop matching the strip.
- **Numbering is by staging order, and removal compacts by that order — not by text order.** Because a marker is inserted at the caret, markers can appear in the draft in a different order than the attachments were staged. So the rewrite must key on the number itself: dropping the attachment at position `k` deletes `[image #k]` and decrements every marker whose number is `> k`. Do not "simplify" this to a positional rescan of the text; it would be wrong for exactly the caret case.

**Files:**
- Modify: `src/lib/chatAttachments.ts` (three new pure exports)
- Modify: `src/components/ChatStream.tsx` (`stageFiles` ~`:1183`, `removeAttachment` ~`:1318`)
- Modify: `src/components/chat/AttachmentStrip.tsx` (a `#N` badge on each thumbnail)
- Test: `src/lib/chatAttachments.test.ts`
- Test: `src/components/ChatStream.test.tsx` (the paste/attachment group)

**What to implement:**

1. In `src/lib/chatAttachments.ts` add three pure functions:

   ```ts
   /** The draft marker naming the Nth attachment of THIS message (1-based). */
   export function imageMarker(n: number): string;                       // `[image #${n}]`
   /** Insert `markers` (already-built text) at the caret. Returns the new text
    * and the caret. ONE call per staging event, never one per file. */
   export function insertAtCaret(text: string, caret: number, markers: string): { text: string; caret: number };
   /** After the attachment at 1-based position `k` is removed: drop `[image #k]`
    * and decrement every marker above it. Keyed on the NUMBER, not text order. */
   export function renumberImageMarkers(text: string, removedAt: number): string;
   ```

   `insertAtCaret` prepends a single space when the character at `caret - 1` is not already whitespace, and returns the caret immediately after the inserted text. `handlePaste` already calls `e.preventDefault()` (`:1221`) **before** `stageFiles`, so for an image paste the marker is the only thing that lands — there is no auto-inserted text to collide with, and any clipboard text alongside an image is discarded (existing behaviour, unchanged). The no-space branch is still real and reachable: a draft whose caret already follows a newline or space. Pin both branches on the helper as **unit** tests. `renumberImageMarkers` must be a single pass over the exact literal pattern `/\[image #(\d+)\]/g` — nothing looser, so ordinary prose mentioning "#3" is untouched.

2. In `stageFiles`, after `addImageAttachments` returns `next` and only when `next !== attachmentsRef.current` (i.e. something was actually staged — rejected files must insert nothing), insert the markers.

   **Build ONE string for the whole batch and insert it once.** A batch of N files staged in one call must produce `#k #k+1 …` **ascending**, numbered from `attachmentsRef.current.length + 1` upward. Inserting one at a time at the same caret yields `#3 #2 #1` — the numbers then run opposite to the attachment order, inverting the marker→image mapping on every multi-file paste. After the single insert, restore focus/caret inside a `requestAnimationFrame` — copy the refocus block from `selectMention` (`ChatStream.tsx:1388-1394`), because a controlled textarea drops focus on a programmatic `setDraft`.

   **Use the caret only when the textarea actually has focus.** `selectionStart` is `0` for a textarea that has never been focused, and two of the four staging paths (drag-and-drop, and the `+` file picker — the native dialog holds focus) routinely run that way, so the naive read would drop every marker at the *start* of the user's sentence. Use:

   ```ts
   const el = composerRef.current;
   const len = draftRef.current.length; // the LIVE mirror (:384), not the render closure
   const caret = el && document.activeElement === el ? (el.selectionStart ?? len) : len;
   ```

   `stageFiles` already reads `attachmentsRef.current` rather than the `attachments` state for exactly this reason ("a render closure would be stale for fast successive events", `:1184`) — the marker insert must apply the same discipline to the draft, or a 9th paste in a fast sequence reverts the draft to a stale value and drops the earlier markers. This is a deliberate divergence from the `:871` / `:1339` idiom, which is safe there only because both paths are reachable solely after typing (so the field is focused). Pin it: with a non-empty draft and the textarea never focused, a drop appends the marker to the END.

3. In `removeAttachment`, compute the removed item's **1-based position in the list being shown** (`attachmentsRef.current.findIndex(a => a.id === id) + 1`) *before* filtering, then `setDraft(renumberImageMarkers(draftRef.current, position))` — again `draftRef.current`, not the closure.

4. In `AttachmentStrip.tsx`, render `#{index + 1}` as a small badge on each thumbnail (`absolute`-positioned, `bg-input`-ish, non-interactive `aria-hidden`), so the number in the text is checkable against the picture it names.

5. **Pin the `#`-mention collision with a test, and treat this as required, not optional.** `MCP_MENTION_RE` is `/(^|\s)#([a-z0-9]+(?:-[a-z0-9]+)*)/g` (`src/lib/skills.ts:287`). In `[image #3]` the character before `#` is a space, so the left boundary is satisfied and `3` matches the token class — the marker is a **live mention candidate** that survives today only because unmatched tokens are left verbatim (invariant 5). Add a test that stages an image with an MCP catalog containing a server named `3` and asserts the draft is sent **unchanged** (`sendPrompt` receives the text byte-for-byte), so a future server literally named `3` cannot silently turn a marker into an expanded `<mcp>` block.

6. Do not touch `send()`'s text handling: the marker is ordinary draft text and reaches the model through the existing path. Do not add a Rust change. Do not strip markers anywhere.

**Acceptance criteria:**
- [ ] Unit tests for all three helpers, including: two pastes give `#1` then `#2`; a rejected file inserts no marker; `renumberImageMarkers` on `[image #1] [image #3]` with `removedAt=2` yields `[image #1] [image #2]`; prose containing `#3` without the brackets is untouched; a marker whose number equals the removed one is gone entirely.
- [ ] Component test: paste one image → textarea value contains `[image #1]`; paste a second → contains `[image #1]` and `[image #2]`.
- [ ] Component test through the `+` picker path and the drop path: both insert a marker (the "all four paths" claim is what is under test).
- [ ] Component test: paste two, remove the first via the ✕ → draft reads `[image #1]` (the survivor renumbered), and `sendPrompt` is called with exactly that draft text.
- [ ] The `#`-mention immunity test from step 5.
- [ ] `npx vitest run src/lib/chatAttachments.test.ts src/components/ChatStream.test.tsx` green; `npx tsc --noEmit` clean.

---

### Task 4: The row token family, and deleting the dead trajectory family

**Context:** Tool-row glyphs become orange and the verbs (`Ran`, `Thought`, `Edited`, …) light blue, behind two reusable tokens so a palette can re-hue them without touching a component. The pair is named `--color-row-icon` / `--color-row-verb` for `TRANSCRIPT_ROW` (`src/components/lib/transcriptRow.ts`), the class constant the tool rows, the `Thought` trigger and the `Changes` group already share — so all three consumers are in scope, not just tools.

There is **already** a transcript-row hue family: `--color-trajectory-{user,assistant,reasoning,tool-call,tool-result}`, declared in four CSS layers and listed in `CONTEXT.md` under **Identity color** as live. **Nothing consumes it** — no component or `src/lib` module references `trajectory`; only `paletteCompleteness.test.ts`'s `INHERITED` list keeps the names alive. It is deleted in this same task, so the codebase ships one row-hue family rather than two, one of which renders nowhere. Rationale and the accepted collision with `--color-warning` are in `docs/decisions/0062-*.md`; this task adds that ADR's amendment.

Decisions already made: alias back to the current tokens in every layer except Dracula (zai renders unchanged apart from the one `Thought` glyph, per Correction 1 above); `.theme-dracula` gets `#ffb86c` / `#8be9fd`; a pending call keeps `animated-gradient-text` and the verb colour lands only when settled.

**Files:**
- Modify: `src/styles/theme.css` — add 2 tokens to `@theme` (~after line 39), `.dark` (~line 328), `.theme-zai-light` (~line 498), `.theme-zai-dark` (~line 646); **delete** the 5 trajectory lines at `35-39`, `232-236`, `410-414`, `558-562` (20 declarations)
- Modify: `src/styles/dracula.css` — add the 2 tokens with the real hexes (near the other structural accents, e.g. after `--color-warning` ~line 417)
- Modify: `src/components/ToolCallCardHeader.tsx` (icon `:87`, verb `:88-95`)
- Modify: `src/components/ChangesGroupCard.tsx` (icon `:153`, label `:154`)
- Modify: `src/components/Reasoning.tsx` (brain icon `:396`, the two `Thought` label spans `:366` and `:376`)
- Modify: `src/lib/paletteCompleteness.test.ts` (`INHERITED` entries `:224-228` + its prose `:148`; counts `:458`, `:466`, `:467`, `:468`, `:472`, `:632`, comment `:451-454`, `:459-465`)
- Modify: `src/lib/themeTokens.test.ts` (add the new family to `MEANINGFUL_TOKENS` and add a per-palette hex gate)
- Modify: `docs/decisions/0062-*.md` (append an Amendment section — this branch's commit is unpushed, so amend the file rather than opening a new ADR number)

**What to implement:**

1. **Append an `## Amendment` to ADR 0062 first**, recording Correction 1: `Reasoning`'s brain glyph is `text-foreground-subtlest` today while its two siblings are `text-foreground-subtle`, so the alias makes the three consistent and the zai `Thought` glyph slightly more opaque — the "byte-identical" claim is therefore too strong, and the unification is the intended outcome. Write it before the CSS so the plan's order matches the reasoning.

2. Add both tokens to the four non-Dracula layers with the alias readings:

   ```css
   --color-row-icon: var(--color-foreground-subtle);
   --color-row-verb: var(--color-foreground-subtlest);
   ```

   and to `.theme-dracula`:

   ```css
   --color-row-icon: #ffb86c; /* Orange */
   --color-row-verb: #8be9fd; /* Cyan */
   ```

   Each gets a one-line comment naming the other token as its sibling and pointing at ADR 0062 for the `--color-warning` collision. Both hexes are Dracula-spec-published, so the existing spec gate passes without touching the allow-list.

3. Delete the 20 trajectory declarations. Then update `paletteCompleteness.test.ts`: drop the 5 `INHERITED` entries (`:224-228`) and the `8 git-* and 5 trajectory-*` prose (`:148`) → `8 git-*`.

4. Move the hardcoded counts. These were **computed** against this tree, not estimated — `BEFORE → AFTER`:

   | Assertion | Now | After |
   |---|---|---|
   | `INHERITED.length` (via the `:472` cross-check) | 59 | 54 |
   | `[...DRACULA].length` (`:466`) | 117 | **119** |
   | `diff(DARK, new Set(INHERITED)).length` (`:467`) | 92 | **94** |
   | `ZAI_DARK.size` (`:468`) | 170 | **167** |
   | `ZAI_DARK.size - DRACULA.size == INHERITED.length - 6` (`:472`) | 53 == 53 | 48 == 48 ✓ |
   | `Object.keys(DRACULA_VALUES).length` (`:632`) | 117 | **119** |

   Also fix the `:458` test **title** string (`"is 117 declarations: 86 structural + 25 descriptors + 6 ramp"` → `"is 119 declarations: 88 structural + 25 descriptors + 6 ramp"`) and the `:459-465` arithmetic comment (86 → 88, 92 → 94, 117 → 119). Leave the `(83)` at `:453` alone: it is **already stale on main** (measured 86, and the sibling comment at `:460` already says 86), it is inside a comment on a test whose assertion is derived rather than hardcoded, and correcting a pre-existing inaccuracy is not in this task's scope. The deletion and the addition push the four hardcoded counts in opposite directions, which is exactly why a partial edit fails rather than passing quietly — take that as confirmation the gate works, not as a sign to loosen it.

5. Repaint the three consumers, taking care to touch **only** the glyph and the verb/label — each row has other muted spans that must stay `text-foreground-subtle*`:
   - `ToolCallCardHeader.tsx:87` icon → `text-row-icon`. Verb span `:88-95`: keep the `status === "pending" ? "animated-gradient-text" : ...` conditional and change only the settled branch to `text-row-verb`. The summary, range and command spans stay as they are.
   - `ChangesGroupCard.tsx:153` icon → `text-row-icon`; `:154` `Changes` label → `text-row-verb`. The `filesCountLabel`, separator and failure `XCircleIcon` (`text-destructive`) are untouched.
   - `Reasoning.tsx:396` brain icon → `text-row-icon`; the two `Thought` label spans (`:366`, `:376`) → `text-row-verb`. The `·` separator spans, the duration span and `streamingSummary` stay `text-foreground-subtlest`. The streaming `animated-gradient-text` variant (`:359`) is untouched.

6. In `themeTokens.test.ts`, add `color-row-icon` and `color-row-verb` to `MEANINGFUL_TOKENS`, and add a **new** gate pinning the two hexes per palette. State in its comment what it is for: the existing `statusCollisions` detector only inspects the thinking ramp, so it cannot see that a decorative family rides `--color-warning`'s hex — the new test does not assert the collision is absent (it is not), it fails a future change that collapses the family onto `--color-warning` / `--color-interaction-ask-foreground` **by removing the name from the block**.

**Acceptance criteria:**
- [ ] `npx vitest run src/lib/paletteCompleteness.test.ts src/lib/themeTokens.test.ts src/lib/fileIconContrast.test.ts src/lib/slabFloatSeparation.test.ts` green (all four read the CSS).
- [ ] A test asserts `--color-row-icon` and `--color-row-verb` are declared in all five layers, and that zai's readings are the `var()` aliases.
- [ ] A test asserts `trajectory` appears in **no** CSS layer and in no `src/**` file (`grep -rn trajectory src/` returns only test-list deletions).
- [ ] `npx vitest run src/components/ToolCallCard.test.tsx src/components/Reasoning.test.tsx src/components/ChangesGroupCard.test.tsx` (and whatever else exists for these) green with the pending-shimmer behaviour intact.
- [ ] `npx tsc --noEmit` clean; full `npx vitest run` green.
- [ ] Manual check required before merge (jsdom cannot see this): under **Dracula**, glyphs orange / verbs cyan; under **zai dark**, nothing looks different except the `Thought` glyph being marginally stronger.

---

### Task 5: Move Model / Reasoning / Context to the bottom of the side pane

**Context:** The context bar, model selector and reasoning-level selector leave the composer's bottom row and become three stacked lines at the bottom of the right pane, in the order Model, Reasoning, Context. Decisions already made: pinned **after** the scroll area (the content div is `flex-1 overflow-y-auto p-3` and the todo boards grow, so a block inside it scrolls away and drifts with board length); triggers become **full line-width**; the composer keeps only the `+` and Send buttons, **both right-aligned**; and when the pane is collapsed to its 40px rail there is deliberately no access to these three — the user expands the pane to change model. A useful side effect: `ChatStream.tsx:289-291` documents that a per-option closure re-rendered ~600 mounted model `SelectItem`s at ~140 ms per composer keystroke, which is why `setConfigValue` was hoisted into a stable callback; with the selectors in `SidePane`, typing cannot re-render them at all, because the pane reads stores and not `draft`.

Behaviour that must survive the move, all of it currently in `ChatStream`: the four-way `configOptions` / `contextUsage` fallback (live map → `sessions` → `historySessions` → `archivedSessions`), `disabled={!isLive}` for a stored session, and the traffic-light ramp (success <50, caution <70, warning <90, destructive above).

**Files:**
- Create: `src/lib/sessionConfig.ts` — the shared derivation
- Create: `src/components/chat/SessionConfigBlock.tsx` — the three lines
- Create: `src/lib/sessionConfig.test.ts`
- Modify: `src/components/SidePane.tsx` (mount the block after the scroll div, ~`:447`, before the `bottom-2 left-2` toggle at `:456`)
- Modify: `src/components/chat/ComposerRow.tsx` (delete the context bar block ~`:292-365` and the config cluster ~`:366-390`; delete 7 now-unused props)
- Modify: `src/components/ChatStream.tsx` (delete the derivations at `:228-304` that only fed the composer, replace with imports from the new lib; delete the 7 props passed at `:1487-1492`)
- Modify: `src/components/SessionConfigSelect.tsx` (add a `fullWidth` prop)
- Test: `src/components/SidePane.test.tsx` — **receive** the 13 relocated tests
- Test: `src/components/ChatStream.test.tsx` — **lose** those 13, gain two pins

**What to implement:**

1. Create `src/lib/sessionConfig.ts` exporting, as plain functions over the `useSessions` state shape so both components can call them inside a selector:

   ```ts
   export function sessionConfigOptionsOf(s, id): SessionConfigOption[] | null;   // the 4-way fallback
   export function contextUsageOf(s, id): { used: number; window: number } | undefined;  // the 4-way fallback
   export function contextPercentOf(u): number | undefined;                       // min(100, round(used/window*100))
   export function contextRampFor(p): { fill: string; label: string };             // the traffic-light bands
   export function findConfigOption(options, category, id): SessionConfigOption | undefined;
   ```

   These are **moves**, not new logic — lift the bodies from `ChatStream.tsx:232-291` unchanged, keeping the `window > 0` guard and the exact band thresholds. `ChatStream` keeps whatever it still needs by importing these; if a derivation ends up used only by the pane, remove it from `ChatStream` entirely (`noUnusedLocals` will fail the build otherwise).

2. Create `SessionConfigBlock.tsx`: three stacked rows in the order **Model, Reasoning, Context**, each full-width. Read from the store with the new selectors; `isLive` is `!!activeSession?.id` resolved by the same predicate `ChatStream.tsx:887` uses (`s.sessions.find(x => x.sessionId === s.activeSessionId)`); `onSet` reproduces `ChatStream.tsx:294-304` (call `setSessionConfigOption`, then `applyConfigOptions`) with the same stable-callback shape. Keep every `data-testid` the moved tests select on: `composer-config-controls`, `context-usage-bar`, `context-bar-icon`, `context-usage`, `model-icon`, `thinking-level-icon`, plus `data-testid="session-config-block"` on the wrapper. Keep the `role="progressbar"` / `aria-valuetext` treatment and the counts tooltip verbatim.

3. `SessionConfigSelect`: add an optional `fullWidth?: boolean`. When true, use full-width classes in place of `COMPOSER_TRIGGER_WIDTH` and its edge classes, on **all three** render branches — the model branch passes through `triggerClassName` into `ModelPicker` (which accepts it, `ModelPicker.tsx:41`), the thinking branch sets `SelectTrigger`'s class, and the `option === null` disabled-stub branch has its own `Button`. Leaving the stub branch narrow is the easy mistake here.

4. Mount in `SidePane` **after** the `flex-1 overflow-y-auto p-3` content div and **before** the toggle button, with bottom padding that clears the absolutely-positioned `bottom-2 left-2` toggle. It is NOT data-gated — it always renders (unlike the todo section). It must stay mounted while collapsed, but the collapsed rail shows nothing of it: the content area's `invisible`-while-collapsed trick does not reach it, so gate its visibility the same way so it cannot paint into the 40px sliver.

5. Relocate the 13 tests from `ChatStream.test.tsx` into `SidePane.test.tsx`, changing only the render target and the container they query. They are, by current line number: `:955` (closed/history-only session's bottom row), `:1324` (both selects render), `:1364` (the model+thinking cluster — its *premise* dies, so rewrite it to assert one-per-line order Model → Reasoning → Context instead of "one tight cluster"), `:1410`, `:1446`, `:1471`, `:1498`, `:1520`, `:1542`, `:1563`, `:1576`, `:1587`, `:1646`. `SidePane.test.tsx` already seeds `useSessions` directly and already does `vi.importActual("../lib/tauri")` (`:13`) — add `setSessionConfigOption` to that mock. **Deleting a moved test's assertions to make it pass is a failure, not a fix:** each relocated test must assert the same thing it asserted before, against the pane.

6. In `ComposerRow.tsx`, delete the props `contextPercent`, `contextRamp`, `contextUsage`, `modelOption`, `thinkingOption`, `setConfigValue`, `isLive` from the destructure and the type — `isLive` is used *only* by the two selects (`:382-383`), so it becomes unused and `noUnusedParameters` will fail the build if it lingers. Right-align the remaining `+` and Send together; delete the now-stale comments about the config cluster and the context track (or move them into `SessionConfigBlock.tsx` — they belong to the code that now owns the bar).

7. Add two new composer pins in `ChatStream.test.tsx`: the composer island contains **no** `[data-testid="context-usage-bar"]` and no `[aria-label="Model"]`, and the `+` and Send buttons are both present.

**Acceptance criteria:**
- [ ] All 13 relocated tests pass in `SidePane.test.tsx`, and each still asserts what it asserted in `ChatStream.test.tsx` (spot-check the ramp band tests: they must still distinguish caution / warning / destructive).
- [ ] The stored-session test still shows populated-but-**disabled** selectors, and the "live config options win over the row's" test still proves the store's map wins.
- [ ] `npx vitest run src/components/ChatStream.test.tsx` green with the new "composer no longer hosts these" pins.
- [ ] A collapsed-pane test asserts the block paints nothing into the rail (mirroring how the todo board's `invisible` gate is tested).
- [ ] `pnpm build` clean — this is the task where an unused prop would surface.
- [ ] Manual check required before merge: with the todo board long, the three lines stay pinned while the board scrolls; the collapse toggle is still clickable and unobstructed.

---

## Final verification

- [ ] `npx vitest run` → 94+ files, all green (baseline was 2054 tests; Tasks 1–5 add tests, so the count goes up).
- [ ] `pnpm build` → clean (no unused locals/params, no type errors).
- [ ] `grep -rn "trajectory" src/` → no matches outside deletions already made.
- [ ] No Rust: `git diff --name-only main...HEAD` must contain **no** `src-tauri/**` path.
- [ ] Manual, under **both** Dracula and zai dark (jsdom asserts nothing about pixels): band shape and the 4px/32px rhythm; copy button placement; orange glyphs / cyan verbs; the three pane lines and the scroll behaviour; markers appearing on paste, drop and `+`.
- [ ] Commit the docs changes (plan, ADR 0062 amendment) before opening the PR.
