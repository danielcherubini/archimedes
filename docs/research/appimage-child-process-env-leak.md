---
status: current
last-verified: 2026-10-24
verified-by: web research — 4 researcher angles (AppImage env semantics, cross-framework prior art, local spawn audit, Rust fix mechanism) + inline verification against this tree, 2026-10-16
---

# The AppImage leaks its bundled libs into every child process — and breaks `node`, `git`, `rg`, MCP servers

Research question: *Why do commands the agent runs (`node`/`tsc`, `git`, …) fail or warn when Archimedes runs as an AppImage, what is the real name of the `LD_…` variable involved, and what is the correct fix?*

Decision context: this is the reason an agent session inside the shipped Linux build reports "Node is broken in this sandbox (AppImage lib clash), so I can't run tsc". The implementation plan lives in `docs/roadmap/appimage-child-process-env-scrub.md`.

## Executive summary

The AppImage's `AppRun` puts its bundled `usr/lib` at the **front of `LD_LIBRARY_PATH`** and its `usr/bin` at the **front of `PATH`**, plus `PYTHONHOME`, `PYTHONPATH`, `GI_TYPELIB_PATH`, `PERLLIB`, `QT_PLUGIN_PATH`, `GST_PLUGIN_SYSTEM_PATH*`, `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR` and the `GTK_*` family — and the Rust runtime hands that env to **every** child by implicit inheritance. There is **zero** env handling in `src-tauri/` today: `grep -rn "LD_LIBRARY_PATH\|APPDIR\|APPIMAGE\|env_remove\|env_clear" src-tauri/src` returns **0 hits**, and all seven production spawn sites inherit blindly.

The variable the user half-remembered as `LD_LINKER_` is **`LD_LIBRARY_PATH`** (or possibly `LD_PRELOAD`). No `LD_LINKER_*` variable exists. The upstream suggestion that is easy to half-remember is the workaround idiom `env -u LD_LIBRARY_PATH <cmd>`. The condition is also the *inverse* of "not set": it is set to 20 entries that are **100% `/tmp/.mount_archim*`** on this host, and after a relaunch older entries can point at a **dead** mount.

This is a known bug class, **fixed in production by other vendors** ([GitHub Copilot App #644](https://github.com/github/app/issues/644), released v0.2.27), **acknowledged as a design error by AppImage and linuxdeploy maintainers**, filed against AppImageKit in **2018 and closed unfixed** ([#616](https://github.com/AppImage/AppImageKit/issues/616)), and **not fixed by Tauri** as of `tauri-bundler` HEAD. It is fixable in this repo with one new pure module and six call sites.

## Findings

### 1. The two symptoms have one cause and two different severities

Live, reproduced on this machine while researching (the research sandbox is itself a child of the AppImage):

```
node: /tmp/.mount_archimgAAJCI/usr/lib/libcrypto.so.3: version `OPENSSL_3.4.0' not found (required by /lib64/libnode.so.127)
git:  /tmp/.mount_archimgAAJCI/usr/lib/libpcre2-8.so.0: no version information available (required by git)
```

Scrubbing fixes both instantly: `env -u LD_LIBRARY_PATH -u PYTHONHOME -u PYTHONPATH -u GI_TYPELIB_PATH node --version` → `v22.23.1`.

**The ELF mechanism.** `ld.so` resolves a `DT_NEEDED` entry by **SONAME** first — a coarse "right library family?" gate — and *separately* verifies each `DT_VERNEED` entry against the provider's `DT_VERDEF` chain ([LSB symbol versioning](https://refspecs.linuxfoundation.org/LSB_1.3.0/gLSB/gLSB/symversion.html), [maskray: all about symbol versioning](https://maskray.me/blog/all-about-symbol-versioning)). The two checks are independent, which is why a bundled library with a *correct SONAME* still fails. The exact glibc branch is `match_symbol()` in [`elf/dl-version.c`](https://github.com/bminor/glibc/blob/master/elf/dl-version.c):

| Message | Provider has `.gnu.version_d`? | Severity |
|---|---|---|
| ``version `OPENSSL_3.2.0' not found`` | Yes, but lacks that version node | **Fatal** — non-weak reference, process dies |
| `no version information available` | **No** — no version definitions at all | **Warning only** (`return 0`) — child runs, binding symbols unversioned |

Verified against the live bundle with `readelf`:

- `/tmp/.mount_archimgAAJCI/usr/lib/libcrypto.so.3` — `SONAME libcrypto.so.3`, `RUNPATH [$ORIGIN]`, `.gnu.version_d` defines exactly `libcrypto.so.3`, `OPENSSL_3.0.0`, `OPENSSL_3.0.3`, `OPENSSL_3.0.8`, `OPENSSL_3.0.9`. System `/lib64/libssl.so.3` and `/lib64/libnode.so.127` require `OPENSSL_3.0.1`, `3.2.0`, `3.3.0`, `3.4.0`. **None present → four fatal errors.** The SONAME match is *why* the loader selected it at all.
- `/tmp/.mount_archimgAAJCI/usr/lib/libpcre2-8.so.0` — `SONAME libpcre2-8.so.0`, `.gnu.version` present, **`.gnu.version_d` absent entirely**. `/usr/bin/git` and `/usr/bin/grep` require `PCRE2_10.47`, which the *system* library defines and the bundled one cannot. → the non-fatal warning branch.
- `libssh.so.4` in the same directory independently broke `/lib64/libcurl.so.4` with ``version `LIBSSH_4_10_0' not found`` — a fourth library in the same class, so `curl` failed outright.

That directory holds **173–187 shared objects** (`libgnutls`, `libnghttp2`, `libxml2`, `libicuuc`, `libssl`, `libcrypto`, `libpcre2`, …), all of them ahead of the host's `/usr/lib64` for every child process.

**"Warning only" is not benign.** With no version definitions the child binds symbols *by name with no version constraint*, so it can silently bind an ABI it was not linked against. The identical `libpcre2-8.so.0: no version information available` line is the reported cause of hard segfaults in [digiKam 9.x on Fedora 43 (Red Hat #2452933)](https://bugzilla.redhat.com/show_bug.cgi?id=2452933) and [Kdenlive (KDE #518318)](https://bugs.kde.org/show_bug.cgi?id=518318).

### 2. Who sets the env — and it is not the AppImage runtime

The AppImage **runtime** sets four variables and nothing else — `APPIMAGE`, `ARGV0`, `APPDIR`, `OWD` ([`AppImageKit/src/runtime.c:934-943`](https://github.com/AppImage/AppImageKit/blob/master/src/runtime.c); the same four in [type2-runtime](https://github.com/AppImage/runtime)). The [spec's environment-variables page](https://docs.appimage.org/packaging-guide/environment-variables.html) documents exactly those four — scraped and grepped for `LD_LIBRARY_PATH`, `child`, `subprocess`, `unset`, `inherit`: **zero hits**.

The stack comes from **two layers the Tauri bundler ships**:

**(a) `AppRun.wrapped` — a compiled build of AppImageKit's *deprecated* `AppRun.c`.** Tauri does not use linuxdeploy's AppRun: it downloads a prebuilt `AppRun-x86_64` from `tauri-apps/binary-releases` under the release tag **`apprun-old`** and copies it straight to `AppDir/AppRun` ([`linuxdeploy.rs:152, 214`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs)). `strings` on that binary yields the literal prepend templates:

```
LD_LIBRARY_PATH=%s/usr/lib/:%s/usr/lib/i386-linux-gnu/:…:%s
PATH=%s/usr/bin/:%s/usr/sbin/:%s/usr/games/:%s/bin/:%s/sbin/:%s
PYTHONHOME=%s/usr/      PYTHONPATH=%s/usr/share/pyshared/:%s
PERLLIB=%s/usr/share/perl5/:%s      XDG_DATA_DIRS=%s/usr/share/:%s
GSETTINGS_SCHEMA_DIR=…  QT_PLUGIN_PATH=…  GST_PLUGIN_SYSTEM_PATH[_1_0]=…
PYTHONDONTWRITEBYTECODE=1
```

That is [`AppImageKit/src/AppRun.c:170-203`](https://github.com/AppImage/AppImageKit/blob/master/src/AppRun.c). It imports `getenv`/`putenv`/`execvp` and **never `unsetenv`**. Upstream considers it broken — maintainers refer to "that old, known-broken `AppRun.c`" ([PR #1103](https://github.com/AppImage/AppImageKit/pull/1103)).

**(b) `AppRun` — linuxdeploy's generated wrapper**, which `source`s `apprun-hooks/*.sh` then `exec "$this_dir"/AppRun.wrapped "$@"` ([`appdir_root_setup.cpp:267-330`](https://github.com/linuxdeploy/linuxdeploy/blob/master/src/core/appdir_root_setup.cpp)). This repo's built `AppDir/apprun-hooks/` contains exactly **one** hook — `linuxdeploy-plugin-gtk.sh` — so `gtk` is the only plugin in use (no gstreamer, no qt). Tauri `include_bytes!`s **its own fork** of that script ([`linuxdeploy-plugin-gtk.sh`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy-plugin-gtk.sh), wired at `linuxdeploy.rs:230-240`), which adds `GIO_MODULE_DIR` and comments out `GDK_BACKEND=x11`. It exports `GI_TYPELIB_PATH`, `GIO_MODULE_DIR`, `GSETTINGS_SCHEMA_DIR`, `GTK_DATA_PREFIX`, `GTK_EXE_PREFIX`, `GTK_PATH`, `GTK_IM_MODULE_FILE`, `GDK_PIXBUF_MODULE_FILE`, `GTK_THEME`, `XDG_DATA_DIRS`.

**Forensic proof of the producer.** The observed `GI_TYPELIB_PATH=/tmp/.mount_archimgAAJCI//usr/lib/girepository-1.0` has a **double slash**. That is exactly what the GTK hook's `"$APPDIR/${gi_typelibsdir/$LD_GTK_LIBRARY_PATH//usr/lib}"` substitution yields; it was reproduced byte-for-byte. So the GTK hook — not the runtime, not `AppRun.c` — is what set it.

**Upstream's own verdict is that this is an anti-pattern.**

> "None of these environment variables must be set. In fact, they're counterproductive, as **they affect all subprocesses, even calls to software on the base system**… **`LD_LIBRARY_PATH` is not needed due to linuxdeploy's `DT_RUNPATH` method.**" — TheAssassin, [linuxdeploy-plugin-qt#163](https://github.com/linuxdeploy/linuxdeploy-plugin-qt/issues/163)

> "if you use `$LD_LIBRARY_PATH`, you need to reset your environment and remove the offending value before calling subprocesses. That's been a best practice ever since in programming." — TheAssassin, [AppImageLauncher#367](https://github.com/TheAssassin/AppImageLauncher/issues/367)

The bug against exactly this behaviour was filed in January 2018 and **closed without a fix**: [AppImageKit#616 — "Restore env variables modified by AppRun when running processes outside of the AppImage"](https://github.com/AppImage/AppImageKit/issues/616). The maintainer's answer at the time was "can't you bundle that app as well?", and the required "detection whether the subprocess is bundled in the AppImage or is a system one" was never implemented.

**Why the clean fix (`DT_RUNPATH`) is being overridden anyway.** [`ld.so(8)`](https://man7.org/linux/man-pages/man8/ld.so.8.html) search order for a dependency with no slash in its name is: `DT_RPATH` (only if no `DT_RUNPATH`) → **`LD_LIBRARY_PATH`** → `DT_RUNPATH` → `/etc/ld.so.cache` → `/lib`, `/usr/lib`. This repo's binaries already carry `RUNPATH = $ORIGIN/../lib`, and the bundled libs carry `RUNPATH = $ORIGIN` — so linuxdeploy's clean design is *already in place* and the env var (priority 2) is the sole reason it loses. You cannot "just rely on RUNPATH" while the variable stays set.

### 3. The two stacked `/tmp/.mount_archim*` dirs are the updater relaunch, and they compound

`AppRun.c` builds each value as `"<appdir paths>:<inherited value>"` — **prepend, with no idempotency check and no comparison against its own previous output** — and `execv` preserves the environment. Any re-entry re-prepends.

This host is at generation 2. `/proc/mounts` shows **two live `fuse.archimedes.appimage` mounts**, and:

- `APPDIR=/tmp/.mount_archimgAAJCI` (generation 2)
- `OWD=/tmp/.mount_archimPfJcAP/usr` — pointing at **generation 1**, independent proof that generation N's env was inherited wholesale by N+1
- `LD_LIBRARY_PATH`: 20 entries, **all 20** mount paths, spread across both dirs
- `PATH`: 25 entries, 10 of them mount paths, spread across both dirs
- `XDG_DATA_DIRS` matches a two-launch model exactly (each launch contributes `<M>/usr/share/:<M>/usr/share:/usr/share`), with the untouched session value (`~/.local/share/flatpak/exports/share`) still trailing

Note the split by mutation style, which corroborates the model: the **appending** vars (`LD_LIBRARY_PATH`, `PATH`, `PYTHONPATH`, `PERLLIB`, `XDG_DATA_DIRS`) show **both** mount dirs; the **assignment** vars (`GI_TYPELIB_PATH`, `PYTHONHOME`) show **one**.

**The re-entry is Tauri's restart.** Verified against the version this tree locks (`Cargo.lock`: `tauri` **2.12.2**):

- `src-tauri/src/commands/update.rs:442` — `relaunch_app(app)` → `app.restart()`
- `tauri-2.12.2/src/app.rs:606` → `crate::process::restart(&self.env())`
- `tauri-2.12.2/src/process.rs:74-89` — `Command::new(path).args(env.args_os.iter().skip(1)).spawn(); exit(0)`. **No `env_clear`, no `env_remove`** — the child gets the parent's already-poisoned env verbatim.
- `tauri-2.12.2/src/process.rs:47-53` — on Linux `current_binary()` returns `_env.appimage`, read from `$APPIMAGE`. So the spawn target is **the `.appimage` file**, which re-enters `runtime → AppRun → AppRun.wrapped`, which prepends a second full set.

Therefore **N restarts ⇒ N+1 stacked mount prefixes**. The install itself is not the problem: `tauri-plugin-updater`'s `install_appimage` does a `std::fs::rename` onto the target, not a spawn. The leak is the **restart**.

The stale mount also keeps old entries *resolvable* until the process exits (the runtime tears the mount down via a keepalive pipe; `pipe()` is not `O_CLOEXEC`, so a descendant inheriting the write end can keep it alive) — which is why the failure is silent shadowing rather than a loud "library not found".

### 4. There is no official escape hatch

The runtime's complete flag set, from its own `print_help()` ([`runtime.c:666-695`](https://github.com/AppImage/runtime/blob/main/src/runtime/runtime.c)): `--appimage-extract`, `--appimage-extract-and-run`, `--appimage-help`, `--appimage-mount`, `--appimage-offset`, `--appimage-portable-home`, `--appimage-portable-config`, `--appimage-signature`, `--appimage-updateinfo`, `--appimage-version`. **No `--appimage-no-*` flag exists**; `--appimage-list` is a `// TODO`. Grepping both runtimes for `appimage-no`/`APPIMAGE_NO`: zero hits. Recognised env knobs are only `TMPDIR`, `TARGET_APPIMAGE`, `APPIMAGE_EXTRACT_AND_RUN`, `VERBOSE`, `NO_CLEANUP`, `FUSERMOUNT_PROG` — none suppress `AppRun`'s exports, and `--appimage-extract-and-run` still pollutes, merely changing the prefix from `/tmp/.mount_*` to `appimage_extracted_*`.

The one precedent in upstream code is appimagetool's **`run_external()`**: `fork()` → `unsetenv()` → `execv()`, merged in [AppImageKit PR #1103](https://github.com/AppImage/AppImageKit/pull/1103) with the comment *"run a command outside the current appimage, block environs like LD_LIBRARY_PATH"*. Its scrub list is **six names**: `LD_LIBRARY_PATH`, `PYTHONPATH`, `XDG_DATA_DIRS`, `PERLLIB`, `GSETTINGS_SCHEMA_DIR`, `QT_PLUGIN_PATH`. That list is **insufficient for this build** — it omits `PYTHONHOME` (which breaks any system `python3` outright), `PATH`, `GI_TYPELIB_PATH`, the `GTK_*` family and `GIO_MODULE_DIR`, and it drops whole variables rather than removing only AppImage entries, destroying legitimate user values.

### 5. Blast radius — seven production spawn sites, every one implicit-full-inherit

| Site | Binary | Why it matters |
|---|---|---|
| `src-tauri/src/agent/tools/exec.rs:367` | `sh -c <command>` | **The bash tool** — every agent command (`git`, `node`, `tsc`, `cargo`, `pnpm`). No `.env*` call in the function. `current_dir` at `:379`, Landlock `install` at `:402`, `spawn` at `:415`. |
| `src-tauri/src/agent/tools/exec.rs:374` | `cmd /C` | Windows twin; irrelevant to AppImage, same code path. |
| `src-tauri/src/agent/tools/exec.rs:1004` | `fd` | `exec_find` fast path. Bare-name lookup ⇒ depends on the poisoned `PATH`. Also never installs Landlock ⇒ unconfined even at `Shell=Sandboxed`. |
| `src-tauri/src/agent/tools/exec.rs:1194` | `rg` | `exec_grep` fast path. Native binary loading `libpcre2`/`libcrypto` — the exact failure class. |
| `src-tauri/src/agent/mcp/stdio.rs:57` | user MCP servers | `cmd.envs(&def.env)` at **`:62`** is the only env call in the crate and is documented **ADDITIVE** on top of full inheritance. stdio MCP servers are overwhelmingly `npx` / `uvx` / `node` / `python` — the most fragile victims. |
| `src-tauri/src/agent/worker/client.rs:237` | `<current_exe> --worker` | **The Agent runtime — the accumulation vector.** Exe from `src/lib.rs:32` `std::env::current_exe()`, which inside an AppImage resolves *through the mount*: `/proc/<pid>/exe` → `/tmp/.mount_archimgAAJCI/usr/bin/archimedes`. |
| `src-tauri/src/agent/interactive/sudo_exec.rs:70` | `sudo -S --` | **Highest severity.** A hijacked `LD_LIBRARY_PATH` reaching a **root** `git`/`apt`/`dnf` is a library-hijack surface, not merely a broken command. |
| `src-tauri/src/commands/update.rs:442` | the `.appimage` | The stacking source. **Not fixable here** — `app.restart()` is `-> !` with no env hook. |

Verified non-factors:

- **The Agent runtime is not Node.** No `externalBin`, no sidecar, no `shell:allow-*` capability anywhere. The Worker is a self-exec of the same Rust binary (`main.rs:6-9` checks `--worker` before Tauri init ⇒ `run_worker()`). So nothing of *ours* needs the bundled libs — the only Node involved is whatever the **user's** MCP config or shell command launches, which is precisely what we must protect.
- **`sandbox.rs:695 install()` does not touch env at all.** Its `pre_exec` is exactly `prctl(PR_SET_NO_NEW_PRIVS, 1)` then `landlock_restrict_self` (`:704-719`). Landlock is filesystem confinement (`handled_access_fs`; `handled_access_net` = 0) and has no notion of environment. It neither causes nor mitigates this: `TEMP_DIRS = ["/tmp", "/var/tmp"]` (`:287`) is `READ_WRITE` with `PATH_BENEATH`, so the mount stays reachable, and `/usr`,`/bin`,`/lib`,`/lib64` + `/etc/ld.so.cache` are granted (`:261-263`, `:297`), so a confined child loads fine — the poison survives confinement intact.
- `src/open.rs:213` delegates to `tauri_plugin_opener` ⇒ `open-5.4.4` ⇒ `xdg-open`, which inherits the same env. Real, but outside `src-tauri`.
- `agents.rs` / `skills.rs` / `mcp/manager.rs` spawn nothing. 13 test-only spawn sites exist (`exec.rs:1591/2517/2595`, `sandbox.rs:1845/1859/2018`, the `tests/*.rs` files) plus 10 test-only `WorkerHandle::spawn` calls; exactly **one** production `WorkerHandle::spawn` caller (`src/lib.rs:33`).

API census across `src-tauri/src`: `Command::new` × 14 (7 production), `.env(` **0**, `.envs(` 1 (`mcp/stdio.rs:62`), `.env_remove(` **0**, `.env_clear(` **0**, `.pre_exec(` 3 (Landlock + two `setpgid`, none env-related).

### 6. Prior art — the same bug, already fixed in production elsewhere

| Project | Mechanism | Status |
|---|---|---|
| **GitHub Copilot App** [#644](https://github.com/github/app/issues/644) — *"AppImage injects bundled libs into system git's environment"* | Sanitize `LD_LIBRARY_PATH` before spawning `git` | **Maintainer-fixed, shipped v0.2.27**: *"The AppImage was leaking its bundled library paths into git's environment… That's fixed in the latest release."* Their three stated options were sanitize-before-spawn / bundle a self-contained git / `env -i`. |
| **GitButler** (also Tauri) [PR#4748](https://github.com/gitbutlerapp/gitbutler/pull/4748) | Split on `:`, drop components containing `appimage-run` or `/tmp/.mount`, over **18 var names** | Merged Aug 2024; cited by a Tauri maintainer in tauri#10078. **Weakness:** the two substrings are hardcoded, so it silently stops working under `--appimage-extract-and-run` (`appimage_extracted_*`) — which is what #644 was running under. |
| **Onivim2** [PR#2608](https://github.com/onivim/oni2/pull/2608) / [#2040](https://github.com/onivim/oni2/issues/2040) | `AppRun` captures `ONI2_ORIG_PATH` / `ONI2_ORIG_LD_LIBRARY_PATH` **before** augmenting; the terminal launcher restores them | Merged. Cleanest save-and-restore precedent; covers only the two vars it names. |
| **vrc-get** ([#1260](https://github.com/vrc-get/vrc-get/pull/1260), anatawa12) | Remove AppDir entries from `LD_LIBRARY_PATH` | The Tauri-side workaround for `xdg-open`, quoted by a Tauri maintainer. |
| **PyInstaller** [docs](https://pyinstaller.org/en/stable/advanced-topics.html) | `LD_LIBRARY_PATH_ORIG` convention + `PYINSTALLER_RESET_ENVIRONMENT=1` | Official, and the most precisely stated algorithm: *"restoring it from `LD_LIBRARY_PATH_ORIG` (if available) or just un-setting it (if original is unavailable, which means it was not explicitly set before PyInstaller did its modifications)"*. |
| **pkgforge `anylinux.so`** [`lib/anylinux.c`](https://github.com/pkgforge-dev/Anylinux-sharun/blob/main/lib/anylinux.c) | `LD_PRELOAD` interposer on `execve/execv/execvp/execvpe/posix_spawn{,p}`; **`is_external_process()` = path not under `$APPDIR`**; unset a ~50-name blocklist **only if its value contains `$APPDIR`** | The most complete modern implementation. The name-blocklist-gated-on-value-predicate design is the key idea. |
| **`linuxdeploy-plugin-checkrt`** [`exec.so`](https://github.com/darealshinji/linuxdeploy-plugin-checkrt) | `LD_PRELOAD` hook restoring `/proc/<getppid()>/environ` for external processes | Merged 2018, opt-in (`usr/optional/exec.so`). |
| **VS Code** | Sidesteps it: no official AppImage, and `code.sh` relaunches itself as Node via `ELECTRON_RUN_AS_NODE=1` — the app's own runtime *is* the child runtime | Not a fix, an avoidance. |

**Tauri's own shipped fixes do not cover this class.** [`LINUXDEPLOY_EXCLUDED_LIBRARIES` / PR#16062](https://github.com/tauri-apps/tauri/pull/16062) (merged 2026-09-25, CLI ≥ 2.12, `;`-separated, **env-var only — `AppImageConfig` still has no `excludeLibraries` key**) and [plugins-workspace PR#2103](https://github.com/tauri-apps/plugins-workspace/pull/2103) (try `/usr/bin/xdg-open` first) both address over-bundled *display* libs and bundled *scripts*. Neither cleans the env children inherit, and **PR#2103 is unmerged at HEAD** — verified: `plugins/opener/src/open.rs:10-13` is still plain `::open::that_detached(path)`. Related open Tauri issues in the same family: [#10078](https://github.com/tauri-apps/tauri/issues/10078) (`xdg-open` broken by the env; maintainer FabianLars on the `LD_PRELOAD` route: *"I never was able to integrate them without causing even more issues (especially due to webkitgtk)"*), [#10617](https://github.com/tauri-apps/tauri/issues/10617) (bundled glib killing host Firefox), [#15976](https://github.com/tauri-apps/tauri/issues/15976), [#15665](https://github.com/tauri-apps/tauri/issues/15665).

One more documented harm worth knowing from #15665: `GST_PLUGIN_SYSTEM_PATH_1_0` pointed at a missing dir makes the bundle **rewrite the user's `~/.cache/gstreamer-1.0/registry.*.bin` as an empty registry**, breaking *other* GStreamer apps until the cache is deleted. Env pollution can outlive the process.

### 7. The fix: strip-by-containment, per child

Converging on the same design from four independent directions (GitButler, `anylinux.so`, `checkrt`, PyInstaller):

1. **Gate** on `APPDIR` set **and** `current_exe()` under it. Otherwise emit an empty patch — deb/rpm/dev builds stay byte-identical no-ops, and a user who merely *exports* `APPIMAGE` is not scrubbed. `APPDIR` is the canonical detection variable per the [spec](https://docs.appimage.org/packaging-guide/environment-variables.html); `OWD` is explicitly *not* usable (on this host it points at a dead generation).
2. **Per variable**: split on `:`, drop entries that are path-prefixes of a **mount root**, keep the rest in order. Mount roots = `$APPDIR` **∪** the ancestor dir of any entry whose basename starts with `.mount_` — the second half is what removes the stale generation, since `$APPDIR` names only one of the two.
3. **Emptied by the strip ⇒ `env_remove`, not `env("")`** — the "the runtime may have invented this variable" case, handled by construction rather than guessed.
4. **Never `env_clear()`.** [std's `Command` docs](https://doc.rust-lang.org/std/process/struct.Command.html) are explicit that removing `PATH` without a replacement makes `execvp` fall back to an OS default (typically `/bin:/usr/bin`) rather than the parent's `PATH` — silently losing `~/.cargo/bin`, `/opt/nvim`, `~/.go/bin`, `~/Android/Sdk/platform-tools`, all present here. `env_clear` + allowlist is also unusable for a general-purpose `sh -c`: the allowlist is unbounded (`SSH_AUTH_SOCK`, `CARGO_HOME`, `NVM_DIR`, `CONDA_PREFIX`, `CC/CXX`, …) and each gap is a silent, tool-specific regression.
5. **Strip empty components.** The poisoned values end in a trailing `:` — `AppRun.c`'s `%s…:%s` leaves an empty entry when the prior value was empty, and `ld.so`/`PATH` read an empty entry as **the current directory**. A real security bug, filed in 2017 and unfixed ([AppImageKit#391](https://github.com/AppImage/AppImageKit/issues/391)); the same idiom in electron-builder became [CVE-2026-54672 / GHSA-7g7r-gx96-252g](https://github.com/electron-userland/electron-builder/security/advisories/GHSA-7g7r-gx96-252g).
6. **At `mcp/stdio.rs`, scrub *before* `cmd.envs(&def.env)`** so a user's explicit MCP `env` entry still wins (std's `env` "takes precedence over inherited variables", so scrubbing after would silently discard user config).
7. **Do not scrub the main process's own env.** WebKitGTK `dlopen`s GdkPixbuf loaders and GIO modules, and `AppRun.c`'s `chdir("$APPDIR/usr")` is load-bearing because the GTK hook rewrites WebKit's `/usr` paths to be cwd-relative (`linuxdeploy-plugin-gtk.sh:400`: `sed -i -e "s|/usr|././|g"`). The AppImage maintainer's correction to FreeCAD's `del os.environ` approach is the safety rule ([#396](https://github.com/AppImage/AppImageKit/issues/396)): *"highly risky, as it alters the entire process's environment… selectively replacing any value in there pointing to the mounted AppImage is the right way."* Tauri/Wry is multi-threaded. **Per-child copies only.**

**Rejected alternatives.** `env_remove("LD_LIBRARY_PATH")` alone — ignores `PATH`/`PYTHONPATH`/`PYTHONHOME` and discards a legitimate user tail; it only *looks* loss-free here because 20/20 entries happened to be mount paths. `unsetenv` in `pre_exec` — wrong layer (std materialises the `envp` array in the parent *before* fork), violates the "two syscalls, no allocation" invariant the existing `pre_exec` closures document, and reaches only Sandboxed-on-Linux bash. An `LD_PRELOAD` exec-interposer — Tauri's maintainer tried and rejected it for webkitgtk reasons; `LD_PRELOAD` is also stripped in secure-execution mode ([`ld.so(8)`](https://man7.org/linux/man-pages/man8/ld.so.8.html)) and misses `g_spawn_async`. Patching `AppRun` via `beforeBundleCommand` — fixes the stacking but is unauditable by `cargo test` and would break the GUI; the runtime's four `setenv`s run before `AppRun` regardless. Forking Tauri's `restart` — `AGENTS.md` pins the Tauri version deliberately.

## Evidence

Highest credibility: the glibc and AppImage/linuxdeploy/Tauri **source**, read directly (line numbers cited throughout), and this machine's **live `/proc/self/environ`, `/proc/mounts`, `/proc/<pid>/exe` and `readelf` output**, reproduced three times independently. Maintainer statements (TheAssassin, FabianLars, probonopd) are strong but are comments, not normative spec text. The single strongest external validation is a **shipped vendor fix** (GitHub #644 → v0.2.27) with the same diagnosis and symptom set.

## Unresolved contradictions

1. **Is the Worker self-spawn safe to scrub?** One angle argues yes (it doesn't render, and scrubbing there stops accumulation for everything beneath it); another calls it the one judgement call, since it runs the same ELF as the app. → Field-test it. If it misbehaves, exempt the self-spawn; the `bash`/MCP/`fd`/`rg` children stay fixed either way.
2. **Stop the stacking, or contain it?** Fixing the children makes the parent's growing env harmless *to commands*, but the parent env still grows every restart. Stopping it means replacing `app.restart()` with an own scrubbing `Command` + `exit(0)` — a deliberate extra call site, not something that comes free.
3. **`PYTHONHOME` is on no upstream scrub list** (`run_external()` omits it) yet it breaks any system `python3` outright (`Fatal Python error: Failed to import encodings module`, reproduced here). Include it, and record it as our inference rather than a citation.

## Gaps

- **No public report exists** of two distinct `.mount_*` dirs accumulating across a self-update relaunch. The mechanism was reproduced deterministically and matches `tauri-2.12.2/src/process.rs` exactly, but the user-facing bug report appears not to exist. Expect to file one.
- **No framework-blessed "must preserve" list exists anywhere** — every source enumerates *strip* lists only. The preserve set (`HOME`, `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `XDG_CURRENT_DESKTOP`, `LANG`/`LC_*`, `TERM`, `SHELL`, `USER`, `TZ`, `SSH_AUTH_SOCK`, `PULSE_SERVER`, and `PATH` **filtered rather than dropped**) is reconstructed from absence, not authoritative.
- **Cert/TLS variables unverified.** `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE` appear on no list — so preserve them — but **`OPENSSL_CONF` *is* on `anylinux.so`'s strip list**. Needs a deliberate decision, not an assumption.
- **Only one test can prove the real defect** — a `bash`-tool test asserting the child sees no mount path. It is environment-sensitive: green on CI's `cargo test` path, red only on an AppImage-running box. Borrow `sandbox.rs:735-745`'s skip-visibility discipline so "nothing was tainted" is never mistaken for "the fix works".
- **Adjacent, out of scope.** (a) The AppImage ships `fake_worker` and `fake_mcp_stdio` into `usr/bin` and prepends it to `PATH` — test fixtures in the release, reachable by name from the poisoned `PATH` (`readelf`/`ls` confirmed both present). ~~(b) `exec.rs:1004` passes `--max-results` to `fd`, which is not an `fd` flag, so that fast path likely always errors and silently falls through to the `walkdir` walker.~~ **Struck 2026-10-24: measured wrong.** `--max-results` IS a real `fd` flag (`fd --max-results 10 -g a.txt -- <dir>` → exit 0 with results, fd 10.4.2), so the fast path does run — measured while fixing the cwd half of this leak (issue #81, `f571a0b`).
