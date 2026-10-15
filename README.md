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
| Linux    | `.AppImage` + `.deb` |

With `createUpdaterArtifacts` enabled (it is, in `tauri.conf.json`), each
build also writes the updater payload next to the installer —
`…_x64-setup.nsis.zip` on Windows, `…_amd64.AppImage.tar.gz` on Linux — plus a
`.sig` minisign signature for **every** artifact. A local build without the
signing key refuses to bundle for that reason; use `pnpm tauri build
--no-sign` (see Releasing).

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
the `publish` job composes and uploads `latest.json`, and only then flips the
draft to published.** A draft is not a shipped release — it 404s from the
updater endpoint.

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

## Linux + NVIDIA note

On Linux with an NVIDIA GPU, WebKitGTK's DMABUF zero-copy path is broken —
the app either crashes on startup or renders with visible lag. Archimedes
works around it by setting `WEBKIT_DISABLE_DMABUF_RENDERER=1` itself before
the WebView is created, so there is nothing to export and nothing to
configure.

That default is overridable, because the same flag costs Mesa (Intel/AMD)
users a rendering downgrade where DMABUF is the fast path: any value you
set yourself wins, including an empty one.

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=0 ./Archimedes\ Desktop.AppImage   # back to zero-copy
```

If a future webkit2gtk build fixes NVIDIA, that is the escape hatch — and
the one to try first when a Linux rendering bug report looks renderer-related.

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
