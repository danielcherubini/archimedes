# Archimedes Desktop

A cross-platform (Windows / macOS / Linux) desktop app, built with
[Tauri 2](https://tauri.app), that connects to coding agents over the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com). Pi is the
first-class agent in v1; other ACP agents follow.

See [CONTEXT.md](CONTEXT.md) for the project's language and terminology.

## What it does

- Spawns ACP-speaking agent processes as subprocesses and speaks stdio
  JSON-RPC with them. The default agent is `pi` (via `pi-acp`); the
  space's folder is the conversation's working directory.
- Presents **spaces** — each space is a folder; your conversations live
  inside spaces, and the agent's file access is sandboxed to the space's
  folder.
- Multiple conversations can be live at once — starting a conversation
  in another space does not pause the current one (both keep running;
  a closed conversation stays resumable).
- Streams the conversation: agent text, tool calls, and file diffs.
- Permission prompts: the agent asks before each tool call; you approve
  or deny in the UI.
- Conversations survive restarts — history is persisted in a local SQLite
  database and can be resumed.
- Auto-update: **Settings → Updates** checks GitHub Releases when you ask it
  to (nothing checks on launch), and every update is minisign-verified before
  it is installed.

## Prerequisites

**Building:**

- Rust — the version is pinned in `src-tauri/rust-toolchain.toml`; rustup
  installs it automatically when you run `cargo` from `src-tauri/`
- Node.js ≥ 22.19 and [pnpm](https://pnpm.io)
- Platform system dependencies:
  - **Linux:** `libwebkit2gtk-4.1-dev` (webkit2gtk 4.1),
    `libappindicator3-dev`, `librsvg2-dev`, `patchelf`, `xdg-utils`
    (Debian/Ubuntu names; on Fedora: `webkit2gtk4.1-devel`,
    `gtk3-devel`, `librsvg2-devel`, `patchelf`, `xdg-utils`)
  - **macOS:** Xcode command-line tools
  - **Windows:** the [Windows prerequisites](https://tauri.app/start/prerequisites/)
    (WebView2, MSVC build tools)

**Running (the app needs an ACP agent on PATH):**

- `pi` — the coding agent
- `pi-acp` — the ACP adapter that wraps pi

## Getting started

```sh
pnpm install
pnpm tauri dev
```

## Building installers

```sh
pnpm tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`:

| Platform | Bundles |
| -------- | ------- |
| macOS    | `.app` + `.dmg` — **not shipped yet**: pipeline ready, gated on the `APPLE_*` signing secrets (the matrix rows and their gate are in `release.yml`, commented out; see Releasing) |
| Windows  | `.exe` (NSIS; unsigned in v1 — expect SmartScreen warnings) |
| Linux    | `.AppImage` + `.deb` + `.rpm` |

With `createUpdaterArtifacts` enabled (it is, in `tauri.conf.json`), each build
also writes a `.sig` minisign signature beside every artifact — and on Windows
and Linux **the installer itself is the updater payload**. There is no second
file: `tauri-plugin-updater` decides the format by sniffing the downloaded bytes
(`infer`), never by the URL's extension, so a raw `…_x64-setup.exe`, `.AppImage`,
`.deb` or `.rpm` installs perfectly well from an update, and that is the shape
`createUpdaterArtifacts: true` produces on purpose. Only **macOS** needs a
distinct payload — `Archimedes.app.tar.gz`, which the bundler always writes
alongside the `.app`; a `.dmg` gets no `.sig` at all and is never an updater
payload. You may see `…_x64-setup.nsis.zip` and `…_amd64.AppImage.tar.gz` named
in older notes here: those are the deprecated
`createUpdaterArtifacts: "v1Compatible"` artifacts, which this project has never
shipped — **their absence from a release is normal, not a broken build.** A
local build without the signing key refuses to bundle for that reason; use
`pnpm tauri build --no-sign` (see Releasing).

## Auto-update

What exists today: **Settings → Updates** has a manual **Check for updates**
button, and that button is the only thing that ever asks the update server —
nothing checks on launch, nothing downloads without a click, and there is no
menu item (this app defines no menu).

The whole flow is Rust-side (ADR 0053). `tauri-plugin-updater` is registered
in `src-tauri/src/lib.rs` and driven by three of our own commands
(`check_update` / `install_update` / `relaunch_app`) plus one event
(`update://progress`) in `src-tauri/src/commands/update.rs`; the webview holds
no updater or restart permission and `src-tauri/capabilities/default.json`
carries no updater entry. That layer owns the three things a JS port would get
wrong: a check has **three** outcomes (current / newer / could-not-ask — a 404
on `latest.json` is the last one, never "up to date"), the plugin's per-TCP-chunk
progress callback is rate-limited before it reaches the UI, and Windows'
install never returns (the process exits when the installer starts), so the UI
announces the closing window before awaiting.

Updates are signed per artifact with minisign and verified against the public
key in `tauri.conf.json` (`plugins.updater.pubkey`) before anything is
installed; `requireSignedVersion` is on, so a manifest cannot announce a
version newer than the one the signature binds. The client reads one manifest
— `latest.json` at
`https://github.com/danielcherubini/archimedes-desktop/releases/latest/download/latest.json`,
the published release's own download path — and that file carries one key per
installed form (`windows-x86_64`, `windows-x86_64-nsis`, `linux-x86_64`,
`linux-x86_64-appimage`, `linux-x86_64-deb`, and `darwin-*` once macOS
shipping happens), each pointing at the payload the installer on that device
can actually consume. CI composes it in one writer (`release.yml`'s `publish`
job + `scripts/compose-updater-manifest.sh`) and publishes it **last**, because
`/releases/latest/download/` serves only a published, non-prerelease release —
publish first and every installed client sees a version whose manifest is not
there yet.

## Releasing

The version lives in **three** files (`package.json`, `src-tauri/Cargo.toml`,
`src-tauri/tauri.conf.json`) and CI fails any PR where they disagree
(`scripts/check-versions.sh`, run by the `scripts` job); AGENTS.md's
`## Releasing` section is the skill-executable version of the same rule. The
order a release actually takes:

**skill version bump (all three files) → tag `vX.Y.Z` → `release.yml` creates
the DRAFT → the Windows and Linux builds upload their bundles and `.sig`s →
the `publish` job generates the release notes (`scripts/release-notes.sh`) and
applies them to the still-draft release, then composes and uploads
`latest.json`, and only then flips the draft to published.** A draft is not a
shipped release — it 404s from the updater endpoint.

Notes are generated from GitHub's own generator, which is why the release page
and the in-app "update available" line both say something: the app reads the
`notes` field of `latest.json` (the plugin exposes it as `update.body`), so a
release body alone would never reach a device. The workflow's notes step is
`continue-on-error` on purpose — a release whose notes failed still ships, on
the placeholder — so AGENTS.md's final step is the human pass: generate, rewrite
into human-facing prose, apply, and refresh `latest.json`'s `notes` to match.

Before the first tag, the signing key has to exist. This is the ceremony; the
password-touching steps are run by a human in their own terminal.

1. Generate the updater keypair:

   ```sh
   pnpm tauri signer generate -w ~/.archimedes/archimedes-updater.key
   ```

   The password you choose becomes `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Lose
   either half and nothing you build afterwards can ever be updated by
   anything already installed.

2. Put the **entire** contents of `~/.archimedes/archimedes-updater.key.pub`
   (one base64 string, newlines and all) into `plugins.updater.pubkey` in
   `src-tauri/tauri.conf.json`. That file is committed — it is the public half,
   and it is what every installed client verifies against.

3. Set the two secrets, feeding the **whole private key file** so its newlines
   survive:

   ```sh
   gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.archimedes/archimedes-updater.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # prompts
   ```

   Secrets, not `.env` files: CI reads them from the repository's secret store,
   and nothing in this repo may contain a private key — `git grep` for the
   private key file's own header string (excluding `docs/`) must come back
   empty; the committed `.pub` is a different, public string.

4. **Verify the pair before tagging**, because a keypair MISMATCH is
   warn-only in CI — tauri-cli logs it and keeps bundling, so CI will happily
   publish signatures nobody can verify:

   ```sh
   # the password really decrypts this key (a wrong one fails here):
   TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.archimedes/archimedes-updater.key)" \
   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… \
     pnpm tauri signer sign some-scratch-file
   # and that key's PUBLIC half is the one the config commits — both lines
   # below decode to `untrusted comment: minisign public key: <ID>` and the two
   # ids must be identical:
   base64 -d ~/.archimedes/archimedes-updater.key.pub | head -n1
   jq -r .plugins.updater.pubkey src-tauri/tauri.conf.json | base64 -d | head -n1
   ```

   The signature's own TEXT carries no key id — `signer sign`'s untrusted
   comment says only `signature from tauri secret key` — but the base64
   SIGNATURE LINE below it embeds it, so the full statement "this password,
   this key, this committed pubkey are one set" is checkable end to end:

   ```sh
   # the key id inside the signature (bytes 2..9 of the decoded signature
   # line, little-endian) must equal the pubkey id above, byte-reversed:
   sed -n 2p some-scratch-file.sig | base64 -d | od -An -tx1 | head -n1
   # e.g. pubkey id 2C0BB905F9BAB271 shows there as `71 b2 ba f9 05 b9 0b 2c`.
   ```

   (This is how the rotation was actually verified; a mismatch here means the
   signatures CI publishes will never verify against the committed pubkey,
   and CI's warn-only check will not stop it.)

5. Tag `vX.Y.Z` on a green `main`. The workflow builds Windows and Linux;
   **macOS is skipped silently while `APPLE_ID` / `APPLE_PASSWORD` /
   `APPLE_TEAM_ID` are absent** — the matrix rows and the step gate are already
   in `release.yml`, commented, with the re-enable checklist beside them, so a
   missing macOS asset means "no Apple secrets", not "the build failed".

6. Prove the release before believing it: install the built version, then bump
   to a throwaway patch version, release that, and confirm the installed copy
   offers and applies the upgrade in place through Settings → Updates. A
   manifest that is wrong in some quiet way is indistinguishable to a user
   from "no update available".

**Local unsigned builds** use `pnpm tauri build --no-sign`: the flag
short-circuits before the signing key is read, and the observable effect is
that no `.sig` files are produced (which is what CI asserts in its
build-only `workflow_dispatch` mode). The Makefile's `appimage` recipe keeps
its `--config '{"bundle":{"createUpdaterArtifacts":false}}` overlay as the
local-only path.

## Linux rendering: the DMABUF environment variables

WebKitGTK's DMABUF path is where Linux rendering goes wrong. It is not one
switch and it is not the same fix per vendor, so pick the row that matches
your GPU — and set **only one**.

| GPU | What it does here | Variable |
|---|---|---|
| NVIDIA | Turns the DMABUF renderer off entirely — the failure on this driver is a crash, so it needs the blunt switch | `WEBKIT_DISABLE_DMABUF_RENDERER=1` |
| AMD / Intel | Keeps the accelerated renderer and drops only the zero-copy hardware buffer import — the lighter fix, so try it first on Mesa | `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` |

If neither is enough on Mesa, `WEBKIT_DISABLE_DMABUF_RENDERER=1` is the
fallback — it subsumes `FORCE_SHM` (see below).

```sh
# NVIDIA
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./Archimedes_0.1.1_amd64.AppImage

# AMD / Intel
WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 ./Archimedes_0.1.1_amd64.AppImage
```

(`make install-appimage` puts the bundle at `~/AppImages/archimedes.appimage`,
which is the name the desktop entry runs — substitute whichever path you
actually launch.)

### Why two, and why never both

WebKit decides the renderer's buffer transport once per process, in
`AcceleratedBackingStore::rendererBufferTransportMode()`
(`WebKit/WebKit`, `Source/WebKit/UIProcess/gtk/AcceleratedBackingStore.cpp`),
and the two variables are a **hierarchy, not a choice of equals**:

```cpp
const char* disableDMABuf = getenv("WEBKIT_DISABLE_DMABUF_RENDERER");
if (disableDMABuf && g_strcmp0(disableDMABuf, "0"))
    return;                  // transport mode stays EMPTY: the DMABUF
                             // renderer never runs at all
...
mode.add(RendererBufferTransportMode::SharedMemory);
const char* forceSHM = getenv("WEBKIT_DMABUF_RENDERER_FORCE_SHM");
if (forceSHM && g_strcmp0(forceSHM, "0"))
    return;                  // SharedMemory only — no Hardware transport
...
mode.add(RendererBufferTransportMode::Hardware);
```

So `FORCE_SHM` is the surgical one: the accelerated renderer stays on and
only the zero-copy *hardware* buffer import is dropped, buffers going over
shared memory instead. `DISABLE` is the blunt one: it returns before
`SharedMemory` is even added, turning the whole accelerated backing store
off. It has to be that coarse on NVIDIA, where the failure is a crash
rather than a stutter.

And because `DISABLE` is read first and returns, **setting it silently
makes `FORCE_SHM` dead code** — that is the one combination worth
remembering when a workaround "doesn't take".

Two details from those same lines, both easy to get wrong:

* **Any value except the literal string `0` counts as set — including an
  empty one.** `g_strcmp0("", "0")` is non-zero, so
  `WEBKIT_DISABLE_DMABUF_RENDERER=` *enables* the workaround. To turn one
  off, say so: `=0`.
* The mode is resolved behind a `std::once_flag`, once per UI process, at
  first use. Exporting the variable from a *running* session and then
  launching the app works; changing it "live" does not.

### Setting it for the desktop, not just a shell

A `~/`-shell export reaches nothing: a double-clicked desktop entry, a
launcher, or an autostart entry inherits the *session* environment, not your
`.bashrc`. For a global setting use the systemd user session — this reaches
AppImage, `.deb`, `.rpm` and a launcher start alike:

```sh
mkdir -p ~/.config/environment.d
echo 'WEBKIT_DMABUF_RENDERER_FORCE_SHM=1' >> ~/.config/environment.d/archimedes.conf
```

`~/.config/environment.d/*.conf` is read by systemd's
`30-systemd-environment-d-generator` and exported into the user manager, so
everything the session starts afterwards — including `gnome-shell` itself —
inherits it. It applies on the **next login**, not immediately, so a window
that is already open keeps whatever environment it started with.

Verify from a fresh terminal that a launcher-started app would actually see
it, rather than assuming:

```sh
systemctl --user show-environment | grep WEBKIT
```

If that prints nothing after a re-login, the variable is only in your
terminal's environment and a desktop-launch window will not have it.

### When you are debugging a rendering bug on Linux

Reproduce with *neither* variable set before filing anything: the
workarounds mask the class of bug the report is about. Then note which one
you had set, and whether `=0` on it changes the behaviour — that answer
locates the fault in the hardware-transport path or below it.

### Building AppImages on recent Fedora

On recent Fedora releases (41+), the AppImage bundling step can fail with
`failed to run linuxdeploy`: the old `strip` bundled inside the
linuxdeploy AppImage cannot parse the newer `.relr.dyn` ELF sections in
system libraries. Build with `NO_STRIP=1` to skip the (optimization-only)
strip pass:

```sh
NO_STRIP=1 pnpm tauri build
```

This only affects the local AppImage; CI (Ubuntu) is unaffected.

## Development

- `pnpm dev` — Vite dev server
- `pnpm tauri dev` — full app in dev mode
- `pnpm test` — frontend tests (Vitest)
- `cargo test` (in `src-tauri/`) — Rust tests
- CI (`.github/workflows/ci.yml`) runs fmt, clippy (`--all-targets`), and
  both test suites on every push/PR, on the toolchain pinned in
  `src-tauri/rust-toolchain.toml`.

## Diagnostics

Everything the app writes for diagnosis — plus its database — lives in ONE
directory: the platform data directory, plus `archimedes`.

| Platform | Directory |
|---|---|
| Windows | `%APPDATA%\archimedes` (i.e. `C:\Users\<you>\AppData\Roaming\archimedes`) |
| Linux | `~/.local/share/archimedes` (or `$XDG_DATA_HOME/archimedes`) |
| macOS | `~/Library/Application Support/archimedes` |

On Windows the directory comes from the shell's Roaming app-data folder
(`SHGetKnownFolderPath(FOLDERID_RoamingAppData)`), which **ignores the
`%APPDATA%` variable** — so if you have redirected `APPDATA`, the path above is
still where the files are, and the Roaming path is the only instruction worth
giving a supporter (ADR 0025 records the same fact as the reason a test-side
redirect cannot exist on Windows). On Windows and macOS this is also where
`settings.json` lives, because `dirs` resolves the config dir to the same base as
the data dir there; on Linux settings are separate (`~/.config/archimedes`).

What is in there:

- **`supervisor.log`** (+ **`supervisor.log.old`**) — the protocol log: Worker
  lifecycle (spawn / ready / exit / crash), the raw Worker IPC lines, and every
  rejected session command as `ipc <name> FAILED: <sentence>`. It rotates by
  size: past **5 MB** the current file is renamed to `.old` (overwriting the old
  one) and a fresh file starts. **This file only exists if you asked for it** —
  see the switch below. (The `ipc … FAILED:` lines exist only from the build that
  added them — a log from an older release has the lifecycle and protocol lines
  and no record of a rejected command.)
- **`crash-<timestamp>-<tag>-<pid>.log`** — one file per **panic**, from the panic
  hook, holding the panic message, its `file:line:column` and a backtrace, kept
  for **30 days** and at most **50 files**. `<tag>` is `supervisor` (the app
  process) or `worker` (one session's process); `<pid>` is the process that wrote
  it. A panic on ANY thread of either process writes one, so the file proves a
  panic happened — not that the app died or that a session's Worker died. In short:
  `crash-*.log` is the crash trail, `supervisor.log` is the running story, and a
  healthy session writes the second and none of the first.
- **`archimedes.db`** — the SQLite database (sessions, messages, Spaces). Not a
  log; do not send it as one, it contains your conversation text.

### Turning the log on

`ARCHIMEDES_DEBUG=1`. It is read **once, at startup** — set it **before starting
the app**, then restart. Setting it while the app runs does nothing, and with the
variable unset **no log file is created at all**: nothing is written during a
normal run. Only the exact value `1` enables it.

```sh
# Linux / macOS — launch it from a shell, so the variable is in its environment
ARCHIMEDES_DEBUG=1 <the app binary or AppImage>
```

```powershell
# Windows PowerShell — set it, then launch the app from this same session
$env:ARCHIMEDES_DEBUG = "1"
Start-Process Archimedes
```

What matters is only that the variable is already in the environment the app
process inherits; the launch route does not. An icon launched from a desktop
shell may not inherit a variable you exported in a terminal, so if the log stays
missing, run the installed binary directly from a terminal where you have set it
— that form always works.

Then reproduce the problem and read (or attach) `supervisor.log`. If you are
reporting a failure you saw on screen, the log contains that same sentence,
character for character — the app logs exactly what it prints.

Two things worth knowing when you are the person being handed these files:

- **On Windows the release build has no console** (it is a GUI-subsystem binary —
  `windows_subsystem = "windows"`), so a panic prints nowhere and
  `crash-*-supervisor-<pid>.log` is the only trace one leaves. A dev build has a
  console on every platform, so there the panic text also appears in the terminal.
- **Older crash logs have no pid in the name.** v0.3.0 and v0.3.1 wrote
  `crash-<timestamp>-<tag>.log`; the pid suffix arrived in v0.3.2. Both shapes are
  real crash logs, the retention rule matches both, and crash attribution still
  recognises the pid-less one — so search the directory for `crash-*.log`, not for
  the pid-stamped shape alone, or you will tell someone their own file does not
  exist.

The envelope a rejected command carries over IPC — and why the sentence in it is
written in Rust, not in the UI — is ADR 0063.

