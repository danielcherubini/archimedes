---
status: accepted
date: 2026-10-27
superseded-by:
---

# A pipe-held exit-0 bash run is a COMPLETION, and the fact that says so must be latched BEFORE the kill

A command whose foreground work finished and which was **watched exiting 0**, while a background process still held its output pipe open, used to be reported `The command timed out and was killed at its deadline.` with `is_error: true` — byte-identical to a command that genuinely hung. We decided it is a **SUCCESS**, reported as one (`is_error: false`, `exitCode: 0`), with a note that names the exit code and forbids re-running — and that the fact which distinguishes the two runs is **latched the moment the read loop breaks, before the process-group kill**, never read at the report. Both halves are in `tools/exec/bash.rs`: the `pipes_held` binding above the kill gate, and `bash_exit_report`'s fourth parameter. Landed as `0e1df26` (issue #94).

`is_error` describes **the command we were asked to run**. It exited 0 and we watched it do that. The killed grandchild is **our capture contract's doing** — `exec_bash`'s kill gate fires deliberately whenever a pipe is held, so the `SIGKILL` is something *we* do in order to end *our* capture, not something the command failed at. Reporting it as the command's failure attributes our action to the caller's process.

The stakes are on the wire, so this is not a wording question. `is_error` is serialized as `isError` (`tools/types.rs`) and is what renders the tool card, so `isError: true` for a command that exited 0 **is** the defect #94 was filed for. And the note rode along with it: #94's evidence is models that re-ran non-idempotent work off that flag-and-text pair and invented causes for the phantom failure — three in one session, IPv6, `getaddrinfo`, DNS, all false. The one note built to prevent a blind retry (`UNKNOWN`, "inspect the resulting state before re-running") was suppressed precisely *because* the command had succeeded and its status was known.

**Supersedes NO ADR, and there is no host document to append to.** Measured, not assumed: grepping `docs/decisions/` for `bash_exit_report|exit status|exit code|exitCode|timed out|SIGKILL|process group` returns exactly three ADRs — 0052 (the updater manifest's `exit 1`), 0055 (subagent liveness, whose `Failed { "timed out" }` became `"unresponsive"`), and 0078 (test scratch dirs). **None of them governs how a bash run's exit status is reported.** `0060` is the bash-adjacent one and is not in scope either: it decides the Windows child-console policy and owns a source census; it says nothing about exit statuses, deadlines, or `is_error`.

The invariant that fell therefore lived **in code, not in an ADR**. `a1afc16` (`fix(tools): report a bash run's real exit status, never a fabricated -1`) stated it twice over: in its commit message — *"exit 0 seen is the only non-error row, a signal death names its signal (never a fabricated code), a genuinely unknown outcome says so and claims no code"* — and in the census it introduced, whose doc comment read *"The one non-error row of the table is (not cancelled, not timed out, exited 0) — everything else is an error."* By the commit before `0e1df26` that census asserted `ok == vec![0]` with the failure message *"only the first row (exit 0, untouched) is a success"*. A doc comment and a test name are what changed, and `0e1df26` changed both in the same commit as the code: the census is now `bash_exit_report_non_error_rows_are_exactly_two` with `ok == vec![0, 6]`. So there is nothing in `docs/decisions/` to narrow, no *Partial:* note to append (the 0033/0034 convention needs a host ADR to append to), and no `superseded-by` to set. This is the same situation 0079 records for #78 — **"#78 has no ADR … There is therefore no host to append to"** — and it is handled the same way: the whole statement lives here, pointed at a commit and a test name instead of an ADR number.

## Why the fourth input and not a smarter guess

The report had three inputs and could only ever answer "did we see an exit status". For the run #94 is about, it had seen one — `Some(0)` — and threw the decisive fact away on the floor: whether a pipe was **still held at the deadline**. That fact was already in the executor's hands (`stdout_open`, `stderr_open`); it simply was not threaded. So the fix is one more parameter carrying one more observed fact, and the truth table gains a **second success row** rather than a heuristic.

The rule to carry forward from `a1afc16` is **"never report an outcome you did not observe"**. #94 is that same rule applied to a fact the run *did* observe and discarded — which is why this extends the old decision instead of reversing it.

## The truth table as shipped

Inside the `timed_out` arm, in this order (the order is load-bearing — see R5):

| Row | Condition | `is_error` | Note, as shipped |
|---|---|---|---|
| **R5** | status known, **died on a signal** | `true` | `DEADLINE` + names the signal, claims **no** code |
| **R1** | `pipes_held` ∧ `code == Some(0)` ∧ `signal.is_none()` | **`false`** | `PIPE_HELD_SUCCESS` — completed, exit 0, **DO NOT RE-RUN**, drain-bounded |
| **R2** | `pipes_held` ∧ a non-zero code | `true` | the **real** code, and the "timed out" claim is **gone** |
| **R3** | no status observed | `true` | `DEADLINE` + `UNKNOWN` — unchanged; held pipes cannot rescue a status we never saw |
| **R4** | none of the above | `true` | `DEADLINE` alone — unchanged. **R4 is the row that keeps R1 honest** |

Before the arm, `cancelled` still wins outright and returns early, so held pipes never rescue a cancelled run. Outside `timed_out`, the fourth fact is inert: the pre-existing four-row match (`(Some(0), None)` is the untouched success) is unchanged.

## The fact is latched before the kill — and the issue's own patch is a silent no-op

This is the part a reader is most likely to "simplify" back into a bug, so it gets its own section. The semantic R1 needs is *was an output pipe still held **at the deadline***. The only place in `exec_bash` where `stdout_open`/`stderr_open` still mean that is **between the read loop's closing brace and the kill gate**:

    // LATCH the pipe fact BEFORE the kill, not at the report. `stdout_open`/
    // `stderr_open` still mean "held at the deadline" only here: the group kill
    // below kills the holder, and the drain below then reads the EOF that kill
    // produced and clears both flags — so by the time the report is built the
    // pair reads `false` for the exact run this fact exists to identify (#94).
    let pipes_held = stdout_open || stderr_open;

and the call site repeats the warning:

    // The fourth fact is the LATCHED one (`pipes_held`, above the kill gate) —
    // never the live `stdout_open || stderr_open` pair, which the kill and the
    // drain have already cleared by this point (#94).

**#94's literal suggested patch — passing `stdout_open || stderr_open` at the report call site — is a no-op for exactly the run this decision exists to fix.** The mechanism, not just the verdict: between the loop and that call site the kill gate fires (`if stdout_open || stderr_open || status.is_none()`) and **kills the pipe holder**, and the bounded drain then reads the EOF that kill produced, clearing both flags. So at the call site the expression is `false` for the pipe-held success and `true` only for an escaped grandchild that needs nothing. `bash_exit_report`'s doc comment makes the sampling point part of the parameter's meaning for this reason:

> `pipes_held` is the fourth fact and its SAMPLING POINT is part of its meaning: it must say whether an output pipe was still held open **AT THE DEADLINE**, latched the moment the read loop breaks and BEFORE the process-group kill (`exec_bash`'s `pipes_held` binding).

**The failure mode is silent, which is the whole danger.** A lost latch compiles, and the five unit pins stay green because they call `bash_exit_report` **directly** and never see the flags at all. Nothing short of the end-to-end shape notices.

**The guards, named on the correct ground.** `bash_pipe_held_completion_is_reported_as_success_not_a_timeout` and `bash_issue_94_repro_is_reported_as_success_not_a_timeout` pin R1 end-to-end through `execute_tool`, and **they are the only tests whose assertions depend on R1 firing** — which is what makes them the only ones that can see a lost latch. Both were RED before `0e1df26`. Say the ground, not just the verdict: the guard is the fixtures' **assertions**, not their code path.

**"Traverses the kill and the drain" is NOT the discriminating property, and it must not be used as one.** The rule is: *any run that breaks on the deadline or on cancel with a pipe still held crosses both the kill gate and the bounded drain, and the tree has several.* So `bash_timeout_kills_child` (`sleep 5` at a 300 ms deadline — both pipes held) and `bash_backgrounded_grandchild_killed_with_group` (the grandchild holds a pipe, so the group kill fires and the drain runs) traverse both, and `bash_cancel_kills_child` does too (held pipes *and* `status.is_none()`, so both arms of the gate fire). Two more cross the kill **without** the drain — `bash_timeout_kills_a_child_that_closed_its_pipes` and `bash_cancel_kills_a_child_that_closed_its_pipes` reach the gate through `status.is_none()` with both pipes already closed, and the drain's own guard (`if stdout_open || stderr_open`) skips it.

Every one of those stays green whichever arm the report takes, because each asserts only kill-behaviour: `bash_timeout_kills_child` asserts `is_error`, `cancelled == false` and elapsed; `bash_cancel_kills_child` asserts `cancelled == true`, `is_error` and elapsed; `bash_backgrounded_grandchild_killed_with_group` asserts elapsed, output-contains-`done` and marker-absent; the two closed-pipes fixtures assert `is_error`, `cancelled` and marker-absent. **None of those changes if R1 stops firing** — which is exactly how `bash_backgrounded_grandchild_killed_with_group` flipped from error to success unnoticed (see Honest limits). Two of them cannot reach R1 for a structural reason worth naming: the two `cancel` fixtures arrive with `cancelled == true`, and the **cancelled arm returns before `timed_out` is ever consulted**, so R1 is unreachable for them by arm order alone.

**Which fixture is the truth.** The shipped doc comments settle it, and a future editor who reads the pair as duplicates will delete the wrong one:

> Where the two disagree, `bash_pipe_held_completion_is_reported_as_success_not_a_timeout` is the truth and THIS one is the illustration — its `( sleep 25 & )` leaves an orphaned subshell holding the write ends, so it is the shape whose holder the fixture never named.

The truth fixture is the deterministic `( sleep 25; exec >&- 2>&- ) &` — exactly one named holder, with an explicit fd close. The illustration is #94's repro block run verbatim, kept "for faithfulness to the report (the repro IS the spec)". Neither pays 25 s: "The holder's 25 s NEVER enters the wall clock: the deadline ends the run and the process-group kill reaps the holder, so this fixture costs `timeout_ms` plus the bounded drain."

**The second half of the trap: R1 is unreachable for a command we actually had to kill, and that is by construction.** The fixture's own comment states it —

> `wait` keeps the parent alive until the holder finishes (25 s), so the deadline would fire with `status.is_none()`, the kill gate would SIGKILL the group including the parent, and the bounded post-loop reap would hand the report a SIGKILL death — which is the signal row, not this one.

so **no foreground `wait` is load-bearing**: without it the parent `sh` falls off the end of the script, the `child.wait()` select arm retires the status well before the deadline arm breaks the loop, and the run arrives at the report with its status already observed. Add a `wait` and the run becomes R5.

## What falls and what survives of `a1afc16`

Almost all of it survives, and the list is worth having in one place:

- **the pure function itself** — `bash_exit_report` stays PURE so the whole table is testable without a child and without timing (the doc comment's reason, unchanged except that "three inputs" became "four inputs");
- **"never a fabricated `-1`"** — reinforced, not relaxed (see R5);
- **a signal death names its signal** and claims no code;
- **an unknown outcome says so** and claims no code (`UNKNOWN`, unchanged, byte-identical);
- **the kill gate's skip rule** — "The kill is skipped ONLY when the exit was observed AND both pipes are closed";
- **the pid captured before reaping** rule in `kill_bash_process_group` (`Child::id()` goes `None` once the status is collected).

What falls is exactly one claim: that exit-0-seen is the **only** non-error row. It was never an ADR; it was a doc comment and a test name, and `0e1df26` changed both alongside the code.

## The census grew — and its discriminating power is not where the draft expected

`bash_exit_report_success_is_the_only_non_error_row` was **renamed** to `bash_exit_report_non_error_rows_are_exactly_two`, definition plus two in-file doc references, in the same commit as the code. The old name asserted a one-success table and became false the moment R1 existed; a name that lies about a census is worse than no census.

The table is now **10 rows** and asserts `ok == vec![0, 6]` — "the only successes are exit 0 untouched and exit 0 with the pipes held". Its own doc comment names the sharpest pair, and it is the pair a reviewer should look at first:

> Rows 5 and 6 are the sharpest pair: they differ ONLY in `pipes_held`, and exactly one of them is a success.

**Three mutations do redden it — measured by the implementer (T04) with `cargo test`, and recorded here as attributed measurements, not re-run by this ADR, which ran no `cargo` at all:**

| Mutation | Result |
|---|---|
| ignore `pipes_held` | rows **`[0,5,6]`** — RED |
| narrow R1's guard | **`[0]`** — RED |
| check `pipes_held` **before** `cancelled` | rows **`[0,6,9]`** — RED |

Row 9 is held + cancelled, so the third result means **the arm order is censused, not merely asserted** — a reorder that lets held pipes rescue a cancelled run is caught by the table, not only by review.

**Recorded honestly, because the acceptance draft asked for something that does not exist: the drafted `signal.is_none()` mutation reddens NOTHING.** Drop it from R1's guard and the census stays green, because R5 already returns on any `Some(sig)` before R1 is reached. The shipped code says so itself:

> `signal.is_none()` is a tautology this far down but stays in the guard as the safety argument made explicit: what distinguishes "it finished, we watched it" from "we ended it" is that we did NOT end it.

So: **the census's discriminating power lives in `pipes_held` and in the arm order, not in the signal clause.** Keeping a tautological guard as an explicit safety argument is deliberate — do not "clean it up" and lose the argument, especially if R5 ever moves. 0079 sets this standard by recording a vacuous assertion rather than hiding it, and this ADR follows it. (Consequence: the census's own doc comment currently lists dropping `signal.is_none()` among the changes that "reddens this assert", which the measurement contradicts. That is a **stale doc-comment line**, recorded as a follow-up in Consequences — this ADR edits no source.)

## R5 comes first, and that is what keeps the fabricated `-1` dead

A genuine hang does **not** arrive at the report as `status.is_none()`. The loop breaks with no status; the kill gate fires on `status.is_none()` and SIGKILLs the group; and the post-loop bounded reap — `if status.is_none() { timeout(DRAIN_GRACE, child.wait()) }` — then collects **that signal death**. So a real timeout is a *known status that died on a signal*, and R5 is where every one of them lands.

That ordering is not stylistic. If a code-printing row were reached with a status whose `code()` is `None`, the report would have to print a number it never observed — **the fabricated `-1` returning**, the exact defect `a1afc16` removed. Hence `if let Some(sig) = signal` precedes any read of `code`, keeps the deadline sentence (a real hang is still called one) and names the signal while claiming no code. And R5-before-R1 is precisely what makes the success row **structurally unreachable for a command we ended**: if we killed it, we reach R5, not R1.

Pin: `bash_exit_report_pipe_held_signal_death_is_still_a_signal_death` — `is_error`, `code == None`, `contains("signal 9")`, and `contains("timed out")` with the failure message "a genuine hang must still be called one".

The deadline sentence itself is now the `DEADLINE` constant, `"The command timed out and was killed at its deadline."`, and its doc comment keeps the byte-identity claim and names its pin:

> It stays BYTE-IDENTICAL to the pre-#94 note because `contains("timed out")` is asserted against it by the deadline fixtures (`bash_timeout_kills_a_child_that_closed_its_pipes`) and by the unknown-status and not-held guards — a GENUINE hang must still be called one.

**One correction, stated so a reader comparing this ADR to the roadmap does not think either document sloppy.** The roadmap's approved **D2 table** discussion — its **R5 row** prose — says the deadline wording is pinned by **two** fixtures: *"keep the existing "timed out" wording here: `bash_timeout_kills_child` and `bash_timeout_kills_a_child_that_closed_its_pipes` pin it, and they are telling the truth."* Measured at `0e1df26`, `bash_timeout_kills_child` **asserts no text at all** — `is_error`, `cancelled == false`, elapsed. It pins that the child *died*, not the wording. The **only** end-to-end pin on `contains("timed out")` is `bash_timeout_kills_a_child_that_closed_its_pipes`, which is exactly what the shipped `DEADLINE` doc comment names, and this ADR names only that one. The stale pair has **one** carrier in the tree: the roadmap's D2 R5 row. It is **not** in `0e1df26`'s commit message — measured, that message names exactly two tests (`bash_exit_report` and `bash_backgrounded_grandchild_killed_with_group`) and contains neither fixture name — so the commit message is not a second carrier and is not being blamed here.

**Platform honesty for R5, from the tree:** `exit_signal` is `None` on any platform whose `ExitStatus` does not expose one (`#[cfg(not(unix))] pub(crate) fn exit_signal(_status: &…) -> Option<i32> { None }`), so **R5 cannot exist off Unix**, and its pin is `#[cfg(unix)]`-gated for that reason and no other. On Windows the same census input — `a_death_with_no_exit_code`'s `STATUS_ACCESS_VIOLATION` twin — lands on **R2** with `is_error: true`. Both platforms give an error; only one can name a signal. `a_death_with_no_exit_code`'s own comment is the instruction to keep: "The asymmetry is the point — do not "unify" it."

## The `cfg` split: the same note, minus one sentence and minus any replacement

`PIPE_HELD_SUCCESS` exists **twice**, and the difference between the two literals *is* the decision. Quoted byte-exactly from `exec/bash.rs` at `0e1df26`:

`#[cfg(unix)]`:

> The command COMPLETED and was observed exiting with code 0. The deadline was reached only because a background process still held the output pipe open; the command's process group was killed (SIGKILL) to end the capture. DO NOT RE-RUN this command — it already succeeded and its side effects have landed. Output written after the drain window is not captured here.

`#[cfg(not(unix))]`:

> The command COMPLETED and was observed exiting with code 0. The deadline was reached only because a background process still held the output pipe open. DO NOT RE-RUN this command — it already succeeded and its side effects have landed. Output written after the drain window is not captured here.

The Windows note drops the process-group clause and **replaces it with nothing** (the only other difference is the `;` that the dropped clause was attached to). That is justified from shipped code, not from taste: `kill_bash_process_group`'s unix arm SIGKILLs the negative pid — "A negative pid SIGKILLs the WHOLE process group (the child is the group leader via `process_group(0)`)" — while its `#[cfg(not(unix))]` arm is `{ let _ = pid; let _ = child.kill().await; }`, killing the **direct child only**. And R1 is only reachable when that direct child **already exited**. So on Windows nothing in the pipe-holding descendant is killed at all, and the sentence would describe an action the platform never took.

The shipped doc comment rejects both tempting repairs, and this ADR adopts those rejections:

> So nothing in the pipe-holding descendant is killed there, and "a background process holding the pipe was killed" is a claim the platform does not deliver. Nor may this say it "may still be running": R1 exists to stop the model chasing a phantom, and the platform genuinely cannot tell. Silence on the unverifiable fact is the honest option — both alternatives assert something unobserved.

**Silence on the unverifiable fact is the honest option.** And the verdict itself is **not** gated, which matters as much as the split: "The `is_error: false` verdict itself is platform-neutral and ungated: the command exited 0 and was watched doing it on every platform." Only the kill sentence is `cfg`-split; the success is claimed everywhere.

**The same rule governs the unix wording — action, not fate.** The unix note says the process group "was killed (SIGKILL) to end the capture", which is literally true whatever happens next, and pointedly does **not** say every background process was killed, because "a descendant that called `setpgid`/`setsid` escapes a negative-pid kill, which the drain's own comment concedes".

**Honesty about how much of this was executed** (0060's standard — a census or a type-check is not behavioural proof): the mingw target **type-checks** the `#[cfg(not(unix))]` arm and its note. Nothing Windows-behavioural was **run** here. Everything in this section is a claim about **what the code says**, not about what a Windows box does — including whether the three-sentence Windows note reads *usefully* to a model, which is unmeasurable from this machine.

## `DO NOT RE-RUN` is a pinned contract — a phrase-level home, not a literal-level one

    const DO_NOT_RERUN: &str = "DO NOT RE-RUN";

0079 gives its rejection sentence a section called "a pinned contract with exactly one home", and that framing does **not** transfer unchanged here, so this section is titled for what it actually is. **Measured: no note string in this tree is byte-pinned.** Every assertion on a bash note is `contains` on a phrase — `contains("timed out")`, `contains(DO_NOT_RERUN)`, `contains("signal 9")`, `contains("unknown")`, `contains("0")` — plus the negative `!note.contains("in full")` and `!text.contains("timed out")`. The only `assert_eq!` involving a note anywhere in `exec/tests/bash.rs` is `assert_eq!(note, None)`, twice, and that pins *absence*, not wording. So there is no string here with 0079's single literal home, and borrowing its heading unexamined would imply one.

`DO_NOT_RERUN` is nevertheless the one phrase with a **single home**, arrived at by the other route, and its shipped comment says so:

> The do-not-re-run phrase, chosen ONCE and asserted by every test that asserts it (`bash_exit_report_pipe_held_exit_zero_is_a_success_that_forbids_rerun` and both end-to-end fixtures). The note is not pinned byte-for-byte — the file's convention is `contains` on a distinctive phrase — but this phrase is the whole point of the report, so it is the one that gets pinned.

Single-home-by-phrase is the same discipline 0079 enforces single-home-by-literal, and it has the same two consequences for whoever edits next:

1. **the phrase is a contract the model learns.** Changing `"DO NOT RE-RUN"` is a **behaviour change**, not a reword — it must move the constant and stay **one** constant. Copying the literal into a test would create a second home and destroy the property, exactly as 0079's "do not strengthen the loop tests into a second literal pin" protects its own.
2. **the negative half of the contract lives in the unit pin only:** `!note.contains("in full")`. The note may never be reworded into claiming full capture — see the next section.

**`PIPE_HELD_SUCCESS` is deliberately denied this treatment: it has two homes by construction,** `#[cfg(unix)]` and `#[cfg(not(unix))]`, and the *difference between the two literals* is the decision the section above records. Collapsing it to one home would mean either deleting the split or byte-pinning both arms, and a byte-pin on both arms invites someone to "fix" one to match the other — erasing the platform honesty. The file's `contains` convention is what makes that convention *safe*, so it stays.

## Honest limits — two, both named

**1. The note never claims the output was captured in full, and cannot.** The drain after the kill is bounded, and its own comment concedes the escape:

> Drain what the group's death frees, bounded by a short grace deadline — NOT an unbounded wait for EOF (a grandchild that escaped the group could hold the pipes forever). Only meaningful while a pipe is open: both closed means there is nothing to read.

with `DRAIN_GRACE` at 2 s ("The grace deadline for draining a killed `bash` child's pipes (2 s — the pipes may never close if a grandchild escaped the process group; a bounded wait, not an unbounded wait for EOF)"). Output after that window is lost, so the note's last sentence states the one loss it knows — "Output written after the drain window is not captured here." — and the unit pin `!note.contains("in full")` keeps it that way. Nothing in this ADR paraphrases the note into "the output was captured". (For completeness, since a reader will diff this ADR against the roadmap: the roadmap renders the drain comment as *"a grandchild that escaped the process group could hold the pipes forever"*, while the shipped drain-loop comment reads "escaped the group" — the same concession, one word apart. The blockquote above is the shipped text.)

**This limit is already house doctrine, recorded in the glossary before this ADR existed, and 0080 only supplies the mechanism behind it.** `CONTEXT.md`'s **Pipe-held completion** entry says: "The note never claims the output was captured in full: the drain after the kill is bounded, and a grandchild that escaped the process group can outlive it." That sentence **is** this limit. A limit the glossary already states is a limit the house has already agreed to, which makes it harder to "improve" away later — so it is credited here rather than restated as this ADR's discovery.

**2. `bash_backgrounded_grandchild_killed_with_group` silently flipped from error to success, and stays green because of what it asserts.** Read its assertions: elapsed under 5 s, output contains `done`, and `marker.txt` absent after waiting 3 s past the moment an orphaned grandchild would have written it. **It never asserts `is_error`.** It was *always* an R1 shape — a backgrounded holder, a `timeout_ms`, and a foreground `echo done` exiting 0 — so R1 now fires for it and the outcome changed underneath a test that could not see it. This is **shipped deliberately: `0e1df26` records it as "Recorded, not patched"**, and it is the **live case the falsifier watches** (next section): the one test in the tree where a real backgrounded grandchild was killed and the run is now reported a success. The flip costs no coverage of the kill itself — the marker-absent assertion is still the group-kill proof, and it stays the owner of the grandchild's-death claim, which both R1 fixtures pointedly decline to duplicate.

**Where the glossary under-states the picture.** The same `CONTEXT.md` entry says the note "adds that a background process holding the pipe **was killed**". Measured against the shipped text, that is true **on unix only** — the `#[cfg(not(unix))]` note drops the sentence entirely. The entry is right about the term and under-states the platform split; it is not wrong about the decision. `CONTEXT.md` is **not edited by this ADR** (it is not the owned file, and the glossary's kill clause is simply the unix note's clause). The one-clause amendment — scoping that clause to unix — is recorded as a follow-up line in Consequences.

## What refutes this

The census carries the falsifier in its own doc comment, so the row stays falsifiable where the row lives:

> if a run is ever observed where a pipe was held AND the killed background work mattered, row 6 was wrong.

**What would count as observing it:** a session where a command reported as a pipe-held completion produced its side effects, and work it had **backgrounded** — the work our `SIGKILL` removed — was required afterwards and did not happen. A log writer, a daemon, a build server the command was meant to leave running. The run reported success while the harness had destroyed part of what the command asked for.

**What changes if it is observed:** either the note **gains a warning** naming the killed background work as a loss the caller must check, or the row **returns to `is_error: true`** — and if the latter, the census's `ok` vector goes back to a single index, `bash_exit_report_non_error_rows_are_exactly_two` is renamed again, and **this ADR is superseded for that row**. That last clause is what makes the falsifier costed rather than rhetorical.

**Stated as live, not discharged** (0079's standard): nothing in this tree observes real sessions, so "no such run has been seen" cannot be upgraded into "none exists". The closest thing available is `bash_backgrounded_grandchild_killed_with_group`, and it points the *other* way — it shows killed backgrounded work that was **wanted dead**, which is evidence for R1 but not proof that it always holds.

## Considered Options

- **Keep `is_error: true` and only fix the wording**: rejected — `isError` is what renders the tool card and what a model reads as failure, so a truthful sentence on a false flag is still a false report. #94's evidence is models re-running non-idempotent commands off the flag-and-text pair together.
- **Pass `stdout_open || stderr_open` at the report call site — #94's literal patch**: rejected — a no-op for the target run, because the kill and the drain clear both flags first. This is the option a reader is most likely to re-propose, so the rejection names the mechanism, not just the verdict.
- **Route held-pipe non-zero exits to the success row too, or fold them into the timeout note**: rejected — R2 keeps `is_error: true` with the **real** code and stops saying "timed out". A real failure must not read as a hang; that is #94 wearing the other mask, and it makes the model retry a command that genuinely failed.
- **Let R2 print a code for a signal death, or reorder R1 above R5**: rejected — that is the fabricated `-1` returning, and it makes the success row reachable for a command we `SIGKILL`ed.
- **Claim full capture, or hedge "output may be incomplete" into R1's note as a warning**: rejected — the claim is unobservable past `DRAIN_GRACE`; the warning re-opens the phantom-retry this row exists to close. The shipped middle path states the one loss it knows ("after the drain window") without warning.
- **Say "may still be running" on Windows instead of dropping the sentence**: rejected — see the two phrasings the shipped doc comment itself rejects; both assert something unobserved.
- **Set `superseded-by` / supersede an ADR**: rejected — nothing in `docs/decisions/` governs bash exit reporting (measured, four candidates, none applicable). The fallen invariant was a doc comment and a test name, both already changed in `0e1df26`.

## Consequences

- **A fifth fact means the census grows in the same commit.** Adding an input to `bash_exit_report` means `bash_exit_report_non_error_rows_are_exactly_two`'s row list **and** its `ok` vector move in the same commit as the code. A census edited to accommodate a change is not a guard; a census not grown at all is worse — it is a lie with a green check next to it.
- **`pipes_held` is a sampling-point contract, and only two tests enforce it.** Any refactor that moves the pipe read below the kill gate silently re-breaks #94, and the unit pins will not notice. The guards are `bash_pipe_held_completion_is_reported_as_success_not_a_timeout` and `bash_issue_94_repro_is_reported_as_success_not_a_timeout` — the only tests whose **assertions** depend on R1 firing (not the only ones traversing the kill and the drain; several others do that and stay green). Delete either and the latch is unprotected; delete the deterministic one because it looks like a duplicate and the latch is unprotected.
- **`bash_backgrounded_grandchild_killed_with_group` now describes a SUCCESS and its name says nothing about it.** Its name promises a group-kill proof, which it still delivers; the outcome underneath it changed. Anyone adding an `is_error` assertion there must expect `false`.
- **R5's placement is load-bearing twice:** for the `-1` ban (no code-printing row may see a `None` code) and for R1's safety (a run we killed must never reach the success row). Both arguments are in the arm comments; do not reorder for tidiness.
- **The tautological `signal.is_none()` stays in R1's guard on purpose,** as the safety argument made explicit, even though the census cannot see it go.
- **Two `PIPE_HELD_SUCCESS` literals are a permanent, intended duplication,** and the Windows one stays silent about the background process. A future reader must not "unify" them, and must not byte-pin either.
- **Follow-ups, recorded and NOT performed here** (this ADR edits exactly one file and runs no `cargo` and no `pnpm` — that is what lets it share a wave with a Rust task on the same crate, since `archimedes` is ONE compilation unit and two Rust tasks can never share a wave):
  | Follow-up | Where | Status |
  |---|---|---|
  | Scope `CONTEXT.md`'s Pipe-held completion kill clause to unix ("adds that a background process holding the pipe was killed" is the `#[cfg(unix)]` note's clause; the `#[cfg(not(unix))]` note drops it) | `CONTEXT.md` | **open**, one clause, owned by a follow-up. Not done here: `CONTEXT.md` is not this ADR's file |
  | The census doc comment lists "dropping `signal.is_none()` from the success guard" among the changes that "reddens this assert"; the implementer measured it as a **tautology** behind R5 that reddens nothing | `exec/tests/bash.rs`, `bash_exit_report_non_error_rows_are_exactly_two`'s doc comment | **open**, Rust-side, so it cannot ride this task. The shipped arm comment already carries the correct claim |
  | The escaped-group residue (a descendant that re-homed its own process group escapes the negative-pid kill while `pipes_held` is `true`, so the unix kill sentence describes an action that did not reach it) lives **only** in this ADR — no fixture reproduces it, and the action-not-fate wording is a wording defence, not a test | here | **recorded, untestable from this tree** |
  | Whether the Windows note reads *usefully* to a model (three sentences, one of them about a deadline nothing was killed for) | Windows build | **unmeasurable here** — type-checked only |
  | Re-running the three mutations on a machine that owns a Rust task | `exec/tests/bash.rs` | cheap, deliberately **not** done here (no `cargo` in this wave) |

  **The prose sweep: one finding, and the plan's pattern could not have found it.** The plan's sweep greps for the retired test *name* (`only_non_error_row`) over `*.rs`/`*.md`/`*.ts` excluding `docs/roadmap/`: **0 hits**, and the same command shape over `non_error_rows_are_exactly_two` returns **3**, so that empty result is armed and real (the roadmap's Sweep-hygiene rule — an un-armed empty sweep is UNVERIFIED, not clean). No `docs/features/*.md` mentions the bash deadline wording either (grepping that directory for "timed out" returns nothing). But a **name-based** sweep cannot see prose that restates the old invariant in words, so this ADR re-ran it on the *claim* rather than the identifier, and found one live site:

  | Site | Verdict |
  |---|---|
  | `exec/bash.rs`, the `match (code, signal)` arm's comment: "The one non-error row: the child exited 0 and we SAW it do so." | **Defensible, not obviously stale** — that comment sits *inside* the non-`timed_out` match, which really does have exactly one non-error arm, so it is locally true. Read as a claim about the whole function it is now wrong (there are two). **Recorded for a Rust-side follow-up to scope the wording** (e.g. "the one non-error row *here*"); NOT edited here, since this task runs no `cargo` |

  So the honest Consequences entry is **not** "no tracked prose sweep is implicated": it is "one prose site restates the old invariant in words and should be scoped, and it is invisible to a name-based sweep." **This Consequences entry is the durable copy** of that inventory, because the roadmap's follow-ups file is deleted on ship.
