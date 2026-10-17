---
status: accepted
date: 2026-10-17
superseded-by:
---

# The Windows child-console policy is owned by a constructor, and guarded by a source census rather than a runtime test

Every child we spawn on Windows needed `CREATE_NO_WINDOW`: the shipped build is a GUI-subsystem process (`main.rs:2`), so it has no console for a console-subsystem child (`cmd.exe`, `fd`, `rg`, an `npx.cmd` shim) to inherit, and Windows allocates a new console — and a new console *window* — for each one (`docs/research/windows-child-console-window.md`; issue #35). We decided to make `agent::childproc` the **only** place in the crate that builds a `Command` (`command()` / `command_std()`, with the flag set inside and `hide_console` kept private), and to guard it with a test that greps our own source for `Command::new(` outside that module — rather than a test that runs something and observes whether a window appeared.

The reason a runtime test is impossible here, and not merely inconvenient: `cargo test` runs as a console-subsystem process, so a child inherits the *test harness's* console whether or not the flag is set — the behaviour cannot be observed from inside it. And neither `std` nor `tokio` has a `get_creation_flags` (rust-lang/rust#96794 exists for exactly that gap), so the flag cannot even be read back off the `Command` we configured; `as_std()` does not help, because `std` has no getter either. That leaves "what the source says" as the only honest introspection, in the same spirit as `hostenv::configured_env`, which is documented as "the only honest introspection available" for the same class of reason.

## Considered Options

- **A post-hoc `hide_console(&mut cmd)` call at each site, with a test that checks each site reaches it (rejected).** It reads better — the policy is visibly applied where the command is built — but the test has to reason about control flow: prove every construction reaches the helper before its `spawn`/`output`, across the `#[cfg(unix)]`/`#[cfg(not(unix))]` pair in `exec.rs:372-384` where one tool builds two commands. A flow-parsing census is brittle, and brittle tests get deleted rather than fixed. The constructor inverts it into one dumb invariant: there is no `Command` to forget the flag on.
- **Windows CI running a release build and asserting no window appeared (rejected).** It also would not have caught the original: nothing in a headless runner can assert "no window appeared", and the shipped-vs-dev difference that hid the bug in the first place is the parent's subsystem, not the child's. It doubles Windows CI minutes to buy an assertion that cannot be written.
- **No census test — rely on review (rejected).** The bug was possible for three releases precisely because "add a spawn" has no visible obligation attached to it. A one-line grep-level test is cheaper than the review attention it replaces.
- **`DETACHED_PROCESS` instead of `CREATE_NO_WINDOW` (rejected).** Documented to make `CREATE_NO_WINDOW` *ignored* when combined with it, and it leaves the child free to `AllocConsole` later anyway. `CREATE_NO_WINDOW` is the flag whose documented meaning is the intent: "a console application that is being run without a console window".

## Consequences

- **The census test is a lint, and says so.** It proves no site bypasses the module; it does NOT prove the flag suppresses a window — that half stays verified by one manual run of the packaged `target\release\Archimedes.exe` on Windows, recorded in the spec. Anyone reading the test must not be allowed to conclude more than it shows.
- **Scanned region is production code only** — the text before each file's `#[cfg(test)]`, the same boundary the `hostenv`/`sandbox` seams already lean on. Test fixtures keep building raw `Command`s; a fixture that needs the policy opts in explicitly.
- **`creation_flags` REPLACES rather than ORs** (rust-lang/rust#96794 again). Putting the flag inside the constructor makes that survivable: a site wanting `CREATE_SUSPENDED` or `CREATE_NEW_PROCESS_GROUP` later has no `Command` to set it on except one that came from `childproc`, so the flags have to be composed there. That is the real structural win, beyond the window bug.
- **`closed_stdin` is a separate, opt-in decision, not part of the constructor**, because it is wrong for every **Runtime child**: the Worker's JSONL stdin, the MCP server's JSON-RPC stdin and `sudo_exec`'s password stdin are pipes we actively write, and nulling one is a worse bug than the one being fixed. So the module cannot be "one call does the whole policy" — the **Tool child** / **Runtime child** split is the API, and the census test asserts both halves.
- **Two GUI-subsystem spawn sites get the flag for a reason that looks like a mistake.** The `--worker` self-exec and the updater relaunch run our own exe, which in release is GUI-subsystem, where `CREATE_NO_WINDOW` is documented as ignored — so they never popped a window. They still go through the constructor, because in a *debug* build the exe is console-subsystem and the flag is live there, and because a site added later inherits the correct default. A reader who notices should find this paragraph rather than "simplify" the call away.
