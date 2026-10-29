---
status: live
last-verified: 2026-10-29
verified-by: re-read against THIS tree on `feature/backlog-79-122-124-28` (HEAD `c43b752`), every
  gap below re-confirmed still open by reading the code that would have to change — not copied from
  the plan or the run's status file. **Symbols actually read for #122:** `EMPTY_CONTENT_SANITISE_PLACEHOLDER`,
  `content_is_the_sanitise_placeholder`, `content_is_effectively_empty` and the outbound guard inside
  `request_body` (`agent/harness/provider/openai.rs`, incl. `handle_chunk`'s prefix-hold accumulator
  and `flush_stream_text`); the `consume_stream` bolt (`agent/harness/loop/turn.rs`) and
  `handle_empty_turn`; `clamp_placeholder_row` + `route_outbound`'s `TranscriptInsert` and
  `TranscriptReplace` arms (`agent/worker/client.rs`); `IpcStore::replace_messages`
  (`agent/worker/store.rs`) and its caller `Store::replace_messages` → `compact.rs`; the two subagent
  guards (`worker/manager/subagent_flow.rs`'s settle guard, `worker/core.rs`'s `Inbound::SubagentResult`
  arm); `load_transcript` (`agent/harness/loop.rs`) and the `native_messages` migration list
  (`storage/db.rs`); and every test in `src-tauri/tests/provider.rs`, the body readers in
  `src-tauri/tests/worker_e2e.rs` and
  `agent/harness/loop/tests/provider_switch.rs`, and the `anthropic_request_body` /
  `responses_request_body` pin sets. **Symbols read for #124:** `UnsupportedReason` and its two doc
  comments, the `ToolKey` `match` that produces it (`agent/definition_permission.rs`),
  `definition_verdict` / `rule_or_guard_verdict` / `is_guard_path` (`agent/harness/loop/gate.rs`),
  `FsBackend::validate` / `resolve` / `check_under_roots` and `canonicalize_lenient`
  (`agent/fs_backend.rs`), `AgentUnsupportedReason` + the `note()` fixture helper
  (`src/lib/tauri/types.ts`, `src/components/AgentsDialog.test.tsx`), the barrel pin in
  `src/lib/tauriBarrel.test.ts`, the DTO-shape pin in `src/lib/tauri.test.ts`, and ADR 0084 with its
  2026-10-29 amendment. **Measured, not assumed:** `grep` for `clamp_empty_text_with_tool_calls` in
  `src/` and `src-tauri/` → **0 hits** (it exists only in the deleted plan); `grep` for a `content_json`
  rewrite in `storage/db.rs` → **0 hits**; `grep` for `root set` in ADR 0084 → **0 hits** (see the
  root-set bullet, where that correction matters); `grep` for any TS test reading
  `definition_permission.rs` → **0 hits**; `git show --stat 3ce1319` vs `8d5da2b` for the union drift.
  **Not run:** the Rust suite — the pins below are cited by name as the tests that exist and were read
  as source, not as measurements taken here.
---

# Empty message content (#122) and permission-note announcements (#124) — known gaps

This page exists because the roadmap family that recorded these gaps
(`docs/roadmap/backlog-79-122-124-28-*.md`) is **deleted on ship**, and the issue
tracker holds only the parts of that family which were filed as issues — #122 and
#124 record what was shipped, not what was deliberately left. Read it before
concluding that the sanitisation placeholder is fully silenced, or that a path-tool
permission pattern does something.

Each item carries a status: **open work** (someone should do it), **recorded, not
open work** (a deliberate limit, nothing owed), **accepted** (a decision, not a gap).
Tests are cited by name; a name is stable where a line number is not.

## #122 — the sanitisation placeholder

One upstream literal, `[System: Empty message content sanitised to satisfy protocol]`,
produced by LiteLLM's `_sanitize_empty_text_content` and never by this repo. It is
defined once (`EMPTY_CONTENT_SANITISE_PLACEHOLDER` in `agent/harness/provider/openai.rs`)
and read by every seam that touches it: the SSE parser's prefix-hold accumulator
(`handle_chunk`, the filter of record), the loop's `consume_stream` bolt
(`agent/harness/loop/turn.rs`), the outbound `request_body` guard, the store-row clamp
(`clamp_placeholder_row` in `agent/worker/client.rs`), and the two subagent guards
(`subagent_flow.rs`'s settle guard, `worker/core.rs`'s `Inbound::SubagentResult` arm).

- **A transcript written before the fix still replays the placeholder. — recorded, not open work.**
  The fix filters *inbound* and clamps a row on its way *into* SQLite, so the banner
  cannot enter a transcript again; it never rewrites rows that are already there.
  Verified against this tree: `storage/db.rs`'s migration list contains no statement
  touching `native_messages.content_json` (grep → 0 hits), and a Resume hydrates
  whatever bytes are stored (`load_transcript`, `agent/harness/loop.rs`, reached from
  `worker/core.rs`'s `Resume` arm) — so opening a pre-fix session re-sends the literal
  to the model and re-renders it in the room. The reason it was left is ADR 0054's rule:
  the wire's shape is corrected where the request is built, and re-labelling durable
  rows for a wire's sake sits on the wrong side of that line. If it is ever done it is a
  one-off transcript scrub, not a code path. Replay is now harmless in the direction that
  matters: the guard's predicate is `content_is_effectively_empty`, which covers the placeholder
  as well as empty, so a replayed `assistant` row carrying `tool_calls` has its `content`
  omitted and cannot make LiteLLM author a NEW placeholder into history — what a replay does
  send is the stale literal itself (a row without `tool_calls` keeps its text), which is a
  display problem, not a self-perpetuating one.

- **The `TranscriptReplace` seam is unclamped, so compaction can still persist a placeholder row.
  — recorded, not open work.** `route_outbound` (`agent/worker/client.rs`) clamps only the
  `TranscriptInsert` arm; the `TranscriptReplace` arm forwards its rows verbatim into
  `StoreFrame::Replace`, and `clamp_placeholder_row`'s own doc comment names that arm as
  the deferred follow-up. The producer path is real, not hypothetical: compaction calls
  `Store::replace_messages` (`agent/harness/compact.rs`), which becomes
  `IpcStore::replace_messages` → `Outbound::TranscriptReplace` (`agent/worker/store.rs`) —
  so a compaction rewrite that carried a poisoned row writes it durably, and a Resume of
  that session re-reads it. It was dropped in the round-2 belt trim on purpose: four
  filter seams for one upstream bug is four places to maintain, and the shipped set covers
  every seam a real provider can reach. The helper the first-round plan paired with it — a
  JSON-parsing `clamp_empty_text_with_tool_calls` — exists nowhere in this tree (grep → 0
  hits), so re-opening this means writing it, not un-deleting it. Revisit only if a provider
  is actually observed writing the placeholder into a replaced row; the clamp must stay
  parse-free if it lands, next to the `Insert` pins
  (`clamp_placeholder_row_rewrites_an_assistant_placeholder_row`,
  `clamp_placeholder_row_leaves_everything_else_byte_identical`).

- **There is no test that pins the outbound request body a provider receives. — open work**, and
  the general gap of which #122 is one instance. `src-tauri/tests/provider.rs` is the named
  home — it is already `MockServer`-based — but read what it actually asserts: the two
  session-id header pins
  (`openai_provider_sends_session_id_headers_when_present`,
  `openai_provider_omits_session_id_headers_when_absent`) and the `stream_options` latch trio
  (`a_400_on_stream_options_retries_without_it_and_latches`,
  `the_stream_options_latch_is_per_provider_instance`, `a_400_about_something_else_is_fatal_and_not_retried`),
  whose request-body reads look only for the presence of the `stream_options` key. The only
  other places a request body is read at all are presence checks, never shape checks:
  `worker_e2e.rs` uses `body_string_contains` with `"role":"tool"` as a mock-ROUTING key (to pick
  which canned stream answers, not to assert what was sent), and
  `provider_switch.rs`'s model-switch test asserts the body contains the new model id. **No test
  anywhere asserts the shape of the `messages` array that leaves the process.** So the
  outbound half of #122 — omitting `content` for an empty-text assistant row that carries
  `tool_calls`, which is what stops LiteLLM authoring the placeholder into history — is pinned
  one level below the wire, by the `request_body` unit pins
  (`request_body_omits_content_for_an_empty_text_assistant_message_with_tool_calls`,
  `request_body_keeps_content_for_an_empty_text_assistant_message_without_tool_calls`,
  `request_body_keeps_content_for_blocks_tool_messages_and_real_text`). A change to
  `request_body`'s output that a real server rejects is invisible to every gate here — and the
  hole is not #122's alone: `anthropic_request_body` and `responses_request_body` are pinned the
  same way, by their own inline unit tests (`anthropic_request_body_maps_the_request`,
  `responses_request_body_maps_the_request` and siblings), so **no provider wire in this repo has
  a contract test at all**; #122 is the instance where the missing layer was already
  load-bearing for a shipped fix. It was left because a MockServer body pin is a sibling
  feature, not a line item in #122's acceptance, and #124's issue names the identical gap for
  the identical class of defect.
  The same absence has a second face, recorded in ADR 0084: there is no Rust↔TypeScript
  wire-contract test either (see the `UnsupportedReason` bullet below).

- **A message that is EXACTLY the placeholder is dropped, at every exact-match seam. — accepted.**
  The literal is matched whole, never as a substring — `content_is_the_sanitise_placeholder`
  trims and strips `*` / `` ` `` decoration and compares the entire value, and
  `content_is_effectively_empty` adds "or nothing but whitespace". So the cost is real and
  deliberate: inbound text whose whole run is the banner is discarded at the SSE seam and at
  the `consume_stream` bolt, and a subagent whose *entire* output is the banner settles as
  `Failed` (`a_silent_child_that_settled_is_not_completed_empty` pins that settle;
  `sse_does_not_silence_legitimate_content` pins the other side). That covers a model echoing
  the literal and a proxied transcript replay of it. The alternative — a prefix or substring
  match — would catch legitimate prose quoting the banner, and the shipped rule is that a
  longer line quoting it streams untouched. **The user-typing-it case, corrected against this
  tree rather than carried from the follow-up note:** a user who types the banner as their
  prompt is *not* silenced on the way out — `request_body` drops `content` only for a message
  that carries `tool_calls` AND an empty-ish `Text`, and a `user` row carries no `tool_calls`, so
  the typed prompt keeps its text — but any
  inbound echo of it (a model repeating it, a replayed transcript) is dropped, so it can read
  as a reply that says nothing. Say that plainly to a user who asks; nothing here can be
  "fixed" without giving up the exact-match rule.

## #124 — path-tool permission pattern announcements

What shipped: a `permission:` pattern map on a recognised path-taking tool is **parsed,
announced and not enforced**. One `notes.push` site, now an exhaustive `match` over
`ToolKey` in `agent/definition_permission.rs` — `BashPatternRules` for command-text rows,
`PathPatternRules` for the ten path-taking keys, `Unrecognized(_) => None` because an
unknown key has no known path semantics and announcing one would be a lie. Enforcement did
not move: `definition_verdict` reads only `Rules::catch_all_action()` and answers `AsSelf`
for any per-pattern ruleset. (Two things this branch already fixed, so nobody re-files them
from the deleted follow-up note: the modal's per-tool copy — `describeNote` in
`src/components/AgentsDialog.tsx` has a `pathPatternRules` arm of its own — and the
`docs/features/permissions-model.md` wording that claimed path tools stayed silent.)

- **No parity test between the Rust `UnsupportedReason` enum and the TS `AgentUnsupportedReason`
  union. — open work.** The union in `src/lib/tauri/types.ts` is a hand-copy, and it drifted
  once already on this branch: `3ce1319` added the Rust `PathPatternRules` variant across four
  Rust files and no TS file, and `8d5da2b` — a review commit — is what added
  `"pathPatternRules"` to the union. Nothing could have caught it earlier, and nothing catches
  the next one: no test in `src/` reads `definition_permission.rs` (grep → 0 hits); the modal
  pin `unrecognised_and_unsupported_rows_are_named_not_dropped` builds its fixture through a
  `note(kind, value: string)` helper, so the reason travels as a bare `string` and a renamed or
  added Rust variant passes it unchanged; `tauriBarrel.test.ts` pins only that
  `AgentUnsupportedReason` is exported as a type; `tauri.test.ts`'s DTO pin asserts the block's
  serialised *shape* (ordered pairs, lowercase `action`, snake_case `whole_tool`), not the
  reason union. Rust-side, `pattern_matching_applies_to_path_taking_tools_only` and
  `a_path_tool_pattern_map_announces_itself_unsupported` enumerate both arms and stay green
  whatever the union says. The consequence of the next drift is not a red build — it is the
  modal's generic fall-through in `describeNote` printing a new reason's raw wire token as its
  sentence (both current variants have their own arm now, so only an unannounced future one
  lands there). A cheap pin
  is a TS test that reads the Rust enum's variant names out of the source file, the shape the
  census-style tests in this repo already use.

- **Enforcing path patterns through the shared canonicaliser remains deliberately undone. —
  recorded, not open work** for this run: the owner chose announce-not-enforce, and the
  announcement task was told not to half-build the enforcement (no path resolution in the parse
  module, and `gate.rs` changed doc-only). It is worth separating from the bash class, because
  the two refusals are not the same refusal. ADR 0084 refuses a second **command-text** matcher
  — `grep x file 2>/dev/null` contains a `>`, and no rule language here separates "redirect to a
  file" from "redirect to an fd" — and its 2026-10-29 amendment says that ruling is untouched by
  #124 and still governs. A path pattern is a different problem: there is no command text to
  parse, and the canonicaliser already exists and is shared (`FsBackend::validate` → `resolve` →
  `check_under_roots`, plus `canonicalize_lenient`), which is exactly what ADR 0081 / ADR 0029's
  one-canonicalizer rule wants a judge to use instead of inventing a second one. Two things stop
  it, and neither is ADR 0084's ruling:
  - **The root set is undecided, and the durable docs do not decide it.** `FsBackend::resolve`
    answers "is this under *any* root?", with `roots[0]` as the base a relative path joins to and
    an empty root set failing closed. That is the sandbox question, not the question an
    `edit: {"*.md": allow}` row asks — relative to which root does a definition's pattern match?
    The roadmap text claims ADR 0084 answers "the boundary root set"; it does not — grep for
    `root set` in ADR 0084 returns 0 hits. So this needs its own decision (its own discuss/ADR),
    and that decision is the actual work, not the matcher.
  - **Where it consults is load-bearing.** Row 3's protected-dir guard
    (`is_guard_path`, inside `rule_or_guard_verdict`) returns early, so a new definition consult
    placed anywhere but ADR 0084's row-4 tail could answer for a write the guard exists to ask
    about. ADR 0084's row placement is what keeps that ordering honest; any enforcement inherits
    it or breaks it.

## Where to look first

`docs/features/permissions-model.md` carries the shipped announcement behaviour and the
unenforced-class wording; ADR 0084 carries the row-4 ruling and the refusal of a second
matcher, with the 2026-10-29 amendment that scopes #124's change to the announcement half.
For #122, `docs/decisions/0054-*.md` is the rule that decides where a wire shape gets
corrected, and it is the reason both deferred items above are deferrals rather than bugs.
