---
status: committed
done-when: A published (non-draft) GitHub Release exists whose assets install and launch on Linux (AppImage + deb) and Windows, whose `latest.json` carries one key per installed form, and an installed v0.1.0 upgrades itself in place to a throwaway v0.1.1 through the Settings updater — with `ci.yml` green for the full bar on ubuntu/windows/macos.
---

# Multi-platform build and release — Plan

**Goal:** Make a tag produce a published, installable, self-updating release for Linux and Windows (macOS packaging gated on signing secrets), and make CI compile everything on all three OSes first.

**Architecture:** `ci.yml` becomes a three-OS matrix running the AGENTS.md bar. `release.yml` becomes `create-release` → `build` matrix → a single `publish` job that composes the one updater manifest (`latest.json`) from the draft release's `.sig` assets and publishes LAST (ADR 0052). The auto-updater is wired for real but driven entirely from Rust behind two commands + one event, so `capabilities/default.json` never changes (ADR 0053). The manifest composer and the version-match check are plain scripts under `scripts/`, unit-tested like any other code — a malformed manifest is indistinguishable to a user from "no update available".

**Tech Stack:** GitHub Actions (`tauri-apps/tauri-action@v1`, `gh`, `jq`), Tauri 2.12 + `tauri-plugin-updater` 2, React 19 + vitest, bash + jq for the scripts.

**Conventions for every task:** Rust commands run from `src-tauri/` (the pinned toolchain resolves from there — AGENTS.md); frontend commands from the repo root. The merge bar is `cargo fmt --check`, `cargo clippy --all-targets` (0 warnings), `cargo test`, `pnpm test`, `pnpm build`. Branch per gitflow (`feature/<desc>` off `main`); commits within the branch, squash-merge at the end.

**Evidence this plan stands on** (verified against this tree, the vendored crates, the tauri-action `v1.0.0` source, and a two-reviewer pass — the executing agent does not re-litigate; items marked ⚠ are traps a naive reading falls into):

- The plugin's Linux `extract_path` is the executable **itself** (`tauri-plugin-updater-2.12.0/src/updater.rs:379-383`), so AppImage in-place update needs no `executable_path($APPIMAGE)` workaround.
- The updater resolves `{os}-{arch}-{installer}` **before** `{os}-{arch}` (`get_urls`), and on Linux the updater PAYLOAD is built from the AppImage only (`updater_bundle.rs:87-111`); the `.deb` also gets a `.sig` over the deb itself (`tauri-cli bundle.rs:247-260`). So the manifest carries per-installer keys, and each key's `url` names the payload the installer on that device can consume: AppImage keys → `…AppImage.tar.gz` (falling back to the bare `.AppImage` pair); Windows keys → `…-setup.nsis.zip` (Windows `extract()` sniffs `is_zip` first); macOS (future) → `Archimedes.app.tar.gz` (no version in the name; a `.dmg` is never an updater payload).
- ⚠ **Windows install never returns**: `install_inner` calls `std::process::exit(0)` right after `ShellExecuteW` succeeds (`#[cfg(windows)]`, documented at `updater.rs` "Windows: This function exits the app…").
- ⚠ A non-2xx (e.g. 404) from the update endpoint is SWALLOWED and falls through to `Error::ReleaseNotFound` ("Could not fetch a valid release JSON from the remote") — the Error carries NO status code (`updater.rs:552-574`). A 204 means "up to date" (`Ok(None)`). "Up to date" and "server broken" are different states and the UI must render them apart.
- ⚠ Download progress fires per TCP chunk with no coalescing (`updater.rs:735` in 2.12.0; `:886` in 2.14.0). The callback is `FnMut(usize, Option<u64>)` — **this chunk's byte count** (NOT cumulative) and `content_length` (NOT a running total). A 124 MB AppImage is thousands of frames.
- `tauri build` refuses to bundle with a pubkey configured and no `TAURI_SIGNING_PRIVATE_KEY` ("A public key has been found, but no private key…", `tauri-cli bundle.rs:288-290`) — and a keypair MISMATCH is only a `log::warn!` (`bundle.rs:313-317`). `--no-sign` short-circuits before the key is read (the observable effect: NO `.sig` files are produced — assert on that, not on a log string).
- A `.sig` file's content is base64 with an embedded newline; only `jq --rawfile` encodes it legally into JSON.
- ⚠ `GET /repos/…/releases/latest/download/…` serves only a PUBLISHED, non-prerelease release (404 otherwise) — hence publish-last ordering everywhere in this plan.
- ⚠ **GitHub Actions context rules** (both cost a failed release run if guessed): `secrets` is NOT available in `jobs.<job>.if` or step `if` expressions — the documented workaround is a job/step `env:` (which CAN read `secrets`) referenced as `${{ env.X }}` in a STEP `if`. A JOB-level `if` runs BEFORE the matrix is applied and `matrix.include` entries have NO `if:` key. `needs:` is not expressible per-event: a skipped `needs` target skips its dependents unless they carry `if: always() && …`. `needs.<skipped-job>.outputs.x` evaluates to empty string.
- `tauri-action@v1` (= tag `v1.0.0`): given `releaseId` it uploads assets and never creates/edits the release, so `releaseDraft`/`releaseName`/`releaseBody` are IGNORED — do not set them (dead YAML). The step REQUIRES `GITHUB_TOKEN` in its `env:` (throws `GITHUB_TOKEN is required` when absent — pass it explicitly). ⚠ `projectPath` must NOT be set: the action resolves the CLI by looking for `@tauri-apps/cli` in `package.json` **at `projectPath`** with no upward search — `projectPath: src-tauri` (which has no package.json) would force a floating global CLI install, exactly the AGENTS.md violation; with the default root path it detects the pinned `@tauri-apps/cli` 2.12.2 and auto-discovers `src-tauri/tauri.conf.json` by glob. Omitting `tagName`/`releaseId`/`releaseName` entirely = "build, upload nothing" (verified in `index.ts`), which is the `workflow_dispatch` mode — but it PASSES GREEN even with zero artifacts, so the dispatch job must assert bundle files exist.
- Cargo facts (checked in the lock): `reqwest` 0.12.28 and **0.13.5 are both already locked** (0.13 is `tauri` 2.12.2's own dep), and the plugin wants `reqwest = "0.13"` → unifies, no third copy. Plugin wants `tauri = "2"`-range ≥2.10/2.12 → the locked tauri 2.12.2 satisfies it, so `cargo add` must NOT bump tauri (verify the lock diff — AGENTS.md pins the CLI to the tauri version). New-but-not-duplicated crates arrive: `minisign-verify`, `zip` (Windows), `tar` (unix), `rustls-platform-verifier` (via reqwest 0.13's `rustls-no-provider`).
- ⚠ The plugin's `Error` enum is `#[non_exhaustive]` and its variant names are NOT what intuition suggests — the authoritative list is `~/.cargo/registry/src/*/tauri-plugin-updater-*/src/error.rs` (read it in Task 5): `ReleaseNotFound`, `EmptyEndpoints`, `Network(String)` (carries any status text), `Reqwest`, `Serialization`, `Semver`, `UrlParse`, `TargetNotFound(String)`, `TargetsNotFound(Vec<String>)`, `UnsupportedOs`, `UnsupportedArch`, `Io`, `Extract` (Windows+zip), `AuthenticationFailed`, `DebInstallFailed`, `PackageInstallFailed`, `InvalidUpdaterFormat`, `SignedVersionMismatch { signed, announced }`, `MissingSignedVersion`. There is NO `FailedToDownloadEndpoint`/`NetworkError`/`UpdateAlreadyDownloaded`/`Parse`/`Download`/`Install`.
- ⚠ `Update.date` is `Option<time::OffsetDateTime>`, NOT a string — `.map(|d| d.to_string())` when mapping into the DTO. `Update.body` is `Option<String>`; `version: String`. `check()` returns `Result<Option<Update>>`; `UpdaterExt::updater()` exists; the plugin registers via `Builder::new().build()` (there is no `init()`).
- `requireSignedVersion` is honored only by plugin **≥ 2.12** (older silently ignores it — check the resolved version in Cargo.lock after `cargo add`).
- ⚠ `src-tauri/tauri.conf.json:48`'s updater endpoint points at `danielcherubini/archimedes` — **the wrong repo** (it is `danielcherubini/archimedes-desktop`; README's "Done" claim about it is false). Every installed client would 404 forever. Task 5 fixes it.
- Repo facts: no `scripts/` dir; thin invoke wrappers in `src/lib/tauri.ts` (`listenSessionUpdate` at `:926` is the listen pattern) and `src/lib/version.ts` (`getAppInfo`); `SettingsPage.tsx:39` holds the `Section` union and `:441-448` renders sections via a NESTED TERNARY (extend carefully, keep clippy/lint clean); `SettingsPage.test.tsx:67` mocks `@/lib/version`; vitest (vite.config.ts `test:`) is jsdom+globals with **no setupFiles** — no jest-dom matchers unless one is added, and none is; commands return `Result<T, String>` with typed `kebab-case:detail` refusal strings (`commands/open.rs` is the style exemplar, its test-module comment the style exemplar for "what these tests do NOT do"); `src-tauri/src/commands/mod.rs` declares submodules alphabetically (`pub mod update;` slots after `spaces`); `lib.rs:268` ends the plugin chain at `tauri_plugin_notification::init()` just before `generate_handler!` at `:269`; `src-tauri/tests/ipc.rs:100` builds its OWN private `generate_handler!` — do not extend it for plugin commands; `agent/tools.rs:8-12` is the "unconditional declaration breaks the Windows build" cfg-gating precedent; `src-tauri/src/agent/tools/sandbox.rs` is Linux-only by that gate.
- CI/Actions platform facts: public repo ⇒ standard GitHub-hosted macOS runners are FREE (verified in GitHub's billing docs; larger-sized runners are NOT free); `ubuntu-latest` = 24.04 and its webkit2gtk-**4.1** packages exist (ci.yml already proves the install today); `gh release download` works on drafts, has no `--draft` flag, and needs `--clobber` for re-runs; `gh release edit --draft=false --latest` is valid (`--latest` redundant but real); `gh release create` on a not-yet-pushed tag needs `--target`/`--verify-tag`.
- Artifact naming: assets are uploaded under the CLI's own names — Linux `${productName}_${version}_${arch}.{AppImage,AppImage.tar.gz,deb}` + each `.sig`, Windows `${productName}_${version}_x64-setup.{exe,nsis.zip}` + `.sig`, `productName` = `Archimedes`. ⚠ The `.deb` name is derived through Debian-package-name normalization — do NOT trust the guess; Task 8 records the REAL first-build names and Task 2's key derivation is pattern-based (never full-filename-equality), so a naming surprise degrades to a loud "unrecognized .sig" failure, not a wrong manifest.

---

### Task 1: Version-match script + shell-script test harness, wired into ci.yml

**Context:** The version lives in three files (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`). The `release` skill's version-detection table knows the first two, so the third can silently ship the old value; a CI assertion catches the mismatch on the PR that introduces it (AGENTS.md's `## Releasing` step — Task 6 — makes the skill bump it too). This task creates `scripts/` and the bash-test convention Task 2 reuses, and adds the ubuntu-only `scripts` CI job that runs both test scripts.

**Files:**
- Create: `scripts/check-versions.sh`
- Create: `scripts/check-versions.test.sh`
- Modify: `.github/workflows/ci.yml` (add a `scripts` job)
- Test: the two `.test.sh` files are the tests

**What to implement:**
- `scripts/check-versions.sh`: usage `check-versions.sh [repo-root]` (default `.`). Read the version from `package.json` (`jq -r .version`), `src-tauri/Cargo.toml` (`sed -n 's/^version = "\([^"]*\)".*/\1/p' | head -n1` — first match is `[package] version` at line 3; dependency lines are `name = "…"` form and cannot match — verified against the real file), and `src-tauri/tauri.conf.json` (`jq -r .version`). All three present and string-equal → exit 0 printing `versions match: X`. Any mismatch → print all three values, each prefixed by its file, exit 1. Missing file or empty extraction → distinct error naming the file, exit 1. Guard `command -v jq` with a clear message (jq is preinstalled on ubuntu runners and present locally).
- `scripts/check-versions.test.sh`: plain-bash driver (no vitest — these are shell scripts): `set -euo pipefail`, tiny `assert_eq` helper, temp trees under `mktemp -d` cleaned on EXIT. MINIMAL fixtures (a `package.json` + `src-tauri/Cargo.toml` + `src-tauri/tauri.conf.json` each containing only a version). Cases: all-match passes; `package.json` differs → exit 1 and its value appears in output; `tauri.conf.json` differs → exit 1; missing `tauri.conf.json` → exit 1 naming it; then the REAL-tree case: run against the repo root (derive from the test script's own dir) and assert exit 0 — this is what guards the real tree today.
- `.github/workflows/ci.yml`: add a `scripts` job, `runs-on: ubuntu-latest`, steps: checkout, `bash scripts/check-versions.test.sh`, `bash scripts/check-versions.sh`. No pnpm/node setup (jq only).

**Deliberately NOT changed:** the version VALUES (all stay 0.1.0); `tauri.conf.json`; AGENTS.md (Task 6).

**Steps:**
- [ ] Write `scripts/check-versions.test.sh` (five cases); run `bash scripts/check-versions.test.sh` → FAILS (no `check-versions.sh` yet).
- [ ] Implement `scripts/check-versions.sh`; re-run → all pass.
- [ ] Add the `scripts` job to `.github/workflows/ci.yml`; sanity-check YAML parses (`npx --yes yaml-lint .github/workflows/ci.yml` or a python+pyyaml one-liner; if neither is available locally, rely on the PR's CI run as the parse check).
- [ ] Commit: `ci: fail when the three version fields disagree`

**Acceptance criteria:**
- [ ] `bash scripts/check-versions.test.sh` exits 0; mutating any fixture version makes it exit 1.
- [ ] Against the real tree it exits 0 (all three say 0.1.0).
- [ ] ci.yml's `scripts` job runs both scripts and nothing else.

---

### Task 2: The updater-manifest composer (`scripts/compose-updater-manifest.sh`) + tests

**Context:** Three build jobs on one tag all want to write the same `latest.json`; `tauri-action`'s merge is an unguarded read-modify-write, so the pipeline gives it to exactly ONE trailing writer instead (ADR 0052). The composer must be a standalone script — a heredoc inside YAML cannot be unit-tested, and every failure mode here (one-platform manifest, empty signature, non-RFC3339 `pub_date`, `v`-prefixed version) is silent to CI and fatal on the user's device. A `.sig` is base64 with an embedded newline, so JSON encoding goes through `jq --rawfile` and nothing else.

**Files:**
- Create: `scripts/compose-updater-manifest.sh`
- Create: `scripts/compose-updater-manifest.test.sh`
- Test: the test script IS the test (runs in the Task 1 `scripts` CI job — extend that job with `bash scripts/compose-updater-manifest.test.sh`)

**What to implement:**
- `compose-updater-manifest.sh` — args: `--sigs-dir DIR --version X.Y.Z --tag v… --repo owner/name --out latest.json [--notes TEXT] [--arch darwin-arm64|darwin-x64]` (the `--arch` flag decides which `darwin-*` key an `*.app.tar.gz.sig` maps to; WITHOUT it a darwin sig is unrecognized → fail. This is deliberate: the file name carries no version/arch, so two universal-job archs would collide — the script refuses to guess). Behavior:
  1. Validate: `--version` matches `^[0-9]+\.[0-9]+\.[0-9]+$` (REJECT a leading `v`); `--tag` non-empty; `--sigs-dir` exists and holds ≥1 `.sig`, else fail loudly (a manifest with no platform is the exact failure ADR 0052 exists to prevent).
  2. Derive `{platform-key → payload-file}` from each `*.sig` by **pattern** (strip `.sig`; match suffixes, never whole names):
     - `…_x64-setup.nsis.zip` → `windows-x86_64-nsis`
     - `…_amd64.AppImage` (no further suffix) → `linux-x86_64-appimage`
     - `…_amd64.deb` → `linux-x86_64-deb`
     - `…_amd64.AppImage.tar.gz` → NOT its own key (its content is the same payload the appimage key names — see rule 3's payload choice)
     - `…​.app.tar.gz` → `darwin-aarch64` or `darwin-x86_64` per `--arch`; without `--arch` → unrecognized
     - anything else → **fail** ("unrecognized signature", name it) — fail-loud beats a silently-absent platform.
  3. Bare keys, each pointing at its platform's canonical updater payload, REQUIRING the referenced pair's sig to exist:
     - `windows-x86_64` → same payload as `-nsis` (`…_x64-setup.nsis.zip` + its sig).
     - `linux-x86_64` and `linux-x86_64-appimage` → prefer the `…_amd64.AppImage.tar.gz` + `…AppImage.tar.gz.sig` pair (the plugin's Linux installer unzips the tar; `content-length` and the verify path line up with what `install_appimage` extracts); fall back to the bare `…_amd64.AppImage` pair when no tar.gz sig exists; NEITHER → exit 1 naming the AppImage. (A bare key is what makes a deb install fall through — rule 3 guarantees it exists before a `-deb` key is emitted.)
     - `linux-x86_64-deb` → the `.deb` + its sig. Only emitted when the bare Linux key also resolved.
  4. Every `.sig` on disk must be referenced by ≥1 key OR be the alternate AppImage form superseded by rule 3's preference (allow-list exactly that one case; document it in the script); any other orphan → exit 1.
  5. Emit with `jq -n` + `--rawfile` per signature: `{"version": V, "notes": N, "pub_date": $(date -u +%Y-%m-%dT%H:%M:%SZ), "platforms": { KEY: {"signature": <file contents, trailing newline trimmed>, "url": "https://github.com/REPO/releases/download/TAG/PAYLOAD"} }}`. URL is TAG-pinned (not `/releases/latest/download/`) so a manifest can never point at a future release's asset.
  6. Self-validate before finishing: re-read `--out` with `jq -e` — `version` has no `v`; `pub_date` matches `^[0-9]{4}-…T…Z$`; every `signature` non-empty; every `url` starts `https://github.com/REPO/releases/download/TAG/`; ≥1 platform. Any failure → exit 1 and `rm -f --out` if it was written.
- `compose-updater-manifest.test.sh` — same bash-driver convention as Task 1. FAKE sig contents (arbitrary bytes; one fixture deliberately contains an embedded newline — the real shape). Named cases:
  1. Windows+Linux fixture set (`Archimedes_0.2.0_x64-setup.nsis.zip.sig`, `Archimedes_0.2.0_amd64.AppImage.tar.gz.sig`, `Archimedes_0.2.0_amd64.AppImage.sig`, `Archimedes_0.2.0_amd64.deb.sig`) → exit 0 and `jq -r '.platforms|keys|sort|join(" ")'` equals exactly `linux-x86_64 linux-x86_64-appimage linux-x86_64-deb windows-x86_64 windows-x86_64-nsis`.
  2. URL cross-check: bare + `-appimage` keys → the `.AppImage.tar.gz` asset; `-deb` → the `.deb`; nsis keys → the `.nsis.zip`.
  3. Newline-in-signature round-trip: emitted `signature` equals the fixture bytes (trailing newline stripped) — the case a heredoc gets wrong.
  4. Only the bare `.AppImage.sig` (no tar.gz sig) → exit 0, bare + appimage keys point at the bare `.AppImage`.
  5. No AppImage sig at all, deb sig present → exit 1 naming the AppImage; assert the `--out` file does NOT exist.
  6. Unrecognized `weird.txt.sig` → exit 1.
  7. `Archimedes.app.tar.gz.sig` WITHOUT `--arch` → exit 1; WITH `--arch darwin-arm64` → a `darwin-aarch64` key appears (and the Windows/Linux set still composes alongside it).
  8. `--version v0.2.0` → exit 1; empty `--sigs-dir` → exit 1.
  9. `pub_date` regex + `version` no-`v` + every url tag-pinned, asserted via jq on the emitted file.

**Deliberately NOT changed:** `release.yml` (Task 4 consumes this); any Rust/frontend file.

**Steps:**
- [ ] Write `compose-updater-manifest.test.sh` (all 9 cases) → run → FAILS (composer missing).
- [ ] Implement `compose-updater-manifest.sh` → re-run → all pass.
- [ ] Extend the ci.yml `scripts` job with the new test line → commit: `ci: single-writer updater-manifest composer with tests`

**Acceptance criteria:**
- [ ] All 9 cases pass locally.
- [ ] `jq empty` accepts every emitted fixture manifest.
- [ ] No `--out` file survives a validation failure (case 5 asserts it).

---

### Task 3: CI three-OS matrix + stabilize Windows and macOS to green

**Context:** `ci.yml` is Linux-only, so the first release tag would be the first-ever Windows/macOS compile of `src-tauri`. The `#[cfg]` hygiene reads as deliberate (`agent/tools.rs:8-12` gates the Landlock `sandbox` module with a comment that an unconditional declaration breaks Windows; unix-only test helpers sit inside `#[cfg(unix)]` test fns) but "compiles on Windows" has never been executed. The repo is PUBLIC, so standard macOS runners cost nothing (verified: free for public repos; only larger-sized runners are charged). Full AGENTS.md bar on every OS. Stabilization is IN scope; expect red on the first push and fix in-commit.

**Files:**
- Modify: `.github/workflows/ci.yml` (matrix)
- Modify: whatever `src-tauri/**` and `src/**` files the Windows/macOS compile/test failures name (classes below; do not pre-guess beyond them)
- Test: CI itself (push + PR both run the matrix)

**What to implement:**
- Keep the job NAME and step ORDER (the pinned-toolchain install step and its full comment block carry over verbatim — AGENTS.md explains why no version is named and why `shell: bash` is spelled for every OS). `runs-on: ${{ matrix.os }}` over `ubuntu-latest` / `windows-latest` / `macos-latest`; `fail-fast: false`.
- The "Install Linux build dependencies" step gains `if: runner.os == 'linux'`. Every other step is OS-agnostic already.
- Fix `on.push.branches` to `[main, feature/*]` (the stale `feature/archimedes-desktop` entry is dead).
- `pnpm install --frozen-lockfile` unchanged on all OSes (the lockfile is cross-platform).
- Likely stabilization classes — fix what actually appears:
  - Rust: unix-only imports escaping non-cfg'd code — the sanctioned shape is `agent/tools.rs`'s (`#[cfg(...)] mod`/`use`, or a per-OS fallback). `arboard`'s wayland feature is runtime-gated; keep Cargo deps unconditional unless a compile error proves otherwise.
  - Rust TESTS: `#[cfg(unix)]` on anything using `std::os::unix::*` / symlink / mode bits (many already have it). NEVER weaken an assertion to make an OS pass — gate the test or write the honest Windows expectation.
  - Tests that shell out (`sh -c` etc.) → `cfg(unix)`-gate or route through the per-OS exec path.
  - Frontend (jsdom is OS-independent): only real path assumptions break (e.g. `src/lib/paths*` expectations) — parameterize by platform semantics, do not delete coverage.
  - Slowness: if a Windows runner is merely slow, raise THAT test's deadline with a comment; do not reduce work under test.
- **Do not pin `macos-14`-style labels** (deprecated upstream); `macos-latest` only, and never a `macos-latest-xlarge`-class runner (charged even on public repos).

**Steps:**
- [ ] Rewrite `ci.yml` as the matrix (keep the `scripts` job from Task 1).
- [ ] Push the branch; `gh run watch` / poll `gh run list --json status,conclusion`.
- [ ] For each failure: reproduce locally where possible (`cargo test --test <name> <filter>` from `src-tauri/`), fix, push, re-run, until all three OS jobs are green.
- [ ] `cargo fmt --all` + `cargo clippy --all-targets` clean before each push (they run on all three OSes).
- [ ] Commit(s): `ci: validate the full bar on windows and macOS, and fix what it finds`

**Acceptance criteria:**
- [ ] CI green on the PR: `lint-test-build` on ubuntu + windows + macos, `scripts` green.
- [ ] No test deleted or weakened to get there (cfg-gating is fine; asserting less is not — call out any genuine Windows behavior difference in the commit message).
- [ ] `on.push.branches` includes `feature/*`, not the dead branch.

---

### Task 4: `release.yml` — draft-first, per-OS build jobs, single publish writer

**Context:** Today's release workflow is three parallel `tauri-action` jobs each with `includeUpdaterJson: true`: they race on the draft release (upstream #914 — the action can't fetch a draft by tag, so each creates its own), race on `latest.json` (ADR 0052), and their `releaseDraft: true` end-state could NEVER satisfy the `/releases/latest/download/` updater endpoint (drafts 404 by definition). This task rebuilds it as create → build → publish and moves to `@v1` (input names, per-installer key awareness, retry-with-delay). macOS keeps a PRESENT-BUT-COMMENTED matrix row: today the mac package is skipped for want of `APPLE_*` secrets, and the shape that gate must take is spelled out below because the obvious YAML is invalid (see Evidence: `secrets` is not a context in `if:`; job-level `if` precedes the matrix; matrix rows have no `if:`).

**Files:**
- Modify: `.github/workflows/release.yml` (full rewrite into three stages)
- Test: `workflow_dispatch` build-only mode (below); the real rehearsal is Task 8.

**What to implement:**
- `on:` keeps `push.tags: ["v*.*.*"]` and ADDS `workflow_dispatch` with optional input `tag`. `concurrency: group: release-${{ github.ref }}` with **`cancel-in-progress: false` EXPLICIT** (a mid-upload cancel would strand a half-populated draft — the re-tag flow in Task 8 leans on this). Top-level `permissions: contents: write`.
- **`create-release` job** (ubuntu; `if: github.event_name == 'push'`):
  - checkout with `fetch-depth: 0`; run `bash scripts/check-versions.sh` (refuse to cut a release whose version files disagree); resolve `TAG=${{ github.ref_name }}`.
  - Idempotency: `gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --draft --verify-tag --title "Archimedes $TAG" --notes "Archimedes $TAG"` (`--verify-tag` fails loudly if the tag is gone — the re-tag race; `--notes` non-empty so the published release is not an empty page; task 8 may extend notes later — do NOT edit release body afterwards).
  - Output `tag` AND `release-id` (`gh release view "$TAG" --json databaseId -q .databaseId`).
- **`build` job** (`needs: create-release` — unconditional; `if: always() && (github.event_name == 'workflow_dispatch' || needs.create-release.result == 'success')` — REQUIRED: a skipped `needs` target would otherwise skip `build` silently on dispatch):
  - Matrix `include`: `{ os: windows-latest, args: "" }`, `{ os: ubuntu-latest, args: "" }`. **`ubuntu-latest` matches ci.yml's runner deliberately** — validate and ship on one glibc baseline (the shipped AppImage's minimum glibc is the BUILD runner's; there is no auto-compat magic). The macOS rows are kept in the file COMMENTED OUT, each with its `args: --target aarch64-apple-darwin` / `--target x86_64-apple-darwin`, and the comment block records everything a re-enabler needs: (a) uncomment BOTH rows (two archs, distinct `--target`s — a matrix without them collides asset names and silently drops a platform); (b) the toolchain step must add those `targets` (rust-toolchain.toml intentionally lists none — a cross-target not installed fails the build); (c) job `env:` MAY read secrets, so the `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` block lives at job level; (d) the per-arch SKIP GATE cannot read secrets in `if:` — the shape is a `check-macos-signing` step (`run: echo "enabled=${{ secrets.APPLE_ID != '' }}" >> "$GITHUB_OUTPUT"`, secrets ARE available in `run:`) gating the tauri-action STEP via `if: matrix.os != 'macos-latest' || steps.check-macos-signing.outputs.enabled == 'true'`; (e) drop `--no-sign` for macOS (signing is the point there). `fail-fast: false`.
  - Steps: pinned-toolchain install copied verbatim from ci.yml; pnpm + node 22; `pnpm install --frozen-lockfile`; Linux deps `if: runner.os == 'linux'` (same package list as ci.yml).
  - Job `env`: `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from secrets.
  - `uses: tauri-apps/tauri-action@v1` with step `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` (the action THROWS without it). With: `args: ${{ matrix.args }}${{ github.event_name == 'workflow_dispatch' && ' --no-sign' || '' }}`; `releaseId: ${{ needs.create-release.outputs.release-id }}` (resolves empty on dispatch — safe: the action treats it as unset); `uploadUpdaterJson: false`; `uploadUpdaterSignatures: true` (the default — stated explicitly since it is what Task 2's composer consumes); `uploadWorkflowArtifacts: ${{ github.event_name == 'workflow_dispatch' }}` (debug-only: ~124 MB AppImages × both OSes retained 90 days per artifact is a real storage line item — only pay it when there is no release to look at). **NO `projectPath`** (Evidence: it would force the floating global CLI — the pinned-CLI AGENTS.md rule is WHY); **NO `releaseDraft`/`releaseName`/`releaseBody`/`tagName`** (ignored with `releaseId`; dead YAML lies to the next reader).
  - After the action step, on dispatch ONLY: assert bundles exist — `test -f`-style glob over `src-tauri/target/release/bundle/**` and fail if empty (the skip-all-uploads path passes GREEN with zero artifacts), and assert NO `*.sig` files were produced (the `--no-sign` proof — assert the artifact, not a log line).
- **`publish` job** (ubuntu; `needs: [create-release, build]`; `if: always() && needs.create-release.result == 'success' && needs.build.result == 'success'`):
  - checkout; `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` env.
  - `TAG`/`VER` from `needs.create-release.outputs` (`VER=${TAG#v}`).
  - `gh release download "$TAG" --pattern '*.sig' --dir sigs --clobber` → `gh` itself errors when nothing matches; keep a belt-and-braces `ls sigs/*.sig` check with the job's own message.
  - `bash scripts/compose-updater-manifest.sh --sigs-dir sigs --version "$VER" --tag "$TAG" --repo "$GITHUB_REPOSITORY" --out latest.json --notes "Archimedes $TAG"`.
  - `gh release upload "$TAG" latest.json --clobber`.
  - LAST step, nothing after: `gh release edit "$TAG" --draft=false`. The job header comment states WHY publish is last: `/releases/latest/download/latest.json` serves only published non-prerelease releases, so publishing first would let installed clients see a version whose manifest is missing or stale.
- Delete the old three-job bodies entirely (history lives in git).

**Deliberately NOT changed:** `tauri.conf.json`; the scripts; any Rust/TS.

**Steps:**
- [ ] Rewrite `release.yml` (every rule above; the step-`if` gate and the `always()` guards are the parts a fast reader will get wrong).
- [ ] Validate the YAML parses (Task 1's tool choice).
- [ ] Push the branch; open the PR.
- [ ] Trigger `workflow_dispatch` (no tag) on the branch: `gh workflow run release.yml` — both build jobs must succeed; assert the bundle-files-exist and no-`.sig` assertions ran (they're steps in the job); assert NO release and NO `latest.json` were created anywhere (`gh release list` unchanged).
- [ ] Commit: `ci: rebuild the release pipeline as draft → build → single-writer publish`

**Acceptance criteria:**
- [ ] `workflow_dispatch` run: both OS bundles built, dispatch-only assertions ran, nothing uploaded, `uploadWorkflowArtifacts` produced workflow artifacts.
- [ ] `grep -n "uploadUpdaterJson" .github/workflows/release.yml` → `false` with the ADR 0052 pointer; `grep -n "projectPath" release.yml` → nothing.
- [ ] The tauri-action step sets `env.GITHUB_TOKEN`.
- [ ] macOS commented rows + their (a)–(e) re-enable checklist exist; no `if:` anywhere reads `secrets` directly.
- [ ] Publish job's last step is `gh release edit "$TAG" --draft=false` and the job fails before it on zero sigs / composer failure.

---

### Task 5: Wire the updater plugin behind two Rust commands + one event (and fix the endpoint)

**Context:** The app promises auto-update (config has pubkey/endpoint/createUpdaterArtifacts) but has NO updater plugin, so nothing can ever update. Worse, `tauri.conf.json:48`'s endpoint names the WRONG repo (`archimedes` instead of `archimedes-desktop` — the README claim that it was fixed is false), which would 404 every installed client forever; fixing it belongs HERE because this task is the first moment the endpoint actually gets exercised. ADR 0053: the webview gets NO updater permissions; everything happens in Rust behind `check_update` / `install_update` / `relaunch_app`, exactly like `tauri-plugin-notification` (Cargo.toml comment precedent: "called from Rust only, so there is no capability entry and no npm package"). No capability change; `AppExt::restart()` (verified: `tauri-2.12.2 app.rs:606`, returns `!`) replaces `tauri-plugin-process`. The README's "Check for updates menu item" is fiction (there is no menu); Task 6 fixes the prose; this task builds the real Settings seam.

**Files:**
- Modify: `src-tauri/Cargo.toml` — via the documented incantation (run from `src-tauri/`): `cargo add tauri-plugin-updater --target 'cfg(any(target_os = "macos", windows, target_os = "linux"))'`. Then CHECK the diff: the `target =` gate is present; the resolved plugin version in `Cargo.lock` is **≥ 2.12** (older silently ignores `requireSignedVersion`); and `tauri` did NOT move off 2.12.2 (AGENTS.md pins the CLI to it — if cargo wants to bump tauri, stop and reconcile rather than float the CLI).
- Modify: `src-tauri/src/lib.rs` — `.plugin(tauri_plugin_updater::Builder::new().build())` after `tauri_plugin_notification::init()` (`:268`; it is a BUILDER — there is no `init()`); add the three commands to `generate_handler!` (after `:269`).
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod update;` (alphabetical: after `spaces`).
- Create: `src-tauri/src/commands/update.rs`
- Test: `#[cfg(test)] mod tests` inside `commands/update.rs` (pure helpers only). Do NOT extend `tests/ipc.rs` — it builds its own private `generate_handler!` and has no updater plugin.
- Modify: `src-tauri/tauri.conf.json` — (1) fix the endpoint: `https://github.com/danielcherubini/archimedes-desktop/releases/latest/download/latest.json`; (2) add `"requireSignedVersion": true` inside `plugins.updater` beside pubkey/endpoints.

**What to implement** (mirroring `commands/open.rs`'s documented-thin style — module doc states what the layer owns; test-module doc states what the tests do and must NOT do, in that file's voice):

- FIRST, read `~/.cargo/registry/src/*/tauri-plugin-updater-2.1*/src/error.rs` (the resolved version) — the plan's Evidence list is a map, the enum is the territory, and it is `#[non_exhaustive]` so a `_` fallback is mandatory.
- `#[derive(Serialize)] #[serde(rename_all = "camelCase", tag = "state")] pub enum CheckOutcome { UpToDate, Available { version: String, notes: Option<String>, date: Option<String> } }` — `date` comes from `Update.date: Option<OffsetDateTime>` via `.map(|d| d.to_string())` (NOT a string at the source). The three-way split lives HERE: `Ok(UpToDate)` = "confirmed current"; `Err(_)` = "the check could not complete" — never conflated (a 404 arrives as `ReleaseNotFound` and a 204 as `Ok(None)` — both land here, mapped apart).
- `pub fn map_check_error(e: &tauri_plugin_updater::Error) -> String` → stable typed strings in the repo's `kebab-case:detail` style, arms ONLY on variants that exist: `ReleaseNotFound` → `"release-not-found"`; `EmptyEndpoints` → `"endpoints-not-configured"`; `Network(s)`/`Reqwest(e)` → `"network:<s>"` (the status text lives INSIDE `Network`'s string — there is no status-code field anywhere); `TargetNotFound(t)`/`TargetsNotFound(v)` → `"invalid-target:<joined>"`; `UnsupportedOs`/`UnsupportedArch` → `"unsupported-platform"`; `SignedVersionMismatch{..}`/`MissingSignedVersion` → `"signature-mismatch"` (SECURITY-relevant: a tamper/republish signal — must NOT degrade into `install:…`); `InvalidUpdaterFormat` → `"invalid-update-format"`; `AuthenticationFailed` → `"authentication-failed"`; `DebInstallFailed`/`PackageInstallFailed` → `"install-failed"`; `Io(e)` → `"io:<e>"`; `_` → `"update-error:<Display>"`.
- `pub struct ProgressThrottle` — `new(min_interval: Duration, min_ratio: f64)`; `#[must_use] pub fn should_emit(&mut self, now: Instant, chunk_bytes: usize, content_length: Option<u64>) -> bool`; clock INJECTED (tests fabricate `Instant`s via a base + `checked_sub`; zero sleeping). Emit when: first frame ever, OR ≥ `min_interval` since last EMITTED frame, OR the running total crossed ≥ `min_ratio` of `content_length` since the last emitted frame. The struct OWNS the running total (`note(&mut self)` semantics or fold it in — one accumulator, document it, because the plugin hands per-chunk increments and the bar needs the sum). `content_length == None` → interval-only. Defaults 100ms / 0.01.
- `#[tauri::command] pub async fn check_update(app: AppHandle) -> Result<CheckOutcome, String>` — thin: `app.updater()?.check()` (`UpdaterExt`); `Ok(None)` → `UpToDate`, `Ok(Some(u))` → Available; `Err(e)` → `map_check_error`.
- `#[tauri::command] pub async fn install_update(app: AppHandle) -> Result<(), String>` — re-`check()` (None → Err `"no-update-available"`), then `download_and_install(on_chunk, on_finished)` with `use tauri::Emitter` (pattern: `commands/sessions.rs:11,27`): `on_chunk(chunk_len, content_length)` feeds the throttle and on emit does `app.emit("update://progress", &ProgressPayload { downloaded: <running total the throttle/accumulator maintains>, total: content_length })`; `on_finished` (a `FnOnce()`) emits the terminal `{downloaded: total, total: Some(total)}` frame — the fn doc states that on WINDOWS this future NEVER RESOLVES (the plugin exits the process inside install) so the terminal frame's only observable consumer is mac/linux, and the UI must announce before awaiting regardless.
- `#[tauri::command] pub fn relaunch_app(app: AppHandle)` — `app.restart()` (returns `!`; synchronous command; the renderer delays calling it one beat so the final paint lands — renderer's job, Task 6).
- Do NOT touch `src-tauri/capabilities/default.json`. Do NOT add `tauri-plugin-process`. Do NOT touch the Worker protocol or `setup_dirs`.

Tests inside the file: `map_check_error` rows — at minimum `ReleaseNotFound → "release-not-found"`, `EmptyEndpoints → "endpoints-not-configured"`, `SignedVersionMismatch → "signature-mismatch"` (constructed via whatever pub API exists; if a variant cannot be constructed in-test, pin its Display string path instead and say so), and the `_` fallback shape; `ProgressThrottle` — first frame emits; two frames 10ms apart under 1% → suppressed; crossing 1% → emits; `content_length: None` → interval-only; 1000 rapid synthetic 4 KB chunks over a 1000 ms clock → emit count bounded (assert ≤ ~12 for the 100 ms interval; state the arithmetic in the test). The plugin-backed async commands are NOT unit-tested (no endpoint in tests, `mock_builder` has no updater plugin — say exactly this in the test-module comment, `commands/open.rs` style).

**Steps:**
- [ ] Read the resolved plugin's `error.rs` and `updater.rs` (`UpdaterExt`, `check`, `download_and_install` signatures) — 10 minutes, kills every naming guess above.
- [ ] Write `commands/update.rs` with enum + `map_check_error` + `ProgressThrottle` + failing tests → `cargo test update` fails (compile/assert).
- [ ] Implement the helpers → `cargo test update` passes.
- [ ] Add commands + plugin registration + Cargo dep + conf.json (endpoint fix + requireSignedVersion) → `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt` all green; `git diff Cargo.lock` shows tauri still 2.12.2 and plugin ≥ 2.12.
- [ ] Dev smoke (`pnpm tauri dev`, devtools): `window.__TAURI_INTERNALS__.invoke("check_update")` answers — with the OLD (wrong-repo) endpoint you'd get `release-not-found`; with the fixed endpoint pre-release GitHub's `/releases/latest` 404s the same way, so the discriminating check is: does the endpoint in the config now name `archimedes-desktop` (grep), and does a HEAD request to it reach GitHub (404 is expected pre-release; the POINT is the path is the publisher's own).
- [ ] Commit: `feat(update): rust-owned updater seam (ADR 0053)`

**Acceptance criteria:**
- [ ] `git diff` shows NO hunk in `capabilities/default.json`; no `tauri-plugin-process` anywhere; Cargo dep is target-gated to the three desktop OSes.
- [ ] `check_update` answers with a typed string Err (or Ok) from devtools — the seam is live.
- [ ] The throttle test asserts a bounded emit count under a chunk flood; the `signature-mismatch` mapping exists and is tested.
- [ ] `tauri.conf.json` endpoint contains `archimedes-desktop`; `requireSignedVersion: true` present; lockfile's tauri unchanged at 2.12.2 and updater plugin ≥ 2.12.

---

### Task 6: The Settings updater section, then AGENTS.md + README truth-repair

**Context:** The user-facing half of ADR 0053 and the honesty fix the docs need before a release exists. Constraints: THREE check states (up-to-date vs check-failed are different sentences); Windows install kills the process mid-await so "Installing — this window will close" must PAINT BEFORE the `await`; Linux/macOS finish WITHOUT exiting, so completion is an explicit **Restart to finish** button, not a silent relaunch (the Linux deb/pkexec chain can legitimately fail after a full download). Manual-only: nothing checks on launch, the plugin does not auto-check, and it stays that way (upstream #3641's advice — an aggressive shipped cadence cannot be retracted).

**Files:**
- Create: `src/lib/update.ts` (+ `src/lib/update.test.ts`)
- Create: `src/components/settings/UpdateSection.tsx` (+ `UpdateSection.test.tsx`)
- Modify: `src/components/settings/SettingsPage.tsx` (`Section` union gains `"updates"`, a `SettingsSidebarButton` after MCP, extend the render chain at `:441-448`)
- Modify: `AGENTS.md` (new `## Releasing` section)
- Modify: `README.md` (rewrite Auto-update + installers table + "First-release steps"; do NOT touch the ACP "What it does" paragraphs — planned non-goal)

**What to implement:**

`src/lib/update.ts` (follow `src/lib/version.ts` — thin typed wrappers):
- `type CheckOutcome = { state: "upToDate" } | { state: "available"; version: string; notes: string | null; date: string | null }`; `type UpdateProgress = { downloaded: number; total: number | null }`.
- `checkUpdate(): Promise<CheckOutcome>` → `invoke("check_update")`; `installUpdate()` → `install_update`; `relaunchApp()` → `relaunch_app`; `listenUpdateProgress(cb): Promise<UnlistenFn>` → `listen<UpdateProgress>("update://progress", …)` (the `listenSessionUpdate` shape, `tauri.ts:926`).

`UpdateSection.tsx` — `SettingsGroupCard`/`SettingsRow` primitives only, no new design-system pieces. State machine: `idle → checking → (upToDate | available | failed)`; `available → installing` (Windows: TERMINAL, process dies) `→ downloaded (Restart to finish) | failed` (mac/linux, or a rejected install).
- Version row via `getAppInfo()` (the existing mock at `SettingsPage.test.tsx:67` covers it; no second version source).
- A `checkingRef` guard: in-flight check disables the button (no double `check()`).
- `failed` renders `Could not reach the update server` + the raw typed string; must NOT be worded like up-to-date (pinned below).
- Install flow: set `installing` + the "this window will close" copy and let it PAINT, then await inside try/catch — on Windows the promise never resolves and the process dies (that IS the success path); a rejection (Linux deb failure etc.) lands back on `available` with the error shown; a resolve (mac/linux) shows **Restart to finish** → `setTimeout(relaunchApp, 300)` (paint beat). No auto-relaunch anywhere.
- Progress: `total === null` renders an indeterminate bar (never `NaN%`).
- `SettingsPage.tsx`: adding `"updates"` extends the nested-ternary render chain (`:441-448`) — if lint complains about the nesting depth, convert the chain to a `match`-style lookup in the same commit (mechanical, same behavior). `SettingsPage.test.tsx` gains ONLY nav/render-arm coverage (button appears; selecting it renders the section).

`UpdateSection.test.tsx` mocks `@/lib/update` wholesale (pattern: the `@/lib/version` mock). ⚠ No jest-dom in this repo's vitest setup — assert with `screen.getByText`/`queryByText`/`textContent`, not `toBeInTheDocument`. Cases: (1) `upToDate` → /up to date/; (2) reject `"release-not-found"` → /could not reach the update server/ AND NOT /up to date/ (the conflation pin); (3) `available` shows the new version; (4) clicking install with a NEVER-RESOLVING mock → the "window will close" copy is in the DOM (the Windows shape); (5) resolved path → Restart to finish; (6) `total: null` → no percentage rendered; (7) double-click check → one invoke call; (8) mount alone → no invoke (nothing auto-checks).

AGENTS.md `## Releasing` (AGENTS.md voice — every rule carries its why):
- Version lives in THREE files (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`); the release skill bumps the first two — the step below bumps the third; CI (`scripts/check-versions.sh`, the `scripts` job) fails any PR where they disagree.
- Skill-executable step (the release skill's Step 1 reads AGENTS.md, Step 5 applies it): after the automated bump, set `src-tauri/tauri.conf.json` `version` to the same X.Y.Z; `bash scripts/check-versions.sh` must print `versions match`; the bump commit covers all three files.
- One line each: the minisign private key + password live as GitHub secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), the public half lives in `tauri.conf.json`, and a keypair MISMATCH is WARN-ONLY in CI — verify the pair locally (README) before tagging; a DRAFT is not a shipped release (`/releases/latest/download/` serves published only); macOS packaging is gated on `APPLE_*` secrets and silently skipped while they are absent.

README: rewrite Auto-update to describe what EXISTS after Task 5 (manual check in Settings, Rust seam, signed per-installer payloads, one manifest); installers table macOS row becomes `not shipped yet — pipeline ready, gated on APPLE_* signing secrets`; replace "First-release steps" with the real ceremony: `pnpm tauri signer generate -w ~/.archimedes/archimedes-updater.key` → pubkey into `plugins.updater.pubkey`, private key + password via `gh secret set` (whole file verbatim, newlines preserved; `.env` files do NOT work) → verify the pair locally by signing a scratch file and matching key ids (CI only WARNS on mismatch) → local unsigned builds use `pnpm tauri build --no-sign` (prefer it; the Makefile's `--config createUpdaterArtifacts:false` workaround stays as-is, one added comment line pointing at `--no-sign` — do NOT rewrite the Makefile). State the release order (skill bump → tag → draft → builds → publish) and the throwaway-v0.1.1 rehearsal rule. Fix the FALSE claim at the old "step 1" (`Done — the endpoint points at …archimedes-desktop`) — it was never true until Task 5; write the truth, not another checkmark.

**Steps:**
- [ ] `src/lib/update.test.ts` first (wrappers call invoke/listen with the exact names — mocks on `@tauri-apps/api/core` + `/event`) → fails (module missing) → implement → green.
- [ ] `UpdateSection.test.tsx` (the 8 cases) → implement the component + wire `SettingsPage.tsx` (+ its test) → `pnpm test` green.
- [ ] AGENTS.md + README rewrites; then `grep -n "menu item\|notarized\|archimedes/releases" README.md` — every hit either gone or explicitly prose about what is NOT happening yet.
- [ ] Full bar: `pnpm test && pnpm build` (root); `cargo test && cargo clippy --all-targets && cargo fmt --check` (src-tauri).
- [ ] Commit: `feat(settings): manual updater UI; docs: the release ceremony as it now exists`

**Acceptance criteria:**
- [ ] The conflation test fails if `failed` renders as up-to-date; the installing-state test passes against a never-resolving promise.
- [ ] Nothing checks on mount (case 8).
- [ ] `git diff` shows no capability hunk; AGENTS.md's section names all three version files + the check script; the README contains no claim the code contradicts.

---

### Task 7: Key ceremony + secrets (operator steps, agent prepares)

**Context:** The existing keypair (`~/.archimedes/tauri-signing.key`, password unknown) is ROTATED, not reused — nothing has ever shipped under it, so rotation is free, and the config's current pubkey (`CCB9CE7D353396B3`) has no installed base to honor. A keypair MISMATCH is warn-only in CI (verified in tauri-cli source), which is why verify-the-pair is not optional.

**Files:**
- Modify: `src-tauri/tauri.conf.json` — replace `plugins.updater.pubkey` with the FULL contents of the new `.pub` (single base64 string in JSON, as today)
- GitHub repo secrets (not files): `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- Keep OUT of git: the private key (stays under `~/.archimedes/`)

**Steps (operator runs the password-touching ones in their own terminal):**
- [ ] `pnpm tauri signer generate -w ~/.archimedes/archimedes-updater.key` (a password IS used; it becomes `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
- [ ] Replace `pubkey` with the entire new `.pub` contents.
- [ ] Verify the pair BEFORE tagging: `TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.archimedes/archimedes-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… pnpm tauri signer sign <scratch file>` succeeds, and the signature's trusted comment names the SAME minisign key id as the config pubkey (`untrusted comment: minisign public key: <ID>`).
- [ ] `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.archimedes/archimedes-updater.key` (whole file, newlines preserved — `tauri build` accepts the literal key; newlines survive Actions secret round-trip) and `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- [ ] `gh secret list` shows both. Commit: `chore(release): rotate the updater signing keypair`.
- [ ] Retire the old key: `mv ~/.archimedes/tauri-signing.key ~/.archimedes/tauri-signing.key.retired-$(date +%F)`.

**Acceptance criteria:**
- [ ] `gh secret list` shows the two secrets.
- [ ] The scratch signature's key id equals the pubkey id in `tauri.conf.json`.
- [ ] The private key is nowhere in the repo: the secret form `minisign encrypted secret key` (what a generated private key file's first line says) appears in NO tracked file, and no tracked FILE DECODES to private-key material — the committed pubkey is the public half and cannot. (Amended wording: the original grep for `untrusted comment` was always going to hit prose — Task 6 deliberately documents the verification ceremony in README, which quotes the PUBLIC-side comment; prose about the ceremony is allowed anywhere, key material nowhere.)

---

### Task 8: Rehearsal — tag v0.1.0, verify, then prove self-update with a throwaway v0.1.1

**Context:** The exit condition is an installed app updating itself, provable only from N to N+1 (a first release proves the manifest is reachable and parseable, not installable). Operator-driven watching with a precise verification list, because every failure mode here (draft never published, one-platform manifest, mismatched key, wrong endpoint) is silent until a user hits it.

**Files:** none new. Fix-forward commits as needed (pipeline plumbing may land direct; app-code fixes get their own branch by convention).

**Steps:**
- [ ] After Tasks 1–7 merge: `git tag -a v0.1.0 -m "Release v0.1.0"`; push the tag; `gh run watch`.
- [ ] On failure: `gh run view --log-failed`, fix, and only if nothing consumed it yet: delete + re-push the tag (`git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0` + re-tag; the draft is reused via `create-release`'s idempotency check).
- [ ] Verification commands (run them all):
  - `gh release view v0.1.0 --json isDraft,isPrerelease` → `isDraft: false`
  - `gh release view v0.1.0 --json assets --jq '.assets[].name'` → RECORD THE ACTUAL NAMES into the bottom of this doc, and check them against: setup `.exe` + `.exe.sig`, `-setup.nsis.zip` + `.sig`, `.AppImage` + `.sig`, `.AppImage.tar.gz` + `.sig`, `.deb` + `.sig`, `latest.json`. (The deb name passes through Debian package-name normalization — if it differs from the `Archimedes_…` guess, that is EXPECTED-in-scope: the composer is pattern-based, and Task 2's fixtures already prove pattern handling; a genuine pattern miss fails LOUD in the publish job, which is the designed outcome.)
  - `curl -fsSL https://github.com/danielcherubini/archimedes-desktop/releases/latest/download/latest.json | jq -r '.platforms|keys|sort|join(" ")'` → exactly `linux-x86_64 linux-x86_64-appimage linux-x86_64-deb windows-x86_64 windows-x86_64-nsis`
  - every `.platforms[].url` HEADs 200; every `signature` non-empty.
- [ ] Install HERE and launch: AppImage → `~/AppImages/archimedes.appimage` (reuse the Makefile's `install-appimage` flow/path so the desktop entry stays authoritative); deb → `sudo dpkg -i`. Settings → Updates → "Check for updates" answers **up to date** (0.1.0 vs 0.1.0 — this is also the field proof that `UpToDate` and `release-not-found` render differently).
- [ ] Cut the throwaway patch via the `release` skill at `patch` (AGENTS.md's step bumps all three files; `check-versions.sh` guards); tag `v0.1.1`; let the pipeline publish.
- [ ] THE test, on the installed AppImage: check → available v0.1.1 → install → progress frames appear → app restarts (or Restart to finish) → Settings shows **0.1.1**; `ls -l ~/AppImages/archimedes.appimage` mtime moved. On the deb install: expect the pkexec/dpkg chain; if it fails after download that is a FINDING to record here with the error string (open upstream issue #3595 territory) — the UI showing an honest failure is the pass condition.
- [ ] Windows: install v0.1.0 NSIS on a Windows machine/VM; update to v0.1.1; expect the installer to appear and the app to close (the never-resolving shape). No Windows machine reachable ⇒ record that leg as UNVERIFIED — do not mark done-when met on Linux alone.
- [ ] Tidy: keep v0.1.1 published (it is a real patch); record rehearsal outcomes at the bottom of this doc, fold anything durable into README, then delete this roadmap doc on ship (history lives in git).

**Acceptance criteria:**
- [ ] The four verification commands pass as specified.
- [ ] AppImage- and deb-installed 0.1.0 both launch here.
- [ ] AppImage 0.1.0 → 0.1.1 in-place self-update completes (the done-when clause).
- [ ] The deb and Windows outcomes are RECORDED — success or finding; silence is not an outcome.

---

## Plan-level acceptance (the done-when)

Published (not draft) release with all assets on Linux + Windows, a five-key `latest.json` whose URLs all resolve, the full CI bar green on three OSes, and an installed 0.1.0 that updates itself to 0.1.1 from the Settings section. macOS packaging stays gated on `APPLE_*` secrets — compiling and testing macOS is NOT gated and must be green.

## Task 3 follow-ups (recorded at ship time)

- `tests/ipc.rs` stays `#![cfg(target_os = "linux")]` for ONE platform now: the Windows `STATUS_ENTRYPOINT_NOT_FOUND` is FIXED at the build (the Common-Controls-v6 manifest never reached non-`[[bin]]` link targets — upstream tauri#13419 — `src-tauri/build.rs` now re-emits it unscoped, so the gate's Windows rationale is gone). The macOS `SIGSEGV` is a data race in our own harness against `MockRuntime`'s unsound `Send`/`Sync` — the gate deletes when the one-thread-per-test harness rewrite lands. Full analysis, evidence and rejected alternatives: `docs/research/tauri-mock-runtime-test-crashes.md`.
