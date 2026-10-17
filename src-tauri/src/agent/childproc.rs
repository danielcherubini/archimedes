//! Who owns a child process's Windows console, and its stdin.
//!
//! The shipped Windows build is a GUI-subsystem process
//! (`src/main.rs:2` — `#![cfg_attr(not(debug_assertions), windows_subsystem =
//! "windows")]`), so it has no console for a console-subsystem child
//! (`cmd.exe`, `fd`, `rg`, an `npx.cmd` shim) to inherit; Windows then
//! allocates a console per child, and creating a console creates a window —
//! one blank `cmd.exe` window per shell command. `CREATE_NO_WINDOW` is the
//! documented lever that suppresses the window; mechanism, citations and the
//! triage are in `docs/research/windows-child-console-window.md`, the choice
//! of a constructor as the owner is ADR 0060.
//!
//! Two invariants this module exists to hold:
//!
//! * **One owner for the creation flags.** `creation_flags` REPLACES rather
//!   than ORs (rust-lang/rust#96794 — there is no getter to read the previous
//!   value back), so a second caller anywhere in the crate silently un-hides
//!   the child and re-opens a window per command. That is why the flag lives in
//!   the constructor rather than at each call site, and it is why any future
//!   `CREATE_SUSPENDED` or `CREATE_NEW_PROCESS_GROUP` belongs **in this module**
//!   and nowhere else: a call site has no `Command` to set a flag on except one
//!   that came from here, so composing the flags has exactly one legal place.
//!   [`command`] / [`command_std`] are therefore the only two constructors, and
//!   [`hide`] / [`hide_tokio`] stay private.
//! * **`closed_stdin` is opt-in, never part of the constructor.** Nulling stdin
//!   is right for a **Tool child** (the Agent asked for `sh -c …`; a command
//!   that reads stdin must reach EOF rather than block on an inherited pipe
//!   until the 300 s bash timeout) and wrong for every **Runtime child** — the
//!   Worker's JSONL stdin, an MCP server's JSON-RPC stdin and `sudo_exec`'s
//!   password stdin are pipes we actively write. The Tool/Runtime split is the
//!   API, not an oversight.
//!
//! `CREATE_NO_WINDOW` is documented as ignored for a child that is not a
//! console application, so the two sites that spawn **our own exe** — the
//! `--worker` self-exec (`src/agent/worker/client.rs`) and the updater relaunch
//! (`src/commands/update.rs`) — could never pop a window in the shipped build,
//! where the exe is GUI-subsystem. They still route through here, for two
//! reasons: in a *debug* build the attribute is off and the exe is
//! console-subsystem, so the flag is live there; and a site added later
//! inherits the correct default rather than having to know this paragraph.
//! A reader who spots the apparent no-op should stop here, not "simplify" the
//! call away.
//!
//! What this module deliberately does NOT own: the environment (that is
//! [`crate::agent::hostenv`]), stdout/stderr (each site chooses those), and any
//! `STARTUPINFO`/`SW_HIDE` or `DETACHED_PROCESS` route (the former is
//! nightly-only on stable Rust; the latter is documented to make
//! `CREATE_NO_WINDOW` *ignored*, and leaves the child free to `AllocConsole`).
//!
//! Nothing here is provable by running it — `cargo test` is itself a
//! console-subsystem process, so a child inherits the test harness's console
//! whether or not the flag is set, and neither std nor tokio can read a
//! creation flag back off a `Command`. The census test in this module (Task 3)
//! is what enforces the policy: it scans `src/` for a `Command::new(` outside
//! these two constructors and fails the build on one.

/// `CREATE_NO_WINDOW` — "The process is a console application that is being
/// run without a console window" (Process Creation Flags, Win32). A bare
/// `u32`, so this needs no `windows`/`windows-sys`/`winapi` dependency.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Blanket import: the std arm needs the trait; the tokio arm resolves to
// tokio's own INHERENT `creation_flags` (tokio-1.53.1/src/process/mod.rs:675).
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

// The parameter is `_cmd` and the CALL below is unconditional on purpose: with
// a plain `cmd` and the `cfg` on the call (or on the body), the non-Windows
// build has an unused binding or an unnecessary `mut`, and
// `cargo clippy --all-targets -- -D warnings` is red on Linux CI for it.
fn hide(_cmd: &mut std::process::Command) {
    #[cfg(windows)]
    _cmd.creation_flags(CREATE_NO_WINDOW);
}

fn hide_tokio(_cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    _cmd.creation_flags(CREATE_NO_WINDOW);
}

/// The `tokio::process::Command` constructor — the only one in the crate.
///
/// Carries the child-console policy and nothing else: no `env`, no stdio
/// defaults. Pass the program exactly as you would to
/// `tokio::process::Command::new`.
pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    hide_tokio(&mut cmd);
    cmd
}

/// The `std::process::Command` constructor (the updater relaunch), with the
/// same policy as [`command`].
pub fn command_std<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    hide(&mut cmd);
    cmd
}

/// Tool children only. Cross-platform — no `cfg`.
///
/// `tokio`'s `output()` pipes stdout/stderr but NOT stdin, so without this a
/// Tool child inherits the parent's stdin handle: on the Worker that is a live
/// pipe nobody writes to, and `cat` — or `python -`, a `git credential`
/// helper, an `ssh` password prompt — blocks on it until the bash timeout
/// fires. Runtime children must NOT call this; see the module docs.
pub fn closed_stdin(cmd: &mut tokio::process::Command) {
    cmd.stdin(std::process::Stdio::null());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claim: the constant is the value Microsoft documents for
    /// `CREATE_NO_WINDOW`, written out here as an independent literal rather
    /// than restating the definition — a typo in the constant must redden this
    /// test, not be mirrored by it.
    #[test]
    fn create_no_window_is_the_documented_value() {
        assert_eq!(
            CREATE_NO_WINDOW, 0x0800_0000_u32,
            "`CREATE_NO_WINDOW` must be the documented 0x0800_0000 \
             (Process Creation Flags, Win32)"
        );
    }

    /// Claim: a Tool child built by [`command`] + [`closed_stdin`] reaches stdin
    /// EOF at once — `sh -c 'cat'` reads EOF immediately, writes nothing and
    /// exits 0, inside the 5 s wall-clock guard. `success()` is the assertion,
    /// NOT `!status.success() || …`: a null stdin makes `cat` exit 0 with empty
    /// stdout, and a negated compound would also pass on an unrelated failure.
    ///
    /// ⚠ **A regression pin, not the proof.** On a host where cargo's own stdin
    /// is already `/dev/null` — which is what a CI step gets — this test passes
    /// with OR without `closed_stdin`, because the inherited handle the call
    /// replaces is already an EOF source. It pins the SHAPE (the API exists, is
    /// cross-platform, and a child built through `childproc` still runs); it
    /// cannot pin the EFFECT. The behaviour proof is Task 3's `execute_tool`
    /// test, which drives the bash tool through a stdin a test does write to,
    /// and the policy proof is Task 3's census.
    #[tokio::test]
    async fn tool_child_reads_eof_on_closed_stdin() {
        let mut cmd = command("sh");
        closed_stdin(&mut cmd);
        cmd.args(["-c", "cat"]);
        let out = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output())
            .await
            .expect("did not time out")
            .expect("`sh` starts");
        assert!(
            out.status.success() && out.stdout.is_empty(),
            "`sh -c 'cat'` on a null stdin must exit 0 with no output, got {out:?}"
        );
    }
}
