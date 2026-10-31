import { useEffect, useMemo } from "react";
import type { RefObject } from "react";
import { fuzzyMatch } from "../lib/fuzzy";
import { composerCommands } from "../lib/composerCommands";
import {
  activeMentionToken,
  isOutsideSpaceQuery,
  type ComposerPrefix,
} from "../lib/skills";
import { IPC_EVENTS } from "../lib/ipc/events";
import type {
  AgentDefinitionDto,
  CompletionDirDto,
  ListingDto,
  McpServerInfo,
  SkillInfo,
} from "../lib/tauri";
import type { MentionRow } from "../components/chat/ComposerMentions";

/**
 * The composer's **Mention picker** — cluster C of `ChatStream` (Phase D /
 * Task D4). It owns the picker's whole derivation half: the bounded rows, the
 * one explanation line, the derived highlight index, the
 * `archimedes:insert-skill` listener, and `selectMention`.
 *
 * ## The four prefixes and their three semantics
 *
 * `$` skills / `#` MCP servers / `@` agents are **Mention**s (ADR 0031 — they
 * expand into a block on send); `?` is **File completion** (ADR 0033 — it
 * inserts a path and expands NOTHING); `/` is a **Composer command** (ADR 0044
 * — CONSUMED on send, no prompt, nothing expanded). ONE picker, filtered to the
 * ACTIVE prefix's catalog; the meaning is not shared.
 *
 * ## What this hook does NOT own (each is a measured boundary, not taste)
 *
 * - **The draft.** It is written from eleven sites across the send path, the
 *   attachment path and here, so it comes in and out as a value plus a setter.
 *   `draftRef` is the caller's live mirror, passed through because the
 *   insert-skill effect runs ONCE and must read the live string.
 * - **`dirPrefix`, the Directory-completion CACHE KEY.** The derivation stays in
 *   `ChatStream`: `ChatStream.test.tsx` pins it at component level and its own
 *   comment records that a hook-level caching test cannot prove it — with
 *   `dirPrefix` as an argument a hook shows only "same input, same output",
 *   which cannot distinguish "the key is the directory" from "the key is the
 *   whole remainder". So the caller derives it, calls `useCompletionDir` with
 *   it, and hands the resulting payload in below. `activeRemainder`/`outside`
 *   are re-derived HERE for the rows and the note — three lines, both pure
 *   functions of `picker`, which is the one thing both sides read.
 * - **…and that is why the `picker` cell is an ARGUMENT, not private state.**
 *   The cycle is exact and unavoidable: `dirPrefix` is a pure function of
 *   `picker`, the completion payload is a function of `dirPrefix`, and the rows
 *   memo is a function of the payload. Putting `picker`'s `useState` inside this
 *   hook would make the caller need a value this hook returns in order to build
 *   an argument this hook takes — and the only ways out are worse than the
 *   asymmetry: reading the payload through a ref inside the memo (the dep graph
 *   would stop seeing it, and `completion` in those deps is mutation-checked —
 *   dropping it reddens the two descent-goes-live tests), or moving `dirPrefix`
 *   in here (which is the pin forbidden above). So the cell is DECLARED by the
 *   caller, passed in, and returned back out unchanged — the same shape as
 *   `draft`/`setDraft` one argument up, and the state is still exactly one cell.
 * - **`completionPending`.** Same reason: it belongs to the fetch the caller
 *   owns, and `ComposerRow` takes it from there directly.
 * - **The keyboard.** `ComposerRow`'s `onKeyDown` re-derives the token from the
 *   caret on every keydown and owns the arrow/Enter/Tab/Escape branches; the
 *   layering with the stale-token guard below is documented at that guard.
 *
 * ## Hook placement (load-bearing, and the reason this is ONE call)
 *
 * `ChatStream` calls this ABOVE its `if (!activeSessionId) return`. Three tests
 * render no-session → active-session and a hook placed after that early return
 * throws "Rendered more hooks than during the previous render" — the white-page
 * crash — so every hook this file contains must stay inside this one call site.
 */

/** The `picker` state: the active token (its prefix + the typed remainder) and
 * the highlighted row index. `null` means no token under the caret. */
export interface MentionPickerState {
  prefix: ComposerPrefix;
  query: string;
  index: number;
}

/**
 * The cap on the picker's RENDERED rows (`filtered`) for the `?` File
 * completion ONLY, independent of the backend's walk cap
 * (`MAX_PICKER_ENTRIES` in `src-tauri/src/commands/files.rs`). The `?` branch
 * filters with `fuzzyMatch` — a loose SUBSEQUENCE match — so a short query
 * like `?e` can match nearly the whole listing (up to the walk cap), and
 * thousands of `<button>`s re-rendered per keystroke is a real perf gap.
 * Applied INSIDE the rows memo (never in the render), so `activeIndex`, the
 * `% filtered.length` arrow-wrap and the DOM all see ONE bounded list — a
 * render-time cap would let the highlight land on a row that is not displayed.
 *
 * WHY TEN, and WHY `?` ONLY. Capping a path query costs little: its catalog is
 * the ENTIRE Space listing, and two more typed characters collapse a thousand
 * matches into a handful (`sort_by_file_name` keeps the survivor set
 * deterministic), while 10 single-line rows are ≈308px at the default 14px UI
 * font (`--ui-font-size`) — a normal dropdown. The three Mentions
 * (`$` / `@` / `#`) are deliberately UNCAPPED, and NOT by omission: because
 * the cap is a slice INSIDE the rows memo, a sliced row is a row no keyboard
 * user can ever reach, and their catalogs are small and user-owned rather than
 * the whole filesystem. What bounds that uncapped case is GEOMETRY, not a count
 * — the picker box clamps its own height (a font-size-relative `max-height`)
 * and scrolls the active row into view — which is exactly why a count cap here
 * is about KEYS and PERF and never about height. See the Mention branch of the
 * rows memo for the same reasoning at the point of the missing slice.
 */
const MAX_PICKER_ROWS = 10;

export interface UseMentionPickerArgs {
  /** The composer draft, as the caller holds it. */
  draft: string;
  /** The caller's setter — the hook never owns the draft. */
  setDraft: (value: string) => void;
  /** The caller's LIVE-draft mirror (the insert-skill effect runs once). */
  draftRef: { current: string };
  /** The composer textarea, for the two caret reads and the two caret writes. */
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** The active picker token, or `null`. Declared by the caller — see the
   * cycle recorded in the header. */
  picker: MentionPickerState | null;
  /** The cell's setter, also the caller's (the keyboard branches in
   * `ComposerRow` write it directly). */
  setPicker: (picker: MentionPickerState | null) => void;
  skills: SkillInfo[];
  agents: AgentDefinitionDto[];
  mcpServers: McpServerInfo[];
  /** The Space's cached `?` Listing (ADR 0033). */
  files: ListingDto;
  /** The ONE directory's rows for an out-of-Space `?` token (ADR 0035). */
  completion: CompletionDirDto;
  /** Whether the `#` trigger names an MCP server (ADR 0031's follow-up). */
  mcpMentionsEnabled: boolean;
}

export function useMentionPicker(args: UseMentionPickerArgs): {
  picker: MentionPickerState | null;
  setPicker: (picker: MentionPickerState | null) => void;
  filtered: MentionRow[];
  note: string | undefined;
  activeIndex: number;
  selectMention: (row: MentionRow) => void;
} {
  const {
    draft,
    setDraft,
    draftRef,
    composerRef,
    picker,
    setPicker,
    skills,
    agents,
    mcpServers,
    files,
    completion,
    mcpMentionsEnabled,
  } = args;
  // The `$`/`#`/`@`/`?`-trigger picker cell (the active token (incl. its
  // prefix) + the highlighted row) arrives from the caller and is handed back
  // out unchanged — the header records why the `useState` cannot live here. The
  // three Mention prefixes expand into a block on send; `?` is File completion
  // and expands nothing (ADR 0033).
  // --- Out-of-Space Directory completion (ADR 0035), the ROW side -----------
  // A `?` token whose remainder begins `/`, `~/` or a Windows drive root is NOT
  // a Space query: the picker switches from the cached Space **Listing** to
  // **Directory completion** for the ONE directory the token names. The mode is
  // derived from the token's remainder (`picker.query` IS that remainder — the
  // grammar already decided it, and `activeMentionToken` deliberately returns no
  // mode field), so there is exactly ONE source of truth for "which token is
  // under the caret".
  //
  // THE CACHE KEY IS DERIVED ELSEWHERE, ON PURPOSE. `dirPrefix` — the same
  // remainder cut at its LAST `/` — is the completion catalog's cache key, and
  // `ChatStream` still derives it and passes the resulting `completion` in
  // above: the component-level test that pins the KEY cannot be restated as a
  // hook test (see the header). `outside`/`segment` below are the ROW half of
  // the same two cuts and read only `picker`.
  const activeRemainder = picker?.prefix === "?" ? picker.query : "";
  const outside = isOutsideSpaceQuery(activeRemainder);
  // The token's non-directory tail — what the rows are filtered by. The MIRROR
  // of the caller's `dirPrefix`: the same `lastIndexOf("/")`, the other side of
  // it, over the same WHOLE remainder. The absorbed prose therefore lands
  // INSIDE the segment and `fuzzyMatch` is a subsequence test over it, so the
  // directory's contents decide (ADR 0035's accepted cost, pinned and explained
  // in `skills.ts`). Truncating the segment as well would silently rewrite that
  // accepted behaviour.
  const segment = outside
    ? activeRemainder.slice(activeRemainder.lastIndexOf("/") + 1)
    : "";
  // The catalog rows matching the active token. The three Mention prefixes
  // filter case-insensitively on a NAME SUBSTRING (v1: name only, not
  // description); `?` filters with `fuzzyMatch` — a SUBSEQUENCE match —
  // because a path query is path-SHAPED (`src/comp/Form` must reach
  // `src/components/Formula.tsx`). `picker?.query ?? ""` yields
  // the full list while the picker is null (harmless — the picker UI is gated
  // on `open && (filtered.length > 0 || note)` in `ComposerMentions`, and
  // `open` is the `picker` state, so a null picker renders nothing either
  // way). NULL-SAFE: the `picker` state is
  // `{…} | null` and this `useMemo` lives in the unconditional top block, so a
  // bare `picker.query` would be a TS18047 compile error under `strict: true`
  // (and a `picker!` "fix" would crash at render whenever the picker is
  // closed, i.e. nearly every render).
  // Returns the bounded rows AND the UNBOUNDED match count (the "too many
  // matches" note needs to know the cap actually trimmed something).
  const pickerRows = useMemo(() => {
    // ONE picker, filtered to the ACTIVE prefix's catalog only (a `$`/`#`/`@`
    // never mixes in one open list): map the matching catalog to `MentionRow`
    // (skills/agents carry `description`, the MCP servers carry their one-line
    // `summary`, and every `?` row — of either shape — carries NO description,
    // so it renders on one line). A Space `?` row puts the Space-RELATIVE path
    // in `name`; an OUT-OF-SPACE row puts the ABSOLUTE path in `name` (that is
    // what gets inserted) and the abbreviated `~/…` in `label` (ADR 0035).
    const prefix = picker?.prefix ?? "$";
    // STALE-TOKEN GUARD — what it actually protects (the hazards are easy to
    // overstate). The `picker` state is only recomputed in the textarea's
    // `onChange`/`onKeyDown`, so it can outlive the token it was derived from.
    // The case that matters: `send()` clears the draft but NEVER clears
    // `picker`, so on the pre-`?` code the picker VISUALLY RESURRECTED over an
    // emptied composer (and a catalog that landed afterwards — an in-flight
    // `listSpaceListing`, ADR 0033's degradation path — re-fed it rows). The
    // Send button never passes through the keydown recompute at ALL, so this
    // guard is the only thing standing between a cleared draft and a picker
    // rendered on screen. THE LAYERING: this memo guard owns RENDERING (no
    // rows, no note); the keydown recompute in `ComposerRow` owns KEYS — it
    // re-derives the token from the caret on EVERY keydown and, with the token
    // gone, closes the picker AND sends on Enter, so Enter never "inserts" on a
    // cleared draft even without this guard. Deliberately NOT handled by
    // `setPicker(null)` in `send()`: that would be redundant (this guard is
    // strictly more general — any stale token, not just the send path), and the
    // `draft` dep below is free (the memo already re-derives per keystroke via
    // `picker`). The test itself is cheap and sound: `<prefix><query>` is by
    // construction a literal substring of the draft while the token is intact,
    // so its absence means the state is stale. DOM- and caret-free on purpose:
    // a ref read inside a `useMemo` is invisible to the dep graph.
    if (picker && !draft.includes(`${picker.prefix}${picker.query}`)) {
      return { rows: [], matched: 0, live: false };
    }
    // The `#` gate (see the `mcpMentionsEnabled` note above): with the trigger
    // off, the MCP catalog is EMPTY, so `#` yields no rows → the picker renders
    // nothing and the keyboard branches (gated on `filtered.length > 0`) never
    // intercept a key — Enter still sends. `mcpMentionsEnabled` is a DEP below,
    // so flipping the setting re-derives the rows LIVE (no remount, and the
    // catalog FETCH is not gated — see the `mcpMentionsEnabled` note in
    // `ChatStream`).
    const mcpCatalog = mcpMentionsEnabled ? mcpServers : [];
    const query = picker?.query ?? "";
    // `?` is File completion (ADR 0033) — the ONE non-Mention prefix, listed
    // FIRST so it never falls through to the skills catalog. The `key` carries
    // the trigger (`?` + path) because a path and a skill name could otherwise
    // collide; `description` is EMPTY, so a `?` row renders on ONE line
    // (`ComposerMentions` renders the secondary line only when it is `""`-free
    // text). It used to be `basenameOfPath(p)` — the basename is already the
    // TAIL of the path in the primary line, so that second line repeated what
    // the row just said and made every row ~50% taller for nothing.
    if (prefix === "?") {
      // THE ORDER OF THE TWO ARMS BELOW IS LOAD-BEARING FOR THE BEHAVIOUR, not a
      // style choice, and the reason is an ASYMMETRY between them: the Listing arm
      // is guarded by `!outside`, the out-of-Space arm is the unguarded
      // fall-through. Put the completion arm first and it swallows EVERY `?`
      // token, so a relative `?README` stops offering Space Listing rows.
      // MUTATION-CHECKED: neutering this guard reddens a GROUP of tests in
      // `ChatStream.test.tsx`, headed by "a relative `?query` still offers the
      // Space Listing rows and NEVER reads a directory" and including the
      // cap/note group around it. NO COUNT IS WRITTEN HERE ON PURPOSE: this note
      // said FOURTEEN, the group has since grown, and a number in a comment is a
      // countdown timer. If this ever wants reordering, the completion arm needs
      // its own `outside` guard first — do not just move it.
      //
      // There used to be a SECOND, purely textual reason for this order, and it is
      // GONE: a pin in `src/lib/skills.test.ts` read this file as TEXT, located a
      // filter predicate by scanning forward from this branch's gate, and ran it
      // through `new Function`. A swap broke that pin with `ReferenceError: segment
      // is not defined` while `ChatStream.test.tsx` reported the BEHAVIOUR as fine,
      // which was the misleading part — it made a real behavioural constraint look
      // like a test artifact. `86afd0d` deleted that pin outright (a rename of an
      // unrelated local made the whole file fail to LOAD, and every mutation it
      // caught was also caught by a component test) and replaced it with a test that
      // drives the real picker. So the order here now rests on the behaviour alone.
      //
      // IN the Space: the cached Listing, unchanged (ADR 0033). `name` is the
      // Space-RELATIVE path — what a Space file is addressed as — and
      // `selectMention` inserts it verbatim.
      if (!outside) {
        const fileRows: MentionRow[] = files.entries
          .map((p) => ({
            key: `?${p}`,
            prefix: "?" as const,
            name: p,
            description: "",
          }))
          .filter((r) => fuzzyMatch(query, r.name));
        const matched = fileRows.length;
        // The cap lives HERE, on the `?` branch alone: this is the one catalog
        // whose filter is a loose subsequence over an unbounded listing.
        return { rows: fileRows.slice(0, MAX_PICKER_ROWS), matched, live: true };
      }
      // OUT OF THE SPACE (ADR 0035): the rows are ONE directory's entries, not
      // the Space Listing. Filter the DTO entries FIRST and on each entry's OWN
      // `name`, then map — filtering the absolute `insert` instead is a real
      // bug, not a style point: a path is a strict SUPERSET of its own basename,
      // so path-filtering offers rows basename-filtering would drop (measured:
      // query `eu` offers `htop`, whose path `/home/u/.config/htop` contains
      // `e`…`u`, while its name does not). MUTATION-CHECKED — filtering
      // `e.insert` reddens "the outside rows are filtered on the entry's OWN
      // name" in `ChatStream.test.tsx`.
      //
      // The backend already returns directories first, and the sort below is
      // re-stated here rather than trusted: this is the branch that decides what
      // the DESCENT looks like, and a stable `sort` of an already-correct order
      // costs nothing (V8's sort is stable, so each group keeps the walker's
      // name order).
      const hits = completion.entries.filter((e) =>
        fuzzyMatch(segment, e.name),
      );
      const ordered = [...hits].sort(
        (a, b) => Number(b.isDir) - Number(a.isDir),
      );
      const rows: MentionRow[] = ordered.slice(0, MAX_PICKER_ROWS).map((e) => ({
        // `key`/`name` are the ABSOLUTE path — `selectMention` inserts
        // `row.name`, and nothing in this app expands a tilde (ADR 0035); the
        // row SHOWS `display`. No `?` prefix on the key: an absolute path
        // cannot collide with a skill/agent/server name, and within one
        // directory an insert is unique.
        key: e.insert,
        prefix: "?" as const,
        name: e.insert,
        label: e.display,
        isDir: e.isDir,
        description: "",
      }));
      // `matched` is the UNBOUNDED count, exactly as the Listing arm
      // returns it, because `pickerNote`'s "too many matches" arm reads it:
      // an outside branch that omitted it would silently kill that note.
      // MUTATION-CHECKED — returning the BOUNDED `rows.length` here reddens
      // exactly one test, "an outside completion caps at 10 rows and says the
      // too-many-matches note".
      return { rows, matched: hits.length, live: true };
    }
    // `/` is a **Composer command** (ADR 0044) — the fourth prefix on this
    // picker and the third semantics: a command row is CONSUMED on send, it
    // expands nothing and reaches no Agent. The arm MUST come before the
    // `prefix === "#" ? …` chain below, whose fall-through is `skills.map(…)`: a
    // `/` token that reached it would list every skill (an empty `/` query
    // matches every name). And the rows are built HERE rather than inside that
    // chain, because the chain ends in a shared case-INSENSITIVE name-SUBSTRING
    // filter — routing commands through it would silently replace the EXACT,
    // case-sensitive `startsWith` the grammar uses with a fuzzy match, and
    // `/COMP` would offer a row the dispatcher then refuses to run.
    // `startsWith` on the RAW `query` is therefore the one filter a command row
    // gets — NOT `activeRemainder`, which is `""` for any non-`?` prefix and
    // would list every command whatever the user typed.
    if (prefix === "/") {
      const rows: MentionRow[] = composerCommands
        .filter((c) => c.name.startsWith(query))
        .map((c) => ({
          // The `/` ON THE KEY keeps a command from colliding with a skill of
          // the same name (a `?` row does the same thing for the same reason).
          // `description` is required by `MentionRow`, and a command has one.
          key: `/${c.name}`,
          prefix: "/" as const,
          name: c.name,
          description: c.description,
        }));
      // Selection needs NO new code: `selectMention`'s final branch already
      // inserts `${row.prefix}${row.name.toLowerCase()} ` — `/compact ` — and
      // `setPicker(null)` ends the token, so the next Enter is a send. Pinned by
      // a test rather than implemented twice.
      return { rows, matched: rows.length, live: true };
    }
    const rows: MentionRow[] =
      prefix === "#"
        ? mcpCatalog.map((s) => ({
            key: s.name,
            prefix: "#",
            name: s.name,
            description: s.summary,
          }))
        : prefix === "@"
          ? agents.map((a) => ({
              key: a.name,
              prefix: "@",
              name: a.name,
              description: a.description,
            }))
          : skills.map((s) => ({
              key: s.name,
              prefix,
              name: s.name,
              description: s.description,
            }));
    const matchedRows = rows.filter((r) =>
      r.name.toLowerCase().includes(query.toLowerCase()),
    );
    // NO render cap here — deliberately, and NOT an oversight. The cap exists
    // for `?`'s unbounded SUBSEQUENCE filter over a whole-Space listing whose
    // rows are cheap to narrow by typing a couple more characters; the Mention
    // catalogs are name-SUBSTRING filters over the (small, user-owned) skills /
    // agents / MCP catalogs, and this branch keeps the shipped status quo
    // BYTE-IDENTICAL to before File completion. Capping it here would make
    // every row past the cap unreachable forever with no explanation — the cap
    // is a slice INSIDE this memo, so a sliced row is a row no keyboard user
    // can ever reach — a silent behavior change to a surface this feature
    // promised not to touch. It would also need its own note (the note below is
    // `?`-only), so the Mention side is UNCAPPED rather than silently capped; if
    // we ever want a cap there, it deserves its own change with its own note and
    // tests. What bounds the uncapped case is GEOMETRY, not a count: the picker
    // box clamps its own height (a font-size-relative `max-height`) and scrolls,
    // so a long list is a scrollbar instead of a column running off the top of
    // the window.
    return { rows: matchedRows, matched: matchedRows.length, live: true };
    // `files` is a DEP for the same reason `agents`/`mcpServers` are: a Space
    // switch (or a late first listing) must re-derive the rows LIVE, with no
    // extra keystroke. `completion` is a dep for the identical reason on the
    // other side of the branch: a directory listing that LANDS (the first fetch
    // for a directory, or the descent into the next one) has no further
    // keystroke to wait for, so without it the outside picker would look dead
    // rather than wrong — MUTATION-CHECKED, dropping it from these deps reddens
    // exactly the two tests that watch a descent come live on its own (the
    // DIRECTORY-row descent and the Windows drive-root one). And `label` is not
    // decoration: rendering `name` instead of `label ?? name` in
    // `ComposerMentions` reddens a large part of the ADR 0035 group, so "SHOW the
    // abbreviated form, INSERT the absolute one" is a tested contract on both
    // sides. NO COUNT IS WRITTEN HERE ON PURPOSE — it said seven, and the group
    // has grown since. `outside`/`segment` are NOT deps: they are pure functions
    // of `picker`, which is one.
  }, [skills, agents, mcpServers, files, completion, mcpMentionsEnabled, picker, draft]);
  const filtered = pickerRows.rows;
  // The picker's one explanation line (never a row — see `ComposerMentions`).
  // Only ever for `?`: the only catalog that is bounded twice over (the walk
  // cap, then the render cap) — the Mention branch is uncapped and note-free.
  // PRECEDENCE: "too many matches" SHADOWS "listing capped" when both hold
  // (both true: the walk hit its cap AND the query still matched more than we
  // render), because the render cap is what the user is hitting right now and
  // "keep typing" is actionable for it; the walk cap is invisible below it.
  // WHY THE TWO ARMS' ADVICE DIFFERS: the render cap trims ROWS but every
  // match is still IN the listing, so narrowing genuinely reveals it — hence
  // "keep typing". The walk cap trims the LISTING itself, and the walk is
  // DETERMINISTIC, so the surviving 5,000 entries are always the SAME set:
  // a truncated-away file is therefore unreachable no matter what you type
  // (and this arm renders ALONE only when the query already matched
  // ≤ MAX_PICKER_ROWS, i.e. when the list is already narrow). So it states
  // the LIMITATION instead of giving advice that cannot help. WHICH 5,000
  // survive is the walk's OWN order, NOT the alphabetically-first 5,000
  // paths: `sort_by_file_name` sorts per DIRECTORY during the depth-first
  // walk, so a nested `src/a.rs` precedes a root-level `t.txt`
  // (`src-tauri/src/commands/files.rs`, pinned there by
  // `collect_files_sorts_display_order_across_directories`). Global
  // alphabetical order is what a FLAT directory degenerates to, and nothing
  // more — the determinism is the property the reasoning above needs, the
  // shape of the order is not.
  const note =
    picker?.prefix === "?" && pickerRows.live
      ? pickerRows.matched > MAX_PICKER_ROWS
        ? `Too many matches — keep typing to narrow the list`
        : // The cap note reads the truncation of the listing that is ACTUALLY on
          // screen: the directory being completed when the token is outside, the
          // Space Listing otherwise. `files.truncated || completion.truncated`
          // would report the Space's cap while the user completes somewhere else
          // entirely — a true statement about a listing they are not looking at.
          // MUTATION-CHECKED: that `||` reddens "the cap note for an outside
          // completion reads the DIRECTORY's truncation, not the Space's".
          (outside ? completion.truncated : files.truncated)
          ? `Listing capped — some files may be missing`
          : undefined
      : undefined;
  // The highlighted row index, DERIVED (not clamped in place): the raw
  // `picker.index` can go stale (a Space switch refetches `skills` while the
  // picker is open with a non-zero `index`), and `filtered[staleIndex]` would
  // be `undefined` → a `selectMention(undefined)` crash on Enter (the rows are
  // `MentionRow`s). `Math.max(0, …)` is belt-and-braces: the KEYBOARD branch
  // that consumes this index is gated on `filtered.length > 0`, so
  // `filtered.length - 1` is ≥ 0 there (the picker's RENDER gate is wider —
  // `rows || note` — but a note-only picker has no row to highlight).
  const activeIndex = picker
    ? Math.min(picker.index, Math.max(0, filtered.length - 1))
    : 0;
  // The `archimedes:insert-skill` listener (Task 4's left-pane rows dispatch
  // it): insert `$name ` at the caret and re-focus. Read through refs (the
  // `draftRef` mirror already exists) so the effect runs once and always sees
  // the LIVE draft (a render closure would be stale for fast events).
  useEffect(() => {
    const onInsertSkill = (e: Event) => {
      // Close the mention picker: the insert comes from OUTSIDE the
      // picker (a SkillsDialog row — the v1.1 flow), so a picker open at
      // insert time is stale (it would linger rendered until the next
      // keydown, and a token active at the caret would be spliced INTO).
      // The dialog inserts a `$`-prefixed SKILL token, so the picker this
      // closes is the skills one (`$` is the skill prefix).
      setPicker(null);
      const text = (e as CustomEvent<string>).detail;
      if (typeof text !== "string") return;
      const el = composerRef.current;
      const draft = draftRef.current; // the LIVE value (the ref mirror above)
      if (!el) {
        setDraft(draft + text);
        return;
      }
      const start = el.selectionStart ?? draft.length;
      const end = el.selectionEnd ?? start;
      const next = draft.slice(0, start) + text + draft.slice(end);
      setDraft(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + text.length;
        el.setSelectionRange(pos, pos);
      });
    };
    window.addEventListener(IPC_EVENTS.insertSkill, onInsertSkill);
    return () =>
      window.removeEventListener(IPC_EVENTS.insertSkill, onInsertSkill);
    // The refs and the setter are stable, so this runs ONCE — which is the
    // whole point of reading `draftRef` instead of `draft`.
  }, []);

  // Select a row from the `$`/`#`/`@`/`?`-trigger picker: replace the active
  // token (the prefixed span at the caret — the shared `activeMentionToken`
  // helper) with `<prefix><name> ` (LOWER-cased — the Mention case policy: a
  // picker-selected mention ALWAYS expands on send, and the mention regex is
  // lowercase-only; the expansion keeps the catalog name verbatim in the
  // block's `name` attribute). The `requestAnimationFrame`
  // re-focus + caret-set is REQUIRED: `setDraft` re-renders the controlled
  // textarea, which would otherwise drop focus/caret.
  const selectMention = (row: MentionRow) => {
    if (!picker) return;
    const el = composerRef.current;
    const caret = el?.selectionStart ?? draft.length;
    const token = activeMentionToken(draft, caret);
    if (!token) return;
    // The insertion policy splits on the prefix (ADR 0033), and the `?` branch
    // splits once more on whether the row is a DIRECTORY (ADR 0035):
    //
    //  • a `?` FILE row inserts the PATH ALONE — the trigger is CONSUMED (the
    //    splice below already removed it) and the case is PRESERVED (`?REA` →
    //    `README.md`) because the insertion is VERBATIM: no lowercasing rule
    //    applies to a path, so the Mention lowercase-only rule does not apply.
    //    Out of the Space that verbatim path is ABSOLUTE, which is the whole
    //    point — nothing in this app expands a tilde, so the row shows `~/…` and
    //    inserts `/home/u/…` (the row's `name`, not its `label`).
    //  • a `?` DIRECTORY row is NOT an answer, so it keeps the `?` and appends
    //    `/` with NO trailing space. Consuming the sigil there would END the
    //    token and strand the user after one level of descent.
    //  • the three Mention prefixes are untouched: the lowercased token.
    const keepToken = row.prefix === "?" && row.isDir === true;
    const inserted = keepToken
      ? `?${row.name}/`
      : row.prefix === "?"
        ? `${row.name} `
        : `${row.prefix}${row.name.toLowerCase()} `;
    const next = draft.slice(0, token.start) + inserted + draft.slice(caret);
    setDraft(next);
    if (keepToken) {
      // Keep the picker LIVE on the directory just entered. The caret restore in
      // the `requestAnimationFrame` below cannot do this: the picker state is
      // only recomputed by the textarea's own `onChange`/`onKeyDown`, and a
      // programmatic caret set fires neither. So the SAME handler recomputes the
      // token at the NEW caret (`token.start + inserted.length`) — the caret's
      // final position — with the same helper `onChange` uses, so the two can
      // never disagree about what the token is. It runs against `next` (the
      // string just computed), NOT against state, which is why the ORDER of
      // `setDraft`/`setPicker` does not matter here: React 19 batches both into
      // ONE commit, and neither reads the other's value. It is also why no
      // `requestAnimationFrame`/flush is needed to see the reopened picker — the
      // rows for the new directory arrive on their own fetch, and the render gate
      // (`rows || note`) simply shows nothing until they do.
      const pos = token.start + inserted.length;
      const nextToken = activeMentionToken(next, pos);
      setPicker(
        nextToken
          ? { prefix: nextToken.prefix, query: nextToken.remainder, index: 0 }
          : null,
      );
    } else {
      setPicker(null);
    }
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      const pos = token.start + inserted.length;
      el.setSelectionRange(pos, pos);
    });
  };

  return { picker, setPicker, filtered, note, activeIndex, selectMention };
}
