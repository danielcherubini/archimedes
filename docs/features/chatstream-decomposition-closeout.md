---
status: live
last-verified: 2026-11-01
verified-by: read against `main` at `dd7ed4fb` (the squash of PR #142, the tree this doc ships in).
  Every line count below was re-measured with `wc -l` on that tree, not copied from the plan
  family this doc replaces. The load-bearing constraints are deliberately NOT restated here —
  each points at the code and the mechanical pin that owns it, because a second copy is a second
  thing to drift.
---

# chatstream-decomposition — close-out record

Surviving home for what the `docs/roadmap/chatstream-decomposition-*` family recorded. That family
is deleted on ship, and squash-merge orphans the per-commit hashes it cites, so this doc names the
**squash commit `dd7ed4fb` and PR #142** rather than the eleven commits that preceded them.

Issue #135: `ChatStream.tsx` was a 1,553-line component with a 7,885-line test file.

## The measured result, on `main`

| File | Before (`b0071544`) | After (`dd7ed4fb`) |
|---|---|---|
| `src/components/ChatStream.tsx` | 1553 | **710** (−54%) |
| `src/components/ChatStream.test.tsx` | 7885 | **4156** (−47%) |

Extracted: `lib/chatSessionDerivations.ts` (207) + `hooks/useChatSessionDerivations.ts` (163),
`useChatAttachments.ts` (539), `useChatPromptDispatch.ts` (595) + `usePromptQueueFlusher.ts` (205),
`test/chatStreamFixtures.ts` (262), and the domain test split
`ChatStreamDirectoryCompletion.test.tsx` (1845) / `ChatStreamChildGates.test.tsx` (709).
Gate at merge: 165 files, 3368 passed | 1 skipped; `tsc --noEmit` and `pnpm build` clean; zero
Rust/Tauri files touched.

**Behaviour was MOVED, not improved.** Bodies are byte-for-byte and the load-bearing comments
travelled with the code they explain. Any behaviour change would have needed its own commit; none
was needed.

## What this doc deliberately does NOT restate

Three constraints of this refactor are strong enough to be enforced by tests, and each is already
owned where the next editor will hit it. Copying them here would create a second copy to rot.

- **Why the `vi.mock` factories stay inline and never move to the fixtures module** — the rule, the
  reason (a store-mediated transitive path into the mocked barrel), and the failure mode
  (0 tests run, `ReferenceError` at an import line) are in `src/test/chatStreamFixtures.ts`'s module
  header, and pinned **mechanically** by
  `src/test/chatStreamFixtures.test.ts` → `"the fixture module never calls vi.mock (the seam must live in the test file)"`.
- **Which test files mock the tauri barrel, and how many spread `importActual`** — owned by the
  assertion in `src/lib/tauriBarrel.test.ts`; read the count there. The barrel itself is ADR 0074.
- **Why `dirPrefix` stays component-local, and why the composer-lock chain moved when it did** —
  both reasons live beside the code: the picker comment in `ChatStream.tsx` (the one-directory cache
  key, mutation-checked, pinned in `ChatStreamDirectoryCompletion.test.tsx`) and the comment in
  `useChatSessionDerivations.ts` recording that wave 1's refusal aged out only once the seam landed.

## Two transferable lessons

These are about *how to decompose a hot file*, not about this file, so they have no code home.

**1. Cut the work by owned file set, not by the issue's own section list.**
Issue #135 read as four parallel extractions (§1 attachments, §2 dispatch, §3 derivations, §4 test
split). It is not: `ChatStream.tsx` is the file every one of them edits, so decomposing by section
produces a chain of serial waves, each paying a plan+implement round-trip. Cutting by owned file set
instead produced one genuinely parallel pair and a 3-deep chain — 5 dispatches for 6 tasks. The same
thing happened again at the end: wave 4 was width 1 only because one task owned both the component
*and* its test file; cutting at the source/test boundary made the sets disjoint and the wave width 2.
The reusable move is to ask "which files does each task *write*" before asking "which concern does
each task address".

**2. "This must stay because something consumes it" is only valid if that something else stays.**
Twice in this run an argument of that shape was wrong, and one of them was in both the plan *and*
the reviewer that vetted it — so a passing vet does not clear it. The case: `activeCapabilities` was
left in the component because "it must stay selected for the `imageCapable` consumers", which was
circular (`canResume`, the other consumer, was already moving) and cited a consumer that does not
exist (`send` re-reads a fresh value via `useSessions.getState()`, it does not read the selector).
The lesson is procedural: enumerate consumers with a grep against the tree, never from prose. The
same trap nearly cost a build in the other direction — a split file's import keep-set omitted
`useInteractive` while the prose justifying the list named it, and the vet that checked the list
counted a *different* block's store reads.

## Corrections made to this run's own records

Recorded because each was a confident, well-formed wrong answer.

- A dispatch claimed a test file held 150 tests; it runs **152** (149 plain `it(` + one 3-row
  `it.each`). `grep -c 'it('` silently under-counts `it.each`. Total was right (215) for the wrong
  reason. The runner's number is the only authority.
- A vet reported a missing import in a plan; the file on disk already had it. The vet had counted one
  block's store reads and reported them against a different block's import list — both numbers were
  correct measurements of different spans.
- The follow-up for split-orphaned citations grepped `docs/` and not `src/`, and so found 3 stale
  references where **15** existed. `primaryLines()` proved it: zero occurrences in the residual file,
  nine in its new home, and eight comments still naming the old one. Re-pathed in the same PR; see
  `docs: re-path test citations orphaned by the task06 split`. When a test moves, the citation sweep
  must cover `src/` — most citations live in the source comments of the components the tests pin.

## Related, still open

- `src/components/ChatStream.test.tsx` at 4156 lines is no longer a monolith but is still the largest
  test file. Four small domain blocks (13 tests) were left in it deliberately: each would pay a
  ~140-line copy of the module scaffold, which is worse than the ratio it buys. That is a recorded
  trade, not an oversight — see the fixtures-module note above for why the scaffold cannot be shared.
- The `agentState` store does not reset on `turnCompleted`, so `inTurn` is the ground truth for
  "a turn is in flight". That is a store-side follow-up, noted in the moved comment.
