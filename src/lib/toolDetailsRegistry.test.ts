import { describe, expect, it } from "vitest";
import { extractTargetInfo } from "./subagentActivity";
import { normalizeToolOutput } from "./toolOutput";

/**
 * THE `details` WIRE-VOCABULARY REGISTRY (finding 5, TS half).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PINS, AND WHY IT IS A REGISTRY AND NOT A PARITY TEST
 * ---------------------------------------------------------------------------
 *
 * The `details` value of a tool result is NOT an event name — it is a **value
 * vocabulary inside one frame** (the `tool_result` frame). `src/lib/ipc/events.ts`
 * (:21–31) states the rule for the OTHER half of the wire — a constant's VALUE is
 * the contract, so `events.test.ts` pins every event-name string byte-for-byte on
 * the TS side — and it explicitly refuses a Rust-parity GREP for event names,
 * because names flow dynamically through the sink and such a grep is incomplete by
 * construction. This file applies the endorsed half of that rule to `details`:
 * each side of the wire pins its OWN vocabulary with its OWN test, and the two
 * halves agree because they reproduce the SAME list, not because one greps the
 * other. The TS-side pin is this file. Its counterpart is task08's Rust producer
 * enumeration + the `tool_result_response_value` round-trip pin.
 *
 * The two vocabularies — what the Rust producers emit and what the TS readers
 * read — are TWO OVERLAPPING SETS, not one. So `assertEquals(readerSet,
 * producerSet)` would be wrong on the facts and this file does not assert it. It
 * asserts per-key OWNERSHIP with two annotated lists, and every disagreement
 * between them is a named, reasoned member of one of them.
 *
 * THE SPLIT RULE (the one sentence every annotation below is written against):
 *
 *   **legacy = a field the TS reader reads that NO current producer emits.**
 *
 * NOT "a name only TypeScript uses". `results`, `exitCode` and `status` are
 * emitted by live Rust producers AND read by TS; `error` is emitted AND read. A
 * naive "TS-only by name" flag would file all four under legacy, and a
 * producer-side deletion would then look safe. It is not. Any edit on either side
 * MOVES a key between the two annotated lists; it never silently adds one.
 *
 * ---------------------------------------------------------------------------
 * THE ONE AGREED PRODUCER LIST — FROZEN, NOT RE-DERIVED
 * ---------------------------------------------------------------------------
 *
 * `PRODUCER_KEYS` (Part 1) is the FROZEN copy of the 34-key producer union that
 * the plan re-derived from the tree ONCE
 * (`docs/roadmap/improvement-correctness-seams-task07b-details-registry.md`,
 * §"The frozen producer list", re-derived at HEAD `29b16df` by enumerating every
 * production `details: Some(json!({...}))` / `ToolResult::ok_text(.., Some(json!(..)))`
 * site). task08's planner copies THAT literal verbatim, so the two halves agree by
 * construction; drift between them is this guard's own first test subject. It is
 * deliberately NOT re-derived at implementation time — a NEW key appearing on
 * either side is a live wire change to be reported and moved between the two
 * annotated lists, never a silent edit of this constant.
 *
 * ---------------------------------------------------------------------------
 * VERIFICATION RECORD (the tree-first re-check this file owes its numbers)
 * ---------------------------------------------------------------------------
 *
 * The frozen 34-key list was re-checked against the tree at this task's HEAD
 * (`1483d94`, after task06's `db4f4ca` rewrite of `interactive/mod.rs`): every
 * production emission site was opened and its key set read, exactly as the plan's
 * census greps describe. THE DISTINCT KEY UNION IS THE FROZEN 34, BYTE-FOR-BYTE —
 * no key added, no key dropped — so the contract handed to task08 stands as is.
 *
 * ONE number in the plan's census TEXT has since drifted, and it is a SITE count,
 * not a key: the plan counts 39 emission sites (28 `details: Some` + 11
 * `ok_text(.., Some(..))`); the tree at this HEAD carries **38** (27 + 11). The
 * whole difference is `interactive/mod.rs`'s `sudo_exec` arms, which `db4f4ca`
 * collapsed from 8 to 7 (the `format!("timed out after …")` and
 * `format!("command failed with exit code {}")` error arms became ONE arm carrying
 * a classifier-supplied `error`), and changed the three pre-flight arms'
 * `exitCode: -1` to `exitCode: null`. Both are VALUE changes inside already-listed
 * keys: no key entered or left the vocabulary, so the frozen list is untouched and
 * nothing moved between the annotated lists. The Part-3 sudo fixtures follow the
 * CURRENT 7 arms, tree-first.
 *
 * Part 3 also corrected its own transcription against the tree: the plan's register
 * sketch writes the todo group as `{operation,todos{,error}}` and the web group as
 * `{responseId,url,title,wordCount,status,extractor,truncated,renderer?,rendererNote?}`
 * — the braces are the plan's shorthand for OPTIONAL, not wire keys. The fixtures
 * spell the real serialised shapes (`TodoItem` omits an absent `description`;
 * a web-search item omits `publishedDate`; an `ask` result omits `description` and
 * `custom`; `renderer`/`rendererNote` appear only when the renderer ran).
 *
 * ---------------------------------------------------------------------------
 * THE VACUITY GUARDS (the repo's census pattern — `childproc.rs:754`)
 * ---------------------------------------------------------------------------
 *
 * A registry test that passes because it found nothing is a FAILURE, not a pass.
 * `childproc.rs` names the disease: "the census is BLIND: it found {constructors}
 * … while scanning {files} … every invariant below would be vacuous". Four guards
 * run before and inside the vocabulary assertions, and each fails LOUDLY when its
 * input disappears:
 *
 *  1. the reader walk must FIND every named reader function BY NAME in its named
 *     file, and every one must CONTRIBUTE at least one field read — a reader whose
 *     accessor idioms drifted out of the matcher list reddens the walk instead of
 *     silently contributing zero keys;
 *  2. the collected key sets must be NON-EMPTY: the envelope-frame reader set, and
 *     `PRODUCER_KEYS`;
 *  3. `PRODUCER_KEYS`' `as const` TYPE must stay exactly the frozen 34-name tuple
 *     (`FROZEN_TUPLE_PIN`) — a dropped, added or reordered key, or a collapse to
 *     `string[]`, fails `pnpm build` (tsc typechecks test files) rather than
 *     shrinking the contract silently;
 *  4. every `PRODUCER_KEYS` key must appear in ≥1 Part-3 fixture group — the Part-1
 *     list and the Part-3 fixture table are two copies of ONE agreement and are
 *     cross-pinned, so a key added to one and not the other reddens.
 */

// Node's `fs` through a COMPUTED specifier — this app ships no `@types/node`, so
// a bare `import "node:fs"` does not typecheck. The idiom `tauriBoundary.test.ts`,
// `tauriBarrel.test.ts` and `themeTokens.test.ts` use.
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

/** Strip comments before scanning: a doc-comment that MENTIONS `details.error` is
 *  prose about the wire, not a read of it. `tauriBoundary.test.ts` records being
 *  bitten by exactly this — a comment naming a symbol reads as a consumer to a
 *  regex. */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — THE LIVE PRODUCER KEY UNION (the shared list task08 copies verbatim)
// ─────────────────────────────────────────────────────────────────────────────
//
// Task08 owns the Rust-side enumeration; this TS copy exists so that BOTH
// failure modes fail the same test: a producer key no reader ever reads (it must
// appear in Part 2c's annotated exception list with a reason) and a reader field
// no producer emits (it must appear in Part 2b's legacy envelope, likewise with a
// reason). Copy byte-for-byte.

// THE details wire vocabulary — producer side. 34 keys. Re-derived from
// the tree ONCE at plan time (vet round 2, HEAD 29b16df) by enumerating
// EVERY production `details: Some(json!({...}))` / `ok_text(.., Some(json!))`
// site (39 sites, 7 files — see the grep in §The frozen producer list);
// FROZEN here. task08 (Wave 3, Rust) owns the Rust-side enumeration and
// copies THIS literal verbatim. Any edit must move a key between Live and
// legacy-envelope, never silently add it.
const PRODUCER_KEYS = [
  "bytes", "cancelled", "command", "customInput", "description", "diff",
  "dir", "entries", "error", "exitCode", "extractor", "lines", "matches",
  "occurrences", "operation", "path", "provider", "reason", "renderer",
  "rendererNote", "responseId", "resultCount", "results", "scope", "skill",
  "skills", "status", "stderr", "stdout", "title", "todos", "truncated",
  "url", "wordCount",
] as const;

type ProducerKey = (typeof PRODUCER_KEYS)[number];

/** The compile-time half of vacuity guard 3. `PRODUCER_KEYS` is a 34-element
 *  `as const` tuple and must STAY one: this alias spells the frozen 34 names in
 *  the frozen order, and `FROZEN_TUPLE_PIN` is only assignable to `true` while the
 *  two types are mutually assignable. Drop a key, add a key, reorder, or widen the
 *  const to `string[]` and `pnpm build` fails HERE — the contract cannot shrink
 *  silently. (The 34 names are spelled a second time on purpose: this is the
 *  tamper seal on the copy above, not a second consumer of it.) */
type FrozenProducerTuple = readonly [
  "bytes", "cancelled", "command", "customInput", "description", "diff",
  "dir", "entries", "error", "exitCode", "extractor", "lines", "matches",
  "occurrences", "operation", "path", "provider", "reason", "renderer",
  "rendererNote", "responseId", "resultCount", "results", "scope", "skill",
  "skills", "status", "stderr", "stdout", "title", "todos", "truncated",
  "url", "wordCount",
];

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Typed `true` ONLY while `typeof PRODUCER_KEYS` is exactly the frozen tuple (see
 *  `FrozenProducerTuple`). Read at runtime by the vacuity guard so `pnpm test`
 *  exercises it too; the compiler already rejected this file if it is not `true`. */
const FROZEN_TUPLE_PIN: AssertEqual<typeof PRODUCER_KEYS, FrozenProducerTuple> = true;

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — THE READER SIDE, IN TWO ANNOTATED COLUMNS
// ─────────────────────────────────────────────────────────────────────────────
//
// THREE FRAMES are in play and the walk keeps them apart, because conflating them
// is how a registry starts lying:
//
//   • the TOOL-RESULT frame — `{content, details}` (`result.content`,
//     `result.details`). Not part of the `details` vocabulary; it is the frame
//     AROUND it. Kept in its own column so the 24-field union stays clean.
//   • the DETAILS frame — the envelope the producers emit, and one of its
//     per-subagent ENTRIES (`details.progress[i]`, `details.results[i]`). Reads
//     here are what the 24-field reader union enumerates.
//   • the RAW-INPUT frame — the tool call's own `rawInput` (`summarizeToolCall`).
//     Its field names (`command`, `path`, `url`, `operation`, …) collide with
//     producer keys while being a DIFFERENT frame, so they are never counted as
//     reads of `details`. That distinction is what makes the Part-2c set
//     difference honest: `details.command` is unread by TS even though
//     `rawInput.command` is read every time a bash card renders.
//
// The walk is deliberately small: it reads ONLY the files that own the named
// reader functions, and only the declaration region of each named function. It is
// not a whole-tree scanner and does not need to be — the plan NAMES the readers,
// so the census is "did we visit these eight functions and what did we collect",
// which is exactly the question the vacuity guard has to be able to answer.

const TOOL_OUTPUT = "src/lib/toolOutput.ts";
const SUBAGENT_ACTIVITY = "src/lib/subagentActivity.ts";
const CARD = "src/components/SubagentDelegatingCard.tsx";

/** One named reader: the file that owns it, and the accessor idioms to collect.
 *  `envelope` collects reads of the DETAILS frame / its entries — the columns the
 *  24-field union enumerates. `resultFrame` and `inputFrame` are the other two
 *  frames, collected so the "did this reader contribute anything at all" guard can
 *  be answered honestly for a reader that legitimately reads no `details` field. */
type ReaderSpec = {
  readonly name: string;
  readonly file: string;
  readonly why: string;
  readonly envelope: readonly string[];
  readonly resultFrame?: readonly string[];
  readonly inputFrame?: readonly string[];
  /** Helper-call patterns whose string argument IS a field read (a reader that
   *  hides its key behind `str("path")` or `asEntries("progress")` still reads it,
   *  and a walk that missed those would under-collect). */
  readonly envelopeHelpers?: readonly RegExp[];
  readonly inputHelpers?: readonly RegExp[];
};

const READERS: readonly ReaderSpec[] = [
  {
    name: "summarizeToolCall",
    file: TOOL_OUTPUT,
    why: "the header line — reads rawInput ONLY (never `details`)",
    envelope: [],
    inputFrame: ["(?<![\\w$.])input"],
    inputHelpers: [/str\(\s*"([A-Za-z_$][\w$]*)"\s*\)/g],
  },
  {
    name: "normalizeToolOutput",
    file: TOOL_OUTPUT,
    why: "the display text — reads the tool-result frame's `details` as ONE opaque value (a JSON dump, or the subagent summary) and never addresses a key inside it",
    envelope: [],
    resultFrame: ["(?<![\\w$.])result"],
  },
  {
    name: "failureText",
    file: TOOL_OUTPUT,
    why: "the failure tooltip — the one reader that names a `details` key: `error`",
    envelope: ["(?<![\\w$.])details", "\\(\\s*details\\b[^)]*\\)"],
    resultFrame: ["(?<![\\w$.])result"],
  },
  {
    name: "subagentActivityLine",
    file: TOOL_OUTPUT,
    why: "one subagent's activity line, from ONE envelope entry",
    envelope: ["(?<![\\w$.])e"],
  },
  {
    name: "summarizeSubagentDetails",
    file: TOOL_OUTPUT,
    why: "the envelope summary — picks `progress`/`results` and renders their entries (module-private on purpose: it is reached through normalizeToolOutput)",
    envelope: ["(?<![\\w$.])d", "(?<![\\w$.])e", "(?<![\\w$.])p"],
    envelopeHelpers: [/asEntries\(\s*"([A-Za-z_$][\w$]*)"\s*\)/g],
  },
  {
    name: "summarizeSubagentFor",
    file: TOOL_OUTPUT,
    why: "one subagent's block — filters the envelope entries by childSessionId / task",
    envelope: ["(?<![\\w$.])d", "(?<![\\w$.])x"],
    envelopeHelpers: [/pick\(\s*"([A-Za-z_$][\w$]*)"\s*\)/g],
  },
  {
    name: "extractTargetInfo",
    file: SUBAGENT_ACTIVITY,
    why: "the card's envelope hand-off — reads details.progress / details.results and their entries' task / childSessionId",
    envelope: ["(?<![\\w$.])details", "(?<![\\w$.])p", "(?<![\\w$.])r"],
    inputFrame: ["(?<![\\w$.])input", "(?<![\\w$.])obj"],
  },
  {
    name: "getActivityDisplay",
    file: SUBAGENT_ACTIVITY,
    why: "the card's third line — reads the envelope entries handed to it through the card's ActivityRow",
    envelope: ["(?<![\\w$.])p", "(?<![\\w$.])r"],
    resultFrame: ["(?<![\\w$.])row"],
  },
];

/** The card's own envelope reads. It is READ-ONLY evidence here (not a "reader
 *  function" the plan names), but it is the LIVE production consumer of the legacy
 *  envelope — the `usage` / `progressSummary` cost line — so a walk that ignored it
 *  would report those fields as unread and make a producer-side deletion look free.
 *  The region is the ONE row builder (`entryForTask` … `hasRunning`), the block the
 *  card's D3 rewrite collapsed two copies into. */
const CARD_EVIDENCE = {
  file: CARD,
  from: "const entryForTask",
  to: "const hasRunning =",
  prefixes: ["(?<![\\w$.])progress", "(?<![\\w$.])result", "(?<![\\w$.])p", "(?<![\\w$.])r"],
};

/** One declaration region: from the named declaration to the NEXT top-level one.
 *  Cheaper and steadier than brace-matching, and it cannot bleed into a sibling
 *  function — which matters, because a bleed would credit a reader with keys it
 *  never reads. */
function declarationRegion(source: string, name: string): string | undefined {
  const start = new RegExp("^(?:export )?(?:async )?function " + name + "\\(", "m").exec(
    source,
  );
  if (!start) return undefined;
  const rest = source.slice(start.index + start[0].length);
  const next = /\n(?:export )?(?:async )?(?:function|const|let|interface|type|class|enum) /.exec(
    rest,
  );
  return source.slice(
    start.index,
    start.index + start[0].length + (next ? next.index : rest.length),
  );
}

/** Collect the field names each accessor idiom reaches, dot AND bracket form. */
function collect(text: string, prefixes: readonly string[], helpers: readonly RegExp[] = []): Set<string> {
  const keys = new Set<string>();
  for (const prefix of prefixes) {
    const dotted = new RegExp(prefix + "\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)", "g");
    let m: RegExpExecArray | null;
    while ((m = dotted.exec(text))) keys.add(m[1]);
    const bracketed = new RegExp(prefix + "\\s*\\??\\[\\s*[\"']([A-Za-z_$][\\w$]*)[\"']\\s*\\]", "g");
    while ((m = bracketed.exec(text))) keys.add(m[1]);
  }
  for (const helper of helpers) {
    const rx = new RegExp(helper.source, helper.flags.includes("g") ? helper.flags : helper.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text))) keys.add(m[1]);
  }
  return keys;
}

type WalkRow = {
  readonly reader: string;
  readonly file: string;
  readonly envelope: string[];
  readonly resultFrame: string[];
  readonly inputFrame: string[];
};

/** The walk, run ONCE at module load so every `it` below reads the same
 *  measurement and a `pnpm test` of this file alone reruns the census. */
const walk: readonly WalkRow[] = READERS.map((reader) => {
  const source = stripJsComments(readFileSync(reader.file, "utf8"));
  const region = declarationRegion(source, reader.name);
  if (region === undefined) {
    // Throwing here is guard 1's BY-NAME half: a renamed or deleted reader cannot
    // quietly drop out of the census.
    throw new Error(
      `the reader walk is BLIND for ${reader.name}: no \`function ${reader.name}(\` declaration ` +
        `found in ${reader.file} — the census named it as a reader, so either it was renamed ` +
        `(update the name here AND the lists below) or the file moved`,
    );
  }
  return {
    reader: reader.name,
    file: reader.file,
    envelope: [...collect(region, reader.envelope, reader.envelopeHelpers)].sort(),
    resultFrame: [...collect(region, reader.resultFrame ?? [])].sort(),
    inputFrame: [...collect(region, reader.inputFrame ?? [], reader.inputHelpers ?? [])].sort(),
  };
});

const cardSource = stripJsComments(readFileSync(CARD_EVIDENCE.file, "utf8"));
const cardFrom = cardSource.indexOf(CARD_EVIDENCE.from);
const cardTo = cardSource.indexOf(CARD_EVIDENCE.to, cardFrom);
if (cardFrom < 0 || cardTo < 0) {
  throw new Error(
    `the card evidence region is BLIND: could not locate "${CARD_EVIDENCE.from}" .. "${CARD_EVIDENCE.to}" ` +
      `in ${CARD_EVIDENCE.file} — the row builder was renamed, so the legacy-envelope reads below are unverified`,
  );
}
const CARD_READS = new Set([...collect(cardSource.slice(cardFrom, cardTo), CARD_EVIDENCE.prefixes)].sort());

/** Everything the readers read off the DETAILS frame or its entries — the set the
 *  24-field union must account for. The card's reads are included: it is live
 *  production code, and excluding it would understate the reader side. */
const READER_ENVELOPE_KEYS = new Set<string>([
  ...walk.flatMap((row) => row.envelope),
  ...CARD_READS,
]);

/** Part 2a — the LIVE reader reads, as `reader → key` pairs the walk must find.
 *  Enumerated against the producer list rather than restated as prose: the
 *  assertion below fails if any of these stops being a real read, so the register
 *  cannot rot into a comment. */
const LIVE_READER_READS: readonly string[] = [
  // `error` — the one fully-live key: emitted by the web/todo/sudo error arms and
  // read by name on the TS side.
  "failureText → error",
  "subagentActivityLine → error",
  "getActivityDisplay → error",
  // `status` — emitted by fetch_content's details (web/tools.rs:322) AND carried
  // by the persisted envelope entries; read on the envelope frame.
  "subagentActivityLine → status",
  // `exitCode` — emitted by bash.rs:427 and the sudo arms; read off the final
  // `results` entry (the terminal-state rule).
  "subagentActivityLine → exitCode",
  "getActivityDisplay → exitCode",
  // `results` — emitted by web_search (web/tools.rs:183) and `ask`
  // (harness/ask.rs:336-340); on the envelope it is ALSO the subagent list, and
  // both meanings are read.
  "summarizeSubagentDetails → results",
  "summarizeSubagentFor → results",
  "extractTargetInfo → results",
];

/** Part 2b — the LEGACY ENVELOPE. Exactly the fields the TS reader reads that NO
 *  current producer emits (the split rule). Five keys, nothing else.
 *
 *  "Legacy" here means **wire-for-UI-but-read-with-no-current-producer** — it is
 *  NOT "dead code" and NOT "a name only TS uses". Every member below feeds live
 *  production rendering, and the persisted transcript rows still carry them, which
 *  is why they cannot simply be deleted: `SubagentDelegatingCard.test.tsx`
 *  (:219–229, 363–370, 387–394, 462–470, 500–508, 674–684, 703–712) still hands the
 *  card these envelopes by hand, and that is the persisted-row contract.
 *
 *  Nested reads count against the WHOLE key and never as new keys: `usage.input`,
 *  `usage.output`, `usage.cost` are `usage`; `progressSummary.tokens`,
 *  `progressSummary.durationMs`, `progressSummary.toolCount` are `progressSummary`
 *  (`SubagentDelegatingCard.tsx:285–288, 341, 350, 355`). */
const LEGACY_ENVELOPE_FIELDS: readonly { key: string; why: string }[] = [
  {
    key: "progress",
    why: "the live subagent progress envelope the older detail stream carried; read by the card's whole child-linking chain (agent/model/status/tokens/cost/percent/toolCount/durationMs), by extractTargetInfo, by summarizeSubagentDetails/For and by getActivityDisplay — no current Rust producer emits `progress`",
  },
  {
    key: "childSessionId",
    why: "the envelope's per-result link to the child session (RawResultItem.childSessionId); it is how the card resolves a row to a live Subagent entry (SubagentDelegatingCard.tsx:172,226,231) and how summarizeSubagentFor filters — the `subagent` tool emits no `details` at all, so no producer emits it",
  },
  {
    key: "finalOutput",
    why: "the terminal output line of the older per-result envelope (RawResultItem.finalOutput); read by subagentActivityLine's exitCode arm and by getActivityDisplay's result fallback — no producer emits it",
  },
  {
    key: "usage",
    why: "the older per-result cost shape {input, output, cost}; it is one arm of the card's token chain (SubagentDelegatingCard.tsx:285–286) and of its money chain (:341) — no producer emits `usage` (and the three members RawResultItem used to also declare, cacheRead/cacheWrite/turns, were read by nobody and are deleted)",
  },
  {
    key: "progressSummary",
    why: "the older per-result roll-up {tokens, durationMs, toolCount}; it is one arm of the card's token/toolCount/duration chains (:288, :350, :355) — no producer emits it",
  },
];

/** Part 2b — the ENVELOPE ENTRY fields: the keys read off a `progress` /
 *  `results` ENTRY, i.e. nested inside one of the two legacy containers. The plan's
 *  own rule files these under their container ("nested reads count against the
 *  WHOLE, never as new keys"), so they are NOT members of
 *  `LEGACY_ENVELOPE_FIELDS` — that list stays the 5 container-level keys. They
 *  still need a column of their own, because the third column is what makes the
 *  24-field union partition cleanly: without it, 15 real reads sit in neither
 *  annotated list and the "no unattached field" guard would have nothing to check
 *  them against.
 *
 *  `container` names which legacy envelope carries the entry the field is read
 *  from — the reason every one of these has no producer is the same reason its
 *  container has none: the `subagent` tool emits no `details` at all today. */
const ENVELOPE_ENTRY_FIELDS: readonly { key: string; container: string; why: string }[] = [
  { key: "agent", container: "progress + results", why: "the subagent's name — the card's agentCandidate chain (SubagentDelegatingCard.tsx:233–234) and summarizeSubagentDetails' block header" },
  { key: "task", container: "progress + results", why: "the join key of the whole card row derivation, and summarizeSubagentFor's fallback match when a live entry carries no childSessionId" },
  { key: "model", container: "progress + results", why: "the row's model line (SubagentDelegatingCard.tsx:248–249) and cleanModelName's input" },
  { key: "currentTool", container: "progress", why: "the live activity line (subagentActivityLine's running arm, getActivityDisplay's progress fallback)" },
  { key: "currentToolArgs", container: "progress", why: "the argument half of the live activity line" },
  { key: "currentToolStartedAt", container: "progress", why: "the live duration suffix of the activity line" },
  { key: "toolCalls", container: "progress", why: "the last-call glyph + preview line when no currentTool is set" },
  { key: "recentOutput", container: "progress", why: "the last streamed line — the 'what is it working on' line" },
  { key: "output", container: "progress", why: "the whole-stream fallback when recentOutput is empty" },
  { key: "tokens", container: "progress", why: "the first arm of the card's token chain (SubagentDelegatingCard.tsx:280)" },
  { key: "percent", container: "progress", why: "the first arm of the card's context-percentage chain (:308)" },
  { key: "contextPercent", container: "progress", why: "the second arm of the same chain (:309)" },
  { key: "cost", container: "progress", why: "the first arm of the card's money chain (:338) — the issue #107 precedence order" },
  { key: "durationMs", container: "progress", why: "the running row's duration when the store entry carries no startedAt (:354)" },
  { key: "toolCount", container: "progress", why: "the tool-count fallback when the transcript carries no tool-call rows (:349)" },
];

/** Part 2b — the 24-field reader union (the grounding report's §3c list). Every
 *  member is read by a named reader or by the card's live chain — the assertion
 *  below proves it mechanically instead of trusting the transcription.
 *
 *  NOT one flat "legacy" bucket: `error`, `status`, `exitCode` and `results` are
 *  LIVE producer keys the reader ALSO reads (the spanning keys), and the remaining
 *  20 are envelope-only. The dual annotation lives in Part 2c's set difference;
 *  nothing here carries a naive "TS-only" flag. */
const READER_UNION_FIELDS = [
  "error", "agent", "task", "status", "model", "currentTool", "currentToolArgs",
  "currentToolStartedAt", "toolCalls", "recentOutput", "output", "progress",
  "results", "childSessionId", "exitCode", "finalOutput", "usage",
  "progressSummary", "tokens", "percent", "contextPercent", "cost", "durationMs",
  "toolCount",
] as const;

/** Part 2c — the exception list: producer keys the TS side never addresses BY NAME
 *  on the details frame. Its CONTENTS are not hand-enumerated: the assertion
 *  computes `PRODUCER_KEYS` minus the live reader keys at runtime and demands this
 *  map's keys match it exactly, so this table can only ever be a transcription of
 *  the measurement, never an independent claim. What IS hand-written is the reason
 *  per key — and the reason is part of the assertion: an anonymous allowance is not
 *  enough to let a key through.
 *
 *  Every reason shares one true mechanism (and says which emitter owns the key):
 *  a non-`subagent` tool's `details` reaches the screen through
 *  `normalizeToolOutput`'s JSON dump, so the key is DISPLAYED as opaque text while
 *  no TS code ever names it. That is a real consumer — it is why "unread" is not
 *  "deletable" — and it is exactly the distinction the registry has to keep. */
/** The producer keys that are NOT spanning, computed by the TYPE system as the
 *  same set difference the runtime assertion computes: `Extract` is the type-level
 *  intersection of the two literal unions (the spanning keys) and `Exclude` removes
 *  them. So this alias is derived from the two lists, never hand-spelled, and it
 *  makes the exception table EXHAUSTIVE at compile time: add a producer key without
 *  writing its reason and `pnpm build` names the missing key; write a reason for a
 *  key that no longer exists and it names the extra one. The runtime assertion below
 *  remains the authority — this alias just means a missing reason cannot be
 *  postponed past the build. */
type UnreadProducerKey = Exclude<ProducerKey, Extract<ProducerKey, (typeof READER_UNION_FIELDS)[number]>>;

const UNREAD_BY_NAME_REASONS: Readonly<Record<UnreadProducerKey, string>> = {
  bytes: "write (fs_tools.rs:121) — shown only inside normalizeToolOutput's JSON dump; the header reads rawInput.path, not details.bytes",
  cancelled: "bash (bash.rs:427) — the cancelled fact is carried to the UI by the tool-call status, not by a details read",
  command: "bash/sudo (bash.rs, interactive/mod.rs sudo arms) — the header's `command` comes from RAW INPUT (summarizeToolCall), a different frame; details.command is dumped, never named",
  customInput: "ask (harness/ask.rs:336-340) — always serialised null; the answer card reads the ask REQUEST payload, not the result details",
  description: "ask (harness/ask.rs:336-340) — always serialised null; same reason as customInput",
  diff: "edit (fs_tools.rs:183) — the diff card renders the `diff` Message kind, not the tool result's details",
  dir: "read_skill (skills.rs:162) — the skill's directory is display-only; the boundary is enforced Rust-side",
  entries: "ls (fs_tools.rs:294) — a count; the listing itself is the content text",
  extractor: "fetch_content (web/tools.rs:304-311) — provenance, dumped with the rest of the envelope",
  lines: "read (fs_tools.rs:49,67) — the line range the header shows comes from RAW INPUT offset/limit (readLineRange), not from details.lines",
  matches: "find/grep (search.rs:130,182,403) and get_search_content (web/tools.rs:408,421) — the matches are the content text; the count is dumped",
  occurrences: "edit (fs_tools.rs:183) — dumped; the editChangeStat chip is computed from RAW INPUT edits",
  operation: "manage_todo_list (interactive/mod.rs:227,243,310,349) — the header's `operation` comes from RAW INPUT; the TodoBoard reads the separate todos_update push",
  path: "read/write/edit/ls/read_skill (fs_tools.rs, skills.rs:196) — the header's `path` comes from RAW INPUT (summarizeToolCall/fileSummaries); details.path is dumped",
  provider: "web_search (web/tools.rs:183) — provenance, dumped",
  reason: "sudo_exec (interactive/mod.rs sudo arms) — the modal already showed the reason at prompt time; the result's copy is dumped. NOTE the name collision: summarizeToolCall's `reason` reads the COMPACTION card's rawInput, a different frame",
  renderer: "fetch_content (web/tools.rs:315, optional) — dumped",
  rendererNote: "fetch_content (web/tools.rs:318, optional) — dumped",
  responseId: "web_search/fetch_content/get_search_content (web/tools.rs) — the handle the model passes BACK as an argument; the header reads it from RAW INPUT (response_id/responseId), never from details",
  resultCount: "web_search (web/tools.rs:183) — a count; the results are the content text",
  scope: "read_skill (skills.rs:162) — provenance, dumped",
  skill: "read_skill (skills.rs:162,196) — the header's skill name comes from RAW INPUT `name`",
  skills: "list_skills (skills.rs:54,65) — a count; the catalog is the content text",
  stderr: "sudo_exec (interactive/mod.rs sudo arms) — the failure text comes from details.error (failureText) or the content text, never from details.stderr",
  stdout: "sudo_exec (interactive/mod.rs sudo arms) — success puts the scrubbed stdout in content[0].text; the details copy is dumped",
  title: "fetch_content (web/tools.rs:304-311) — dumped (and NOT the tool-call `title`, which is the tool name: a different frame and a different meaning)",
  todos: "manage_todo_list (interactive/mod.rs:227,243,310,349) — the board renders the todos_update push (TodoBoardPanel reads useInteractive.todos), not this copy",
  truncated: "bash/find/grep/fetch_content (bash.rs:427, search.rs, web/tools.rs) — the truncation note is appended to the CONTENT text; the flag is dumped",
  url: "fetch_content (web/tools.rs:304-311) — the header's url comes from RAW INPUT; details.url is dumped",
  wordCount: "fetch_content (web/tools.rs:304-311) — dumped",
};

/** The spanning keys — LIVE producer keys the TS reader ALSO reads. Derived, not
 *  declared: the assertion below recomputes it so the annotation cannot drift from
 *  the measurement it claims to summarise.
 *
 *  The two `as const` tuples have DISJOINT literal element types (a producer key is
 *  not a reader field name by construction), so TS refuses a direct
 *  `tupleA.includes(tupleBElement)` — the membership test is widened to
 *  `readonly string[]` on purpose: the assertion that follows is what pins the
 *  result, not the element type. */
const asStringKeys = (values: readonly string[]): readonly string[] => values;
const SPANNING_KEYS = PRODUCER_KEYS.filter(
  (k) => asStringKeys(READER_UNION_FIELDS).includes(k),
).sort();

/** Look a reason up by an arbitrary string (the runtime assertion walks
 *  `Object.keys`, whose element type is `string`, while the table's key type is the
 *  derived `UnreadProducerKey`). `undefined` for a key the table does not carry,
 *  which the assertion reads as "no reason written" — the failure the test wants. */
const reasonFor = (key: string): string | undefined =>
  (UNREAD_BY_NAME_REASONS as Readonly<Record<string, string>>)[key];

describe("Part 1 — the frozen producer list (the contract task08 copies)", () => {
  it("PRODUCER_KEYS is non-empty and duplicate-free (vacuity guard 2)", () => {
    expect(PRODUCER_KEYS.length).toBeGreaterThan(0);
    expect(new Set(PRODUCER_KEYS).size).toBe(PRODUCER_KEYS.length);
  });

  it("PRODUCER_KEYS' as-const TYPE is exactly the frozen 34-name tuple (vacuity guard 3)", () => {
    // `FROZEN_TUPLE_PIN` is typed `true` only while the const's type matches the
    // frozen tuple — a deleted/added/reordered key or a collapse to `string[]`
    // fails `pnpm build` before this line ever runs. The runtime reads below pin the
    // LENGTH, so a list that shrank to something the tuple alias does not describe
    // cannot pass by being merely non-empty.
    expect(FROZEN_TUPLE_PIN).toBe(true);
    expect(PRODUCER_KEYS.length).toBe(34);
    expect([...PRODUCER_KEYS].sort()).toEqual([...PRODUCER_KEYS]);
  });
});

describe("Part 2 — the reader side, in two annotated columns", () => {
  it("the reader walk is NOT BLIND: it visited every named reader by name and every one contributed a read (vacuity guard 1)", () => {
    // The census pattern's own failure wording (`childproc.rs:754`): a walk that
    // found nothing would make EVERY assertion below vacuous, so this runs first
    // and says which reader went blind.
    expect(walk.length).toBe(READERS.length);
    const blind = walk
      .filter(
        (row) => row.envelope.length === 0 && row.resultFrame.length === 0 && row.inputFrame.length === 0,
      )
      .map((row) => `${row.reader} (${row.file})`);
    expect(blind).toEqual([]);
    expect(READER_ENVELOPE_KEYS.size).toBeGreaterThan(0);
    // The named readers are the plan's list, and the deleted one-line-activity
    // helper is NOT among them — it was removed as a third copy of a covered
    // behaviour, so the registry must not keep crediting it with reads.
    expect(walk.map((row) => row.reader)).toEqual([
      "summarizeToolCall",
      "normalizeToolOutput",
      "failureText",
      "subagentActivityLine",
      "summarizeSubagentDetails",
      "summarizeSubagentFor",
      "extractTargetInfo",
      "getActivityDisplay",
    ]);
  });

  it("every TS details-field read is a member of the one agreed reader union (live + legacy-envelope)", () => {
    // The direction that matters: a NEW `details.foo` read reddens this test before
    // CI sees it, and the fix is to add `foo` to the union WITH its column — never
    // to loosen this assertion.
    const undeclared = [...READER_ENVELOPE_KEYS]
      .filter((k) => !(READER_UNION_FIELDS as readonly string[]).includes(k))
      .sort();
    expect(undeclared).toEqual([]);
  });

  it("every field of the 24-field union is actually read (the union has no invented member)", () => {
    const unread = READER_UNION_FIELDS.filter(
      (k) => !READER_ENVELOPE_KEYS.has(k) && !CARD_READS.has(k),
    );
    expect(unread).toEqual([]);
    expect(READER_UNION_FIELDS.length).toBe(24);
    expect(new Set(READER_UNION_FIELDS).size).toBe(24);
  });

  it("Part 2a: every enumerated LIVE reader read is still a real read", () => {
    const found = new Set(
      walk.flatMap((row) => row.envelope.map((k) => `${row.reader} → ${k}`)),
    );
    // The card's reads count too (it is a live reader of `error`/`exitCode`/`status`
    // /`results`), so the pair set is the walk PLUS the card's key names.
    for (const key of CARD_READS) found.add(`SubagentDelegatingCard → ${key}`);
    const missing = LIVE_READER_READS.filter((pair) => !found.has(pair));
    expect(missing).toEqual([]);
    expect(LIVE_READER_READS.length).toBeGreaterThan(0);
  });

  it("Part 2b: the legacy envelope is EXACTLY the reader fields no current producer emits", () => {
    const legacyKeys = LEGACY_ENVELOPE_FIELDS.map((f) => f.key);
    expect(new Set(legacyKeys).size).toBe(legacyKeys.length);

    // (a) no legacy member is a producer key — the split rule, in one line;
    const emitted = legacyKeys.filter((k) => (PRODUCER_KEYS as readonly string[]).includes(k));
    expect(emitted).toEqual([]);
    // (b) every legacy member IS read (otherwise it is not a reader field and does
    //     not belong in this list at all);
    const unread = legacyKeys.filter((k) => !READER_ENVELOPE_KEYS.has(k));
    expect(unread).toEqual([]);
    // (c) the list is COMPLETE, in three columns: every envelope key the walk found
    //     is either a LIVE producer key (Part 2c's spanning set), one of the 5
    //     container-level legacy members, or an entry field nested inside one of
    //     those containers. This is the direction that catches a new envelope read
    //     sneaking in unlabelled.
    const entryKeys = ENVELOPE_ENTRY_FIELDS.map((f) => f.key);
    const unannotated = [...READER_ENVELOPE_KEYS]
      .filter(
        (k) =>
          !(PRODUCER_KEYS as readonly string[]).includes(k) &&
          !(legacyKeys as readonly string[]).includes(k) &&
          !(entryKeys as readonly string[]).includes(k),
      )
      .sort();
    expect(unannotated).toEqual([]);
    // (d) every member carries its reason — the reason is part of the list, not a
    //     comment beside an anonymous allowance.
    const reasonless = LEGACY_ENVELOPE_FIELDS.filter((f) => f.why.trim().length < 20).map((f) => f.key);
    expect(reasonless).toEqual([]);
    const entryReasonless = ENVELOPE_ENTRY_FIELDS.filter(
      (f) => f.why.trim().length < 20 || f.container.trim() === "",
    ).map((f) => f.key);
    expect(entryReasonless).toEqual([]);
  });

  it("the three reader columns partition the 24-field union EXACTLY (no key in two columns, none in none)", () => {
    // The registry's shape, stated as a fact: a reader field is either a LIVE
    // producer key the reader also reads (spanning), a container-level legacy
    // envelope field, or a field nested inside one of those containers. Three
    // columns, disjoint, and their union is the whole 24 — which is what makes the
    // lists auditable instead of three overlapping prose lists.
    const legacyKeys = LEGACY_ENVELOPE_FIELDS.map((f) => f.key);
    const entryKeys = ENVELOPE_ENTRY_FIELDS.map((f) => f.key);
    const columns = [...SPANNING_KEYS, ...legacyKeys, ...entryKeys];

    // Disjoint: no key appears in two columns.
    expect(new Set(columns).size).toBe(columns.length);
    // Complete: the columns are exactly the declared union.
    expect([...columns].sort()).toEqual([...READER_UNION_FIELDS].sort());

    // An entry field's container must be one of the two envelope ARRAYS. `progress`
    // is a legacy container (no producer emits it at all); `results` is the
    // SPANNING one — web_search (web/tools.rs:183) and ask (harness/ask.rs:336-340)
    // do emit a `results` array, but of THEIR OWN payload, never a list of subagent
    // entries — so an entry read from `results` has no producer for the same
    // inherited reason. The container column is what stops a per-entry field being
    // argued away as "unread" when only its container is emitted elsewhere.
    const containers = ["progress", "results"];
    const badContainer = ENVELOPE_ENTRY_FIELDS.filter(
      (f) => !f.container.split(" + ").every((c) => containers.includes(c)),
    ).map((f) => f.key);
    expect(badContainer).toEqual([]);
  });

  it("Part 2c: every producer key is either a live reader field or an explicitly-annotated wire-for-UI key", () => {
    // The exception list's CONTENTS are computed, never hand-enumerated: whatever
    // this set difference yields IS the list, and the hand-written part is the
    // per-key reason. A producer key that gains a reader drops out of the
    // difference and then fails the "every key has a reason" check below until the
    // table is updated — the table cannot quietly outlive its subject.
    const liveReaderKeys = new Set<string>(LIVE_READER_READS.map((p) => p.split(" → ")[1]));
    const exceptions = PRODUCER_KEYS.filter((k) => !liveReaderKeys.has(k)).sort();

    const annotated = Object.keys(UNREAD_BY_NAME_REASONS).sort();
    expect(exceptions).toEqual(annotated);

    // The four spanning keys (`error`, `exitCode`, `results`, `status`) are live
    // producer keys the reader ALSO reads, so they must NOT be in the exception
    // list — that is the whole difference between this table and a naive
    // "TS-only-by-name" bucket.
    expect(SPANNING_KEYS).toEqual(["error", "exitCode", "results", "status"]);
    for (const key of SPANNING_KEYS) expect(annotated).not.toContain(key);

    const reasonless = annotated.filter((k) => (reasonFor(k) ?? "").trim().length < 20);
    expect(reasonless).toEqual([]);

    // The exception set and the legacy envelope are DISJOINT by construction (one
    // is producer-side-unread, the other reader-side-unproduced) and together they
    // account for every disagreement between the two vocabularies.
    const legacyKeys = LEGACY_ENVELOPE_FIELDS.map((f) => f.key);
    expect(annotated.filter((k) => legacyKeys.includes(k))).toEqual([]);

    // The cross-half agreement holds BY CONSTRUCTION of the two lists: they are the
    // deliverable, and every file load reruns these assertions, so an edit to
    // either half drifts the registry here — before CI, before review, before the
    // wire can carry the change.
  });

  it("the reader walk reports its readings (the census is auditable, not just non-empty)", () => {
    // Not an equality assertion — a PRINTED measurement, so a future reader can see
    // what the guard actually collected instead of trusting that it collected
    // something. Kept as a test so `pnpm test` prints it on every run.
    const report = walk.map(
      (row) => `${row.reader}: [${row.envelope.join(", ")}]`,
    );
    console.info("[toolDetailsRegistry] details-frame reads:\n  " + report.join("\n  "));
    console.info("[toolDetailsRegistry] card envelope reads: [" + [...CARD_READS].sort().join(", ") + "]");
    expect(report.length).toBe(READERS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — THE SHAPE FIXTURES (this task's TS-side half of the round-trip pin)
// ─────────────────────────────────────────────────────────────────────────────
//
// Task08 owns the exact Rust round-trip (`tool_result_response_value`, the one
// production Rust reader). This table is the TS-side shape register: ONE fixture
// per shape group in the plan's producer register, each written tree-FIRST against
// what the current emitters build, each asserting it survives the reader treatment
// the real readers give it — `normalizeToolOutput`'s `details` dump and
// `extractTargetInfo`'s `Record<string, unknown>` hand-off — UNCHANGED. A key a
// reader coerced, renamed or dropped fails here, at the same seam the Part-1 list
// and the Part-2c exception table are read from.
//
// The `payload` values are the shapes the Rust side actually serialises (read off
// the tree at this HEAD, not invented): a `TodoItem` is `{content, status}` with
// `description` OMITTED when absent (`todo.rs:38-43`, `skip_serializing_if`), a
// web-search item is `{title, url, snippet}` with `publishedDate` omitted
// (`web/providers/types.rs:8-14`), an `ask` result is `{id, question, options,
// multi, selected}` with `description`/`custom` omitted (`harness/ask.rs:244-254`),
// and `SkillScope` serialises lowercase (`skills.rs:82-96`).

type DetailsFixture = {
  /** The shape group's name, quoted in the assertion messages. */
  readonly group: string;
  /** The Rust emitter(s) this group stands for — the anchor for the shape. */
  readonly emittedBy: readonly string[];
  /** The exact key set the register lists for those sites (checked, not prose). */
  readonly registerKeys: readonly string[];
  readonly payload: Record<string, unknown>;
};

const DETAILS_FIXTURES: readonly DetailsFixture[] = [
  {
    // The single-key failure envelope. Every error arm in the register emits
    // exactly this shape and nothing else.
    group: "{error} — the failure envelope",
    emittedBy: [
      "web/tools.rs:94,194,209,232,257,328,347 (the seven web error arms)",
      "interactive/mod.rs:243,310 (the todo write error arms, alongside operation/todos)",
    ],
    registerKeys: ["error"],
    payload: { error: "web_search: the search provider returned no results" },
  },
  {
    group: "{operation, todos} — manage_todo_list read",
    emittedBy: ["interactive/mod.rs:227"],
    registerKeys: ["operation", "todos"],
    payload: {
      operation: "read",
      todos: [{ content: "Pin the details vocabulary", status: "pending" }],
    },
  },
  {
    group: "{operation, todos, error} — manage_todo_list write rejection",
    emittedBy: ["interactive/mod.rs:243 (todoList required), interactive/mod.rs:310 (validate errors)"],
    registerKeys: ["operation", "todos", "error"],
    payload: {
      operation: "write",
      todos: [{ content: "Pin the details vocabulary", status: "pending" }],
      error: "Item 1: status must be one of pending, in_progress, completed",
    },
  },
  {
    group: "{operation, todos} — manage_todo_list write accepted (the stored list)",
    emittedBy: ["interactive/mod.rs:349"],
    registerKeys: ["operation", "todos"],
    payload: {
      operation: "write",
      todos: [
        { content: "Pin the details vocabulary", status: "in_progress" },
        { content: "Delete the dead fields", status: "pending", description: "RawResultItem.usage" },
      ],
    },
  },
  {
    group: "{command, reason, exitCode, stdout, stderr, error} — sudo_exec error arm",
    emittedBy: [
      "interactive/mod.rs:400,466,539 (pre-flight: exitCode null, empty stdout/stderr)",
      "interactive/mod.rs:600,619,647 (post-run: the observed exitCode + a classifier note)",
    ],
    registerKeys: ["command", "reason", "exitCode", "stdout", "stderr", "error"],
    payload: {
      command: "apt update",
      reason: "the package index has to be refreshed before the install",
      exitCode: null,
      stdout: "",
      stderr: "",
      error: "command not confirmed",
    },
  },
  {
    group: "{command, reason, exitCode, stdout, stderr} — sudo_exec success arm (no error key at all)",
    emittedBy: ["interactive/mod.rs:674"],
    registerKeys: ["command", "reason", "exitCode", "stdout", "stderr"],
    payload: {
      command: "apt update",
      reason: "the package index has to be refreshed before the install",
      exitCode: 0,
      stdout: "Reading package lists...\n",
      stderr: "",
    },
  },
  {
    group: "{exitCode, truncated, cancelled} — bash",
    emittedBy: ["exec/bash.rs:427"],
    registerKeys: ["exitCode", "truncated", "cancelled"],
    payload: { exitCode: 0, truncated: false, cancelled: false },
  },
  {
    group: "{path, lines} — read (the binary image read at lines 0, the text read at lines N)",
    emittedBy: ["exec/fs_tools.rs:49 (binary), exec/fs_tools.rs:67 (text)"],
    registerKeys: ["path", "lines"],
    payload: { path: "src/lib/toolOutput.ts", lines: 723 },
  },
  {
    group: "{path, bytes} — write",
    emittedBy: ["exec/fs_tools.rs:121"],
    registerKeys: ["path", "bytes"],
    payload: { path: "notes/registry.md", bytes: 2048 },
  },
  {
    group: "{path, occurrences, diff} — edit",
    emittedBy: ["exec/fs_tools.rs:183"],
    registerKeys: ["path", "occurrences", "diff"],
    payload: {
      path: "notes/registry.md",
      occurrences: 1,
      diff: "--- a/notes/registry.md\n+++ b/notes/registry.md\n@@ -1 +1 @@\n-old\n+new\n",
    },
  },
  {
    group: "{entries} — ls (a COUNT, not the listing)",
    emittedBy: ["exec/fs_tools.rs:294"],
    registerKeys: ["entries"],
    payload: { entries: 12 },
  },
  {
    group: "{matches, truncated} — find / grep",
    emittedBy: ["exec/search.rs:130,182 (find), exec/search.rs:403 (grep)"],
    registerKeys: ["matches", "truncated"],
    payload: { matches: 3, truncated: true },
  },
  {
    group: "{skills} — list_skills (a COUNT)",
    emittedBy: ["exec/skills.rs:54 (the empty catalog), exec/skills.rs:65"],
    registerKeys: ["skills"],
    payload: { skills: 7 },
  },
  {
    group: "{skill, scope, dir} — read_skill of a skill's own SKILL.md body",
    emittedBy: ["exec/skills.rs:162"],
    registerKeys: ["skill", "scope", "dir"],
    payload: { skill: "test-driven-development", scope: "user", dir: "/home/dev/.agents/skills/tdd" },
  },
  {
    group: "{skill, path} — read_skill of a file bundled with a skill",
    emittedBy: ["exec/skills.rs:196"],
    registerKeys: ["skill", "path"],
    payload: { skill: "test-driven-development", path: "references/red-green.md" },
  },
  {
    group: "{responseId, provider, resultCount, results} — web_search",
    emittedBy: ["web/tools.rs:183"],
    registerKeys: ["responseId", "provider", "resultCount", "results"],
    payload: {
      responseId: "resp_01",
      provider: "duckduckgo",
      resultCount: 1,
      results: [
        {
          title: "Type registries",
          url: "https://example.dev/registry",
          snippet: "A registry is a list you can diff.",
        },
      ],
    },
  },
  {
    group: "{responseId, url, title, wordCount, status, extractor, truncated} — fetch_content (renderer/rendererNote are OPTIONAL keys, inserted only when a renderer ran)",
    emittedBy: ["web/tools.rs:304-312 (the base object)"],
    registerKeys: ["responseId", "url", "title", "wordCount", "status", "extractor", "truncated"],
    payload: {
      responseId: "resp_02",
      url: "https://example.dev/registry",
      title: "Type registries",
      wordCount: 812,
      status: 200,
      extractor: "readability",
      truncated: false,
    },
  },
  {
    group: "{responseId, …, renderer, rendererNote} — fetch_content through the fallback renderer",
    emittedBy: ["web/tools.rs:314-319 (the two conditional inserts)"],
    registerKeys: [
      "responseId", "url", "title", "wordCount", "status", "extractor", "truncated",
      "renderer", "rendererNote",
    ],
    payload: {
      responseId: "resp_03",
      url: "https://example.dev/sheet",
      title: "A rendered table",
      wordCount: 96,
      status: 200,
      extractor: "raw",
      truncated: true,
      renderer: "browser",
      rendererNote: "the readability pass found no article body",
    },
  },
  {
    group: "{responseId, matches} — get_search_content with matches (the no-match arm sends matches: [])",
    emittedBy: ["web/tools.rs:408 (matches: []), web/tools.rs:421 (matches: [...])"],
    registerKeys: ["responseId", "matches"],
    payload: {
      responseId: "resp_02",
      matches: ["12:the registry is a list you can diff"],
    },
  },
  {
    group: "{responseId} — get_search_content's plain content slice",
    emittedBy: ["web/tools.rs:449"],
    registerKeys: ["responseId"],
    payload: { responseId: "resp_02" },
  },
  {
    group: "{results, customInput, description} — ask (the two keys the pre-plan list MISSED, and the spanning `results` key)",
    emittedBy: ["harness/ask.rs:336-340 → :346, :354"],
    registerKeys: ["results", "customInput", "description"],
    payload: {
      results: [
        {
          id: "q1",
          question: "Which list does task08 copy?",
          options: ["The frozen 34", "A re-derivation"],
          multi: false,
          selected: ["The frozen 34"],
        },
      ],
      customInput: null,
      description: null,
    },
  },
];

/** The keys one fixture carries, as the strings the coverage guard reads. */
const fixtureKeys = (fixture: DetailsFixture): string[] => Object.keys(fixture.payload);

describe("Part 3 — the details shape fixtures round-trip unchanged through the TS readers", () => {
  it.each(DETAILS_FIXTURES.map((f) => [f.group, f] as const))(
    "%s survives the Record<string, unknown> reader treatment unchanged",
    (_group, fixture) => {
      // Guard FIRST: a fixture is only evidence if it carries the keys its own
      // register row claims, and if the readers really accept it.
      expect(fixtureKeys(fixture).slice().sort()).toEqual(
        [...fixture.registerKeys].sort(),
      );
      expect(Object.keys(fixture.payload).length).toBeGreaterThan(0);

      // The JSON leg — the wire itself. `tool_result_response_value` (task08's pin)
      // serialises `details` verbatim, and the TS display path is `JSON.stringify`,
      // so a key the JS side cannot represent (a `Date`, a `Map`, an `undefined`
      // that would coerce away) shows up HERE.
      expect(JSON.parse(JSON.stringify(fixture.payload))).toEqual(fixture.payload);

      // The `extractTargetInfo` leg — the card's `details` hand-off. The card takes
      // `details` as a `Record<string, unknown>` and passes it to the row builder
      // untouched; the reader must neither lose a key nor invent one.
      expect(extractTargetInfo(undefined, { details: fixture.payload }).details).toEqual(
        fixture.payload,
      );

      // The `normalizeToolOutput` leg — the display dump for a result whose text
      // items are empty (the arm that actually consults `details`).
      expect(normalizeToolOutput({ content: [], details: fixture.payload })).toBe(
        JSON.stringify(fixture.payload),
      );
    },
  );

  it("no fixture carries a key outside the frozen producer list (the fixture→list direction of the cross-pin)", () => {
    const outside = DETAILS_FIXTURES.flatMap((f) =>
      fixtureKeys(f)
        .filter((k) => !(PRODUCER_KEYS as readonly string[]).includes(k))
        .map((k) => `${f.group} → ${k}`),
    );
    expect(outside).toEqual([]);
  });

  it("every PRODUCER_KEYS key appears in ≥1 Part-3 fixture group (vacuity guard 4: the list and the fixtures are one agreement)", () => {
    // The mirror of the check above, and the fixture-side answer to the vet's
    // vacuity concern: the Part-1 list and the Part-3 table are two copies of the
    // same agreement. A producer key added to the list without a fixture — or a
    // fixture group that dropped a key — reddens HERE.
    const covered = new Set(DETAILS_FIXTURES.flatMap(fixtureKeys));
    const uncovered = PRODUCER_KEYS.filter((k) => !covered.has(k));
    expect(uncovered).toEqual([]);
    expect(covered.size).toBeGreaterThan(0);
    // And the coverage is not one mega-fixture: one group per shape in the plan's
    // register, so a shape (not just a key) that disappears is noticed.
    expect(DETAILS_FIXTURES.length).toBeGreaterThan(10);
  });
});
