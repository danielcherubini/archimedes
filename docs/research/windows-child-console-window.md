---
status: current
last-verified: 2026-10-17
verified-by: web research — 4 researcher angles (local spawn audit, Win32 console semantics, ecosystem precedent, report triage) + inline verification against this tree; the fix itself was implemented and validated on Linux on branch `bugfix/35-windows-child-console-window` (`d344a34`..`0c471d8`: `childproc` + the census + the `execute_tool` stdin test; cargo 1216 passed / 0 failed / 4 ignored, clippy 0 warnings, fmt clean, `pnpm test` 2054 passed, `pnpm build` ok); NO Windows runtime reproduction was possible — there is no Windows machine here, so the window-suppression half is still doc-derived, not observed
---

# Every agent shell command opens a visible CMD window on Windows

Research question: *Why does the shipped Windows build pop a new console window each time the agent runs a command, what is the exact Win32 mechanism, and what is the correct lever?*

Filed as an issue against `danielcherubini/archimedes`. Symptom reported by a user: several blank Windows Terminal windows titled `C:\WINDOWS\system32\cmd.exe` stacking up during a session.

## Executive summary

The app is a **GUI-subsystem** binary in release (`src-tauri/src/main.rs:2`), so its process has **no console to hand down**. Every child it spawns is a **console-subsystem** program (`cmd.exe`, `fd`, `rg`, an `npx.cmd` shim). Windows' documented rule is that a console child which is not "executed inside an existing console session" is **allocated a new console**, and "creating a new console results in a new console window". So: one `bash` tool call → one `cmd.exe` → one window.

**No spawn site in this crate sets a Windows creation flag.** `grep` over the whole repo for `creation_flags`, `CREATE_NO_WINDOW`, `DETACHED_PROCESS`, `STARTUPINFO` returns **0 hits**, and the app crate names no `windows`/`windows-sys`/`winapi` dependency at all. The lever that prevents it — `creation_flags(CREATE_NO_WINDOW)` (`0x0800_0000`) — exists on the exact `tokio` version we pin and has never been called.

The windows are **blank** and titled with the exe path for the same reason: `std` sets `STARTF_USESTDHANDLES` (we pipe stdout/stderr), so the new console's screen buffer is never substituted into the standard handles — the window is created *and* receives nothing. `STARTUPINFO.lpTitle` is NULL, so the title falls back to the executable name.

This is the single most-reported Windows bug class in the Rust/Tauri agent-app ecosystem and is **never** closed as wontfix. Tauri's own `shell` plugin sets `CREATE_NO_WINDOW` on every command; **we do not use that plugin**, so we do not inherit its behaviour, and we reimplemented the spawn surface without the flag.

Two consequences for triage, both verified:
- **Invisible in `tauri dev`.** The subsystem attribute is `cfg_attr(not(debug_assertions), …)`, so a dev build owns a console and children simply inherit it. CI builds Windows in **debug** only (`ci.yml:28`); `release.yml` is the only thing that ever produces the affected binary.
- **Every shipped Windows build is affected** — NSIS `Archimedes_x64-setup.exe`, v0.1.0 → v0.3.0, fresh installs and auto-updates alike.

## Findings

### 1. The rule that creates the window (Microsoft, primary)

| Claim | Source |
|---|---|
| A `IMAGE_SUBSYSTEM_WINDOWS_CUI` image *"will be allocated a console, unless it's executed inside an existing console session"*; GUI images are never allocated one and never block in a shell. | [Console Allocation Policy](https://learn.microsoft.com/en-us/windows/console/console-allocation-policy) |
| *"the system creates a new console when it starts the command processor `cmd.exe`"*; *"Creating a new console results in a new console window"*; *"GUI processes are not attached to a console when they are created."* | [Creation of a Console](https://learn.microsoft.com/en-us/windows/console/creation-of-a-console) |
| With `dwCreationFlags == 0`: *"The process inherits both the error mode of the caller and the parent's console."* | [`CreateProcessW`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw) |
| `CREATE_NO_WINDOW 0x08000000` — *"The process is a console application that is being run without a console window."* Ignored for non-console children, and ignored with `CREATE_NEW_CONSOLE` or `DETACHED_PROCESS`. | [Process Creation Flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags) |
| `"console"` subsystem: *"If a console process is run from an existing console then it will be attached to that console; otherwise a new console window will be created."* | [Rust Reference — `windows_subsystem`](https://doc.rust-lang.org/reference/runtime.html) |

`std`'s default is the degenerate branch. `library/std/src/sys/process/windows.rs` initialises `Command { flags: 0, … }` and at spawn computes `let mut flags = self.flags | c::CREATE_UNICODE_ENVIRONMENT;` — i.e. **nothing** console-related is ever passed unless the caller opts in. `self.detach` would add `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` but is *"not currently exposed in std::process"*.

### 2. Why the window is blank — and why redirecting more streams cannot help

Console allocation is decided by image subsystem + `dwCreationFlags`, with **no handle condition anywhere** in the docs. Redirection therefore does not suppress it. What redirection does do is starve the window:

- `std` sets `STARTF_USESTDHANDLES` whenever any stdio stream is non-null (`si.dwFlags |= STARTF_USESTDHANDLES` in the same file — ours always is, we pipe stdout/stderr).
- [GetStdHandle](https://learn.microsoft.com/en-us/windows/console/getstdhandle): *"standard handles are always replaced with console handles **unless `STARTF_USESTDHANDLES` was specified** during process creation."* So our pipes stay, and the new console's buffer is never wired in.
- [STARTUPINFOW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow): the screen-buffer default applies only when `STARTF_USESTDHANDLES` is absent; and a NULL `lpTitle` means *"the name of the executable file is used as the window title"*.

Net: an empty black/`cmd.exe`-titled window for the child's whole lifetime. The blankness is a *symptom of our own piping*, which is why it reads as "the window does nothing".

### 3. Our spawn surface (all sites, all unflagged)

*The table is the audit as filed, against v0.3.0; the Flag column is what shipped then. All eight production sites now come from `agent/childproc` (branch `bugfix/35-windows-child-console-window`) — see the Gaps section for what that does and does not cover.*

| Site | Child | stdio | Flag |
|---|---|---|---|
| `src-tauri/src/agent/tools/exec.rs:381` (`#[cfg(not(unix))]`) | `cmd /C <command>` | stdout+stderr piped, **stdin inherited** (`.stdin(` appears 0× in `exec.rs`) | none |
| `src/agent/tools/exec.rs:1048` / `:1243` | `fd` / `rg` (`.output()`) | stdout+stderr piped, stdin inherited | none |
| `src/agent/mcp/stdio.rs:319` | `def.command` verbatim — documented as `npx`/`uvx`/`node`, which on Windows is **`npx.cmd`** | stdin+stdout piped, stderr null | none |
| `src/agent/worker/client.rs:258` | self-exe + `--worker` | all piped; **no `kill_on_drop`** | none |
| `src/agent/interactive/sudo_exec.rs:79` | literally `sudo` — not gated off Windows (`sudo_argv.rs:117`) | all piped | none |
| `src/commands/update.rs:596` | relaunch target (`std::process::Command`) | all inherited | none |

**Not every row is a window.** `CREATE_NO_WINDOW` is documented *"ignored if the application is not a console application"*, and the self-exec runs **the same exe** — which in release is `IMAGE_SUBSYSTEM_WINDOWS_GUI`. A GUI child of a GUI parent is never allocated a console, so `worker/client.rs:258` and `update.rs:596` cannot pop a window in the shipped build. The sites that actually do are the **console-subsystem** ones: `cmd.exe`, `fd.exe`, `rg.exe`, and `npx.cmd` shims. That matches the screenshot exactly (`cmd.exe` windows, nothing else), and it closes the "which sites pop windows" question analytically rather than by reproduction. The flag still belongs on all six sites — it is *not* ignored in the debug build, where the exe is console-subsystem.

`main.rs:1-2` is the only place in the entire repo — code, docs, tests — that acknowledges console windows at all:

```rust
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
```

That attribute governs the **parent's own** console ([rust-lang/rust#90674](https://github.com/rust-lang/rust/issues/90674)). It was doing its job; nothing was ever done about the **children's**. `tauri-build` 2.7.2 and `tauri-winres` never set a subsystem — the attribute is user-authored template boilerplate, so no dependency will ever fix the child side for us.

`tokio::process::Command` **does** expose the lever: the pinned `tokio-1.53.1` has `pub fn creation_flags(&mut self, flags: u32)` inside `cfg_windows!` at `tokio/src/process/mod.rs:675`, delegating straight to `std`. It is a **setter, not an OR** — a later call by any wrapper silently clobbers it ([rust-lang/rust#96794](https://github.com/rust-lang/rust/issues/96794) tracks the missing `current_creation_flags`).

### 4. Frequency, and the second window source

One `bash` tool call is one window (`exec.rs:381`, reached from `agent/harness/loop.rs:1659`). MCP stdio clients spawn **once per server per session** (`manager.rs:137` memoises `ensure_connected`) but re-spawn after an exit or a turn-cancel, plus a fresh one per Settings → Test click (`manager.rs:306`), and every subagent dispatch owns its own `McpManager`. A `.cmd`/`.bat` shim is *itself* a `cmd.exe` invocation, so an `npx`-based MCP server can cost two windows per spawn. There is **no** `.cmd`/`.bat`/`PATHEXT` handling anywhere in `src-tauri/src` (grep: 0 hits).

### 5. Precedent — the same bug, everywhere, fixed the same way

| Ref | Outcome |
|---|---|
| [Clawdmeter#228](https://github.com/HermannBjorgvin/Clawdmeter/issues/228) (Tauri 2, closed) | The template. *"Because the app is a GUI-subsystem process, Windows gives each `reg.exe` its own console, and with Windows Terminal as the default terminal each one opens (and closes) a visible window."* Fixed with `creation_flags(0x0800_0000)`. |
| [tauri#13230](https://github.com/tauri-apps/tauri/issues/13230) (closed) | User blamed `windows_subsystem`; FabianLars pointed at un-flagged `Command`s; *"i forgot one Command in my functions 😅 … terminal disappear"*. Dev clean, build flashing. |
| [tauri#8591](https://github.com/tauri-apps/tauri/issues/8591), [plugins-workspace#2135](https://github.com/tauri-apps/plugins-workspace/issues/2135) (open) | The shell plugin **hardcodes** `CREATE_NO_WINDOW` — [`plugins/shell/src/process/mod.rs:228`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs#L228) — and #2135 asks for an option to turn it *off*. Tauri core itself (`App::restart`) does not set it. |
| [openhuman#7895](https://github.com/tinyhumansai/openhuman/issues/7895), [opencode#52281](https://github.com/anomalyco/opencode/issues/52281), [codex#48023](https://github.com/openai/codex/issues/48023), [dreamcontext#424](https://github.com/meanllbrl/dreamcontext/issues/424) | Coding agents with the verbatim symptom ("every tool call opens a new visible PowerShell/cmd window"; 100+ windows per burst; `npx.cmd` shims). |

The Rust idiom is a small `#[cfg(windows)]` helper — [Codex `background_command`](https://github.com/openai/codex/blob/main/codex-rs/utils/process/src/lib.rs#L11-L17), [Zed `crates/util/src/command.rs:38`](https://github.com/zed-industries/zed/blob/main/crates/util/src/command.rs#L38), [WezTerm `spawn-funcs`](https://github.com/wez/wezterm/blob/main/lua-api-crates/spawn-funcs/src/lib.rs#L41), [Lapce `dap.rs:172`](https://github.com/lapce/lapce/blob/master/lapce-proxy/src/plugin/dap.rs#L172). There is **no** maintained crate for this (`no_window_cmd` does not exist on crates.io — it is ~10 lines vendored by folklore into ~30 Tauri repos). Five other runtimes expose a *named* API for the same intent: Node `windowsHide`, CPython `STARTF_USESHOWWINDOW`+`SW_HIDE`, Go `SysProcAttr.HideWindow`, .NET `CreateNoWindow`. Hiding the child window is standard practice, not a hack.

### 6. Residual risks the fix must respect

- `CREATE_NO_WINDOW` gives a **windowless console**, not a console-less child. A child that calls `AllocConsole` still gets a window ([AllocConsole](https://learn.microsoft.com/en-us/windows/console/allocconsole)); `cmd /c start …` starts a new window regardless (`/b` is the documented no-window variant).
- Do **not** reach for `DETACHED_PROCESS` instead: it suppresses `CREATE_NO_WINDOW` (documented ignore), and leaves the child free to `AllocConsole` later. `CREATE_NEW_PROCESS_GROUP` is orthogonal and disables CTRL+C group-wide via an implicit `SetConsoleCtrlHandler(NULL, TRUE)`.
- `creation_flags` is a **replace**, so a central helper must own it (Codex documents exactly this constraint in its own comment).
- A hidden child is an **invisible** child: anything waiting on stdin now deadlocks behind nothing. `exec_bash` currently leaves stdin *inherited*, so the confined tier and any interactive child need deciding alongside the flag.
- Reported in the wild (secondary source, low confidence): `CREATE_NO_WINDOW` under a **write-restricted token** can fail the child at loader init (`0xC0000142` `STATUS_DLL_INIT_FAILED`). Our confined tier **fails closed off-Linux** (`exec.rs:400`), so there is no Windows sandbox today for it to bite — but it becomes live the day Windows confinement lands.

## Evidence

Credibility: Microsoft Learn (primary) for §1–2; Rust `std`/`tokio` shipped source for §3; upstream issue threads and vendor source for §5. The prior-art load-bearing citations (Tauri `:228`, Codex, Deno `:660`, Go `:392`, CPython `:1700`, GHSA-q455-m56c-85mh) were re-fetched during research.

Repo facts, verified against `8cb499c` (v0.3.0):
- `grep -rn "creation_flags\|CREATE_NO_WINDOW\|DETACHED_PROCESS\|STARTUPINFO" .` → **0 hits** (excluding `node_modules`, `target`, `dist`).
- `Cargo.lock`: `archimedes` names no `windows`/`windows-sys`/`winapi`; all three are present transitively via `tauri`/`wry`/`tokio`/`mio`.
- `ci.yml:28` runs `windows-latest` in **debug**; `release.yml:112` ships Windows **release**, `nsis` target. `tauri.conf.json` has no `bundle.windows` key, so no manifest override is involved.
- `tauri-plugin-shell` is not a dependency (`package.json`, `capabilities/default.json`) — nothing else can be setting the flag.
- Releases: v0.3.0 (Latest), v0.2.0, v0.1.1, v0.1.0, each with `Archimedes_<ver>_x64-setup.exe`. No MSI. Updater live (`plugins.updater.pubkey` committed), so installed bases auto-update within the affected range.
- No existing issue/PR/commit matches `cmd|console|CREATE_NO_WINDOW|subsystem` — this is a new report.

## Gaps / what remains unknown

Written before any code existed; each item now carries **CLOSED** or **REMAINS**
as of the fix branch (`d344a34`..`0c471d8`, 2026-10-17, still un-merged at the
time of writing). Three closed — one of them **analytically** rather than
experimentally, and the bullet says which, because that distinction is the whole
reason this doc is worth keeping next to the ADR.

- **REMAINS — no Windows machine was available: nothing here is a runtime reproduction.** The mechanism is doc-derived and the code absence is grep-verified, and the fix now exists in source on the branch, but no window was observed being suppressed on real hardware. The one check that settles it is still owed: a Windows run of the packaged **release** bundle — the artifact `release.yml` builds via `tauri-apps/tauri-action` (a dev build owns a console and hides the whole bug) — issuing one shell command and confirming no window appears.
- **CLOSED (analytically) — which sites pop windows: the GUI-vs-console-subsystem question for the two GUI-subsystem sites.** `CREATE_NO_WINDOW` is documented *"ignored if the application is not a console application"*, and both the `--worker` self-exec (`worker/client.rs`, `build_command_with`) and the updater relaunch target **our own exe**, which in release is `IMAGE_SUBSYSTEM_WINDOWS_GUI` — a GUI child of a GUI parent is never allocated a console, so neither could ever have popped a window. That settles the question without hardware, and the screenshot corroborates it: `cmd.exe` windows and nothing else. Both sites still route through `childproc` anyway (the flag is live in a debug build, where the attribute is off), which ADR 0060 records so nobody "simplifies" the call away.
- **CLOSED — the inherited-stdin hang, and it turned out to be observable on Linux after all.** The Worker's stdin is piped and never closed (`worker/client.rs`, `WorkerHandle::spawn` — the writer task owns the `BufWriter<ChildStdin>` for the Worker's whole life), and `exec.rs` never set the shell child's stdin, so a stdin-reading command (`cat`, `python -`, `git credential`, an `ssh` password prompt) **hung to the tool timeout on every platform**, silently; `output()` pipes stdout/stderr **only** (`tokio-1.53.1/src/process/mod.rs:1065-1072`), leaving stdin inherited. Tool children now get `childproc::closed_stdin` — stdin at EOF, cross-platform, deliberately not applied to Runtime children, whose stdin is a pipe we write. The proof is a real behaviour test, not a pin: `exec.rs::tests::bash_without_stdin_reaches_eof_instead_of_the_deadline` drives `execute_tool(.. "bash", {"command":"cat","timeout_ms":2000})` and was observed RED first — 2.00 s, `exitCode: null`, `isError: true`, "The command timed out and was killed at its deadline." — and passes in 0.00 s with the fix. (Task 1's `sh`+`closed_stdin` unit test is only a shape pin: it passes on any host whose cargo stdin is already `/dev/null`, so it cannot show the effect.)
- **REMAINS — whether the reporter's windows flash-and-vanish** (every upstream analogue) **or linger.** Lingering would implicate a different half of the surface: Windows has **no process-group kill** (`exec.rs:758` is an explicit no-op arm) and `worker/client.rs` sets no `kill_on_drop`, so a grandchild is still unreapable. The flag does not touch either, so a lingering-window report against the fixed build would be a *new* finding, not this bug.
- **REMAINS — the MCP `.cmd`-shim path is inferred, not observed.** `sudo_exec` is moot (no `sudo` on Windows) and `worker`/`relaunch` are settled above; a `npx`/`uvx` MCP server is a `cmd.exe` invocation one level deeper and is the one site where the window count per spawn (one, or two per spawn through the shim) is still arithmetic rather than observation.
- **CLOSED — "no runtime test can observe this fix", and what was done instead.** Still true that `cargo test` is itself a console-subsystem process so a console child inherits the harness's console either way, that neither `std` nor `tokio` has a `get_creation_flags` ([rust-lang/rust#96794](https://github.com/rust-lang/rust/issues/96794)), and that Windows CI runs the **debug** profile so CI never sees the shipped subsystem. The static/source-level test that paragraph called for now exists: the census in `agent/childproc.rs` (`production_source_has_exactly_one_child_constructor`) walks `src/**/*.rs`, ignores comment lines and everything after `#[cfg(test)]`, and asserts no `Command::new(` and no `.creation_flags(` outside the module, that every `childproc::command(` in `exec.rs` reaches a `closed_stdin` before its `spawn()`/`output()`, and that no Runtime-child file mentions `closed_stdin` at all — behind a vacuity guard on the census's own eyesight (≥ 8 constructor calls in ≥ 4 files, ≥ 1 of them `command_std`; on this tree it reports 8 in 5 across 113 files). Its failure modes were each observed by planting a violation: a raw `Command::new("true")` in `exec_find` reddens invariant A naming `agent/tools/exec.rs:1015`, a planted `.creation_flags(` reddens B, the absence of `closed_stdin` reddens C, and a corrupted match string fires the vacuity guard. **It is a lint: it proves no site bypasses the owner, not that the flag suppresses a window.**
- **NEW, and permanent for as long as `app.restart()` is used — on non-Linux the updater relaunch does NOT go through our seam.** `commands/update.rs`'s owned spawn `relaunch_through_the_mount` is `#[cfg(target_os = "linux")]` (the attribute at `:553`, the `fn` at `:554`), and its only caller is the `#[cfg(target_os = "linux")]` block inside `relaunch_app` (`:666-671`), so on Windows and macOS `relaunch_app` falls through to `app.restart()` (`:672`) → `tauri::process::restart`, whose spawn is Tauri's own **unflagged** `Command::new(path).args(env.args_os.iter().skip(1)).spawn()` (`tauri-2.12.2/src/process.rs:83`; reached either directly from `app.rs:606-610` or from the `RuntimeRunEvent::Exit` arm at `app.rs:1453-1454`). It is harmless today for the documented GUI-subsystem reason above — the relaunch target is our own exe, where the flag would be ignored — and on macOS Tauri may not even reach that line (`restart_macos_app`, `process.rs:91-159`, prefers `/usr/bin/open -n` via LaunchServices, or a `process_group(0)` + null-stdio spawn). But it means **"every spawn comes from `childproc`" is a statement about OUR SOURCE TEXT, not about every process the app starts on Windows**, and the census cannot see it because the spawn is upstream code. Fixing it means replacing `app.restart()`, which is ADR 0053's territory, not this bug's.
- **REMAINS — Windows-Terminal-as-default-terminal (Win11 22H2+, WT ≥ 1.15) changes which process draws** the console, not whether one is created; Microsoft documents no flash-vs-linger behaviour for short-lived children, and upstream reproduced on both conhost and WT. So the default terminal is **not** a discriminator for whether the fix worked — worth asking the reporter for, worth nothing for the fix.
- **REMAINS — the reporter's own confirmation.** Their app version and OS build are still unknown (all four shipped versions are in range), and nobody has yet watched the fixed build behave.

## Related, deliberately filed separately

`exec.rs:381` passes the model's entire command string as a single `.arg()` to `cmd /C`. `Command::arg`'s contract — "passed as-is, not evaluated by a shell" — is **false for `cmd.exe`**, which is why std's batch escaping was exploitable twice ([CVE-2024-24576](https://github.com/rust-lang/rust/security/advisories/GHSA-q455-m56c-85mh), CVE-2024-43402) and why `raw_arg`'s own docs suggest a temp `.bat` over a complex `cmd /c` tail. Our tests already concede the consequence: `exec.rs:1873-1879` says the command line *"does not even parse as written"* under `cmd /C`, and four test groups are `#[cfg(unix)]`-gated because of it. Industry uses `/D /S /C` (+ `raw_arg`, + `is_cmd_exe()` ordering care) — pnpm, Zed, VS Code's `copilot_shim`. That is a correctness/injection issue, not a window issue; the fixes are adjacent but must not be conflated.
