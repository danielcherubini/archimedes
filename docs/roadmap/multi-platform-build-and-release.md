---
status: approved
done-when: A published (non-draft) GitHub Release exists whose assets install and launch on Linux (AppImage + deb) and Windows, whose `latest.json` carries one key per installed form, and an installed v0.1.0 upgrades itself in place to a throwaway v0.1.1 through the Settings updater — with `ci.yml` green for the full bar on ubuntu/windows/macos.
---

# Multi-platform build and release

The release workflow exists (`0a333d6`) and has never run: no tags, no releases, no repository
secrets. It also cannot pass as written, for two independent reasons — `bundle.createUpdaterArtifacts`
plus an embedded pubkey make `tauri build` exit 1 without `TAURI_SIGNING_PRIVATE_KEY` (the failure the
`Makefile`'s `appimage` recipe already records), and `releaseDraft: true` can never satisfy the
`releases/latest/download/latest.json` endpoint the config names, because that path serves only a
published, non-prerelease release.

The larger gap is upstream of packaging: `ci.yml` is Linux-only, so **this tag would be the first time
anyone ever compiles the Rust backend for Windows or macOS**. There are 5 `#[cfg(windows)]` sites and
57 `cfg(unix)`/`cfg(target_os = "linux")` sites in `src-tauri/src`, and `agent/tools/sandbox.rs` is
`#[cfg(target_os = "linux")]`-gated with a comment saying an unconditional declaration would break the
Windows build — evidence the intent was always to build there, never verified.

Two decisions this spec consumes: **ADR 0052** (one trailing job writes the updater manifest) and
**ADR 0053** (the updater is driven from Rust, so the capability file does not move). The terms
**Build / Upload / Publish** and **Updater manifest** are now in `CONTEXT.md` and are used here in
their exact senses.

## 1. Validation: `ci.yml` runs the full bar on three OSes

One `strategy.matrix` over `ubuntu-latest`, `windows-latest`, `macos-latest`, each running the
AGENTS.md gate on the pinned toolchain: `cargo fmt --all -- --check`, `cargo
clippy --all-targets -- -D warnings`, `cargo test`, `pnpm test`, `pnpm build`.

- The pinned-toolchain install step is carried over unchanged, including why no version is named
  there (`src-tauri/rust-toolchain.toml` is the pin) and why `shell: bash` is spelled on every OS.
- The apt prereq step stays Linux-only via a runner-condition; macOS and Windows need none.
- `on.push.branches` drops the stale `feature/archimedes-desktop` for `feature/*`.
- The macOS matrix entry is unconditional here. Validating macOS costs nothing: the repository is
  public, and public repos get unlimited macOS runner minutes. Packaging macOS is what's deferred,
  not compiling it.
- A `versions match` step (section 4) runs in this job set.

**Expect red on the first run and treat the fixups as part of this work**, not a follow-up: Windows
has never compiled this crate, and frontend tests may carry path-separator assumptions.

## 2. Release: `create-release` → `build` → `publish`

Three stages, replacing three jobs that raced. `tauri-action` moves to `@v1` in the same change: the
`{os}-{arch}-{installer}` manifest keys and `uploadWorkflowArtifacts` do not exist on `@v0`, and
`@v0` retries the manifest upload with zero delay.

**`create-release`** creates the draft once (`gh release create "$TAG" --draft --generate-notes`) and
outputs the release id. Every build job receives that id rather than racing to create its own —
`tauri-action` cannot fetch a draft by tag, so N jobs produce N drafts (upstream #914).

**`build`** is a matrix over `windows-latest` and `ubuntu-latest`, each calling `tauri-action` with
`releaseId`, **`uploadUpdaterJson: false`**, `uploadUpdaterSignatures: true` (the default), and
`uploadWorkflowArtifacts: true` as a debug escape hatch. Jobs upload installers, updater payloads and
`.sig` assets. **No build job writes `latest.json`.** A `macos-latest` row is present but gated on
signing secrets being configured, so "skip mac for now" is tested logic rather than dead YAML:
enrol later, add the row's two manifest keys, nothing else moves.

**`publish`** depends on the matrix, downloads the release's `.sig` assets, composes ONE
`latest.json`, validates it, uploads it `--clobber`, and **only then** publishes the release. One
writer, so the lost-update race cannot occur rather than being retried.

The manifest's key set, because the client tries `{os}-{arch}-{installer}` **before** `{os}-{arch}`
and the Linux payload bundler only ever signs the AppImage:

| Key | Updater payload the `url` names |
|---|---|
| `windows-x86_64`, `windows-x86_64-nsis` | `Archimedes_<ver>_x64-setup.nsis.zip` |
| `linux-x86_64`, `linux-x86_64-appimage` | `Archimedes_<ver>_amd64.AppImage.tar.gz` |
| `linux-x86_64-deb` | `Archimedes_<ver>_amd64.deb` |
| (macOS, later) `darwin-aarch64`, `darwin-x86_64` | `Archimedes.app.tar.gz` — no version in the name, and a `.dmg` is never an updater payload |

A manifest carrying only bare keys is not merely imprecise: a `.deb` install asks for
`linux-x86_64-deb`, falls through to the AppImage entry, downloads ~124 MB, verifies the signature,
and *then* fails `install_deb`'s format check with `invalid updater binary format`. Payloads must also
match what the installer sniffs — the AppImage path needs the gzipped tar, the Windows path needs the
zip (`extract()` tests `is_zip` first).

Asset names are **discovered by pattern, never hardcoded**: the arch spelling differs per bundler
(`x64` for NSIS, `amd64` for deb/AppImage) and the names carry `productName` and version, so a
hardcoded name becomes a silent "platform missing from the manifest" the first time either changes.

**Ordering is load-bearing.** Compose → validate → upload → publish, in that order. Publishing first
opens a window where clients see a new version with no manifest or a stale one.

## 3. The updater, wired for real, behind a Rust seam

The app cannot self-update today: no `tauri-plugin-updater` dependency, no capability entry, no UI, yet
the config demands signed updater artifacts. The README's "Check for updates menu item" does not exist
and there is no menu at all.

Five places change:

1. `src-tauri/Cargo.toml` — `tauri-plugin-updater = "2"`, declared with the desktop target gate (the
   crate is desktop-gated; an ungated `cargo add` is the documented mistake).
2. `src-tauri/src/lib.rs` — `.plugin(tauri_plugin_updater::Builder::new().build())`. A **builder**,
   not `init()`.
3. `src-tauri/src/commands/update.rs` — `check_update()` and `install_update()`, plus an update
   progress event. Registered in the existing `generate_handler!`.
4. `src/components/settings/UpdateSection.tsx` + a new member of `SettingsPage`'s `Section` union and
   sidebar nav, using the existing `SettingsGroupCard`/`SettingsRow` primitives.
5. `src-tauri/tauri.conf.json` — `plugins.updater.requireSignedVersion: true`. The CLI has been
   stamping the version into every signature's trusted comment all along, so adopting it now is free
   and adopting it later means re-signing every release users can still update from.

No capability change: capabilities gate only the webview→Rust boundary, so a Rust-side `check()` needs
no permission entry — the same reasoning already recorded for `tauri-plugin-notification`. And
`AppExt::restart()` exists on Tauri itself, so `tauri-plugin-process` and its `allow-exit` /
`allow-restart` are not needed.

**Three states, not two.** A `latest.json` 404 surfaces as `ReleaseNotFound` — the string "Could not
fetch a valid release JSON from the remote" — which is NOT the same as a null "up to date" result.
`check_update` therefore returns a tagged result (`UpToDate` / `Available { version, notes, pubDate }`
/ `Failed { kind, message }`) and the section renders all three distinctly. `Failed` is the first
state any tester sees, since the endpoint 404s until the first release exists; it must read as "could
not reach the update server", never as "you're up to date".

**Progress is rate-limited in Rust**, not in React. The plugin's callback fires per TCP chunk with no
coalescing, so a 124 MB AppImage is thousands of IPC events; the emit is throttled (≥100 ms or ≥1%
apart, whichever is larger) so the channel carries dozens. `contentLength` is optional, so an absent
`Content-Length` renders indeterminate rather than `NaN%`.

**Windows install never resolves** — `install_inner` calls `std::process::exit(0)` once `ShellExecuteW`
succeeds. The UI announces "Installing — this window will close" *before* awaiting, and persists
nothing afterwards it cannot afford to lose. On Linux and macOS nothing exits, so completion is an
explicit **Restart to finish** action calling `app.restart()` — deliberately not a silent relaunch,
because a Linux install can fail after a successful download.

**Nothing checks on launch.** `Builder::build()` only registers commands; auto-check would be app code
we wrote, and a shipped check cadence cannot be retracted after release. Settings is the only trigger.

Linux realities that shape the UI rather than the architecture: `install_appimage` requires the temp
dir to share a `dev()` with the AppImage, so a private/bind-mounted `/tmp` yields
`TempDirNotOnSameMountPoint`; the deb path runs `pkexec dpkg -i` → graphical password → `sudo -S`, with
no dependency resolution and an open upstream bug where the password prompt appears before checking
that `dpkg` exists. Both are failure branches the UI must render honestly.

## 4. Version, key, and how a release is cut

**Version stays in all three files** (`package.json`, `src-tauri/Cargo.toml`,
`tauri.conf.json`) and the agreement is enforced twice: AGENTS.md gains a `## Releasing` section naming
`tauri.conf.json` as the third field — the `release` skill reads AGENTS.md and applies it after
bumping and before tagging, so the skill performs that bump itself — and `ci.yml` gains an assertion
that the three values match, catching on the PR what would otherwise ship as a binary whose version
contradicts the bundle's.

**A fresh minisign keypair.** The existing `~/.archimedes/tauri-signing.key` is rotated, not reused:
nothing has ever shipped signed by it, so rotation costs nothing and its password may be lost. The
public half goes into `plugins.updater.pubkey` (replacing `CCB9CE7D353396B3`); the private half and its
password become the two repository secrets. For `tauri build`, the CLI accepts either the literal key
or a path to it, so the key goes into the secret verbatim with newlines preserved;
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional and only needed if the key is protected;
`TAURI_SIGNING_PRIVATE_KEY_PATH` is `signer sign`-only and never set. `.env` files do not work for
these variables.

**A keypair mismatch is a warning, not an error** — a rotated pubkey with a stale secret builds green
and fails only on a user's device at signature verification. So the runbook verifies the pair locally
by signing a scratch file before it tags.

Release order: CI green on `main` → the `release` skill bumps two files, then AGENTS.md's step bumps
the third → annotated tag pushed → the three stages run → verify not-a-draft, every asset present, one
manifest key per installed form.

## 5. Documentation truth-repair

`README.md` currently asserts a "Check for updates" menu item that exists nowhere, macOS "Developer ID
signed + notarized in CI" that we are not doing (and the same phrase as a `release.yml` job name), and
auto-update that the code cannot perform. These sections are rewritten to describe what the pipeline
actually does, including the key ceremony, rotation, and the sign-before-tag verification, replacing
the README's "First-release steps" list.

**Explicitly not touched here**: the README's "What it does" opening still describes the removed ACP
architecture — spawning `pi` via `pi-acp` as a subprocess, listed as a runtime prerequisite — which
ADR 0022 deleted and `CONTEXT.md` contradicts. That is pre-rewrite rot worth fixing, but rewriting an
architecture section inside a CI pull request is how a docs change escapes review. It gets its own
change.

## 6. Verification

The manifest composer lives in `scripts/` as a standalone script taking a directory of `.sig` files
plus version and tag, so it is unit-testable with fixtures instead of only observable from a release.
Assertions cover exactly the failures that are silent in the field:

- the key set above, and each key pointing at the payload type its installer can consume;
- a signature containing embedded newlines lands as legal JSON (only `jq --rawfile` does this; a
  heredoc does not, and an empty `signature` string parses fine and fails client-side at minisign);
- a missing `.sig` for an expected payload **fails**, rather than quietly dropping that platform;
- `version` carries no leading `v`, and `pub_date` is RFC 3339 — a malformed manifest is rejected
  whole by the client and looks identical to "no update available".

Rust tests cover the two places a naive port goes wrong: `ReleaseNotFound` maps to `Failed` and never
to `UpToDate`; and the coalescer's emit count stays bounded under thousands of chunk callbacks.

`release.yml` also gains a `workflow_dispatch` path with the release inputs omitted —
`tauri-action` builds and uploads nothing when no tag/release id is given — so the bundler can be
exercised on Windows and Linux without a release existing.

## 7. Non-goals

Apple Developer ID signing and notarization; Windows Authenticode (SmartScreen warnings remain the
documented category norm); distribution through apt/rpm repos, winget, or Homebrew cask; background
update checks; downgrade support; macOS universal binaries; generated changelogs; the stale ACP README
section.

## 8. Order of prerequisites before the first tag

1. Generate the keypair; set both secrets; replace the pubkey in `tauri.conf.json`.
2. Verify the pair locally by signing a scratch file (the mismatch case only warns).
3. Land the CI matrix and stabilise Windows/macOS to green.
4. Tag `v0.1.0`; then prove the update path with a throwaway `v0.1.1` against an installed `0.1.0`.

The last step is the only complete verification of the updater: a first release can prove the manifest
is reachable and parseable, but the install path is only provable from version N to N+1.
