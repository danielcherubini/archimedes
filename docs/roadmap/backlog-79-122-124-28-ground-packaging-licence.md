# Grounding report — AREA: packaging-licence

**Branch:** `feature/backlog-79-122-124-28` (base `f5ba339 chore(release): bump version to 0.9.0`)
**Working tree:** clean (`git status --porcelain` → 0 lines)
**Serves:** issue #28 of `danielcherubini/archimedes` (task A4 in `docs/roadmap/backlog-79-122-124-28-status.md`)
**Grounded at commit:** `f5ba339` (HEAD)
**Read-only; the only file written is this report.**

---

## 0. Decision already made (do not re-open)

The owner chose **MIT**, SPDX form `MIT`. Apache-2.0 and dual-licensing were considered and rejected.
Recorded in `docs/roadmap/backlog-79-122-124-28-status.md`:

> **2026-10-29 — Licence chosen: MIT.** Owner's explicit choice at the Step 0 gate (the
> one question this run could not decide: a legal stance). SPDX form `MIT`, per the
> issue's own requirement that rpmlint validates the string against its licence list.

---

## 1. `src-tauri/Cargo.toml` `[package]` block — and package.json top-level keys

### src-tauri/Cargo.toml lines 1–12, verbatim (the whole `[package]` block):

```toml
[package]
name = "archimedes"
version = "0.9.0"
description = "A Tauri App"
authors = ["you"]
edition = "2021"

# A single binary (the app — the desktop is native-only, the external
# `pi` path is gone; the dev-only `fake_pi` test fixture is deleted);
# tell cargo which one `cargo run` (and thus `tauri dev`) should launch.
default-run = "archimedes"
```

Notable: **no `license` field**, and **`authors = ["you"]` is the literal, not-filled-in placeholder**. `cargo metadata` confirms the effect: `license: null`, `license_file: null`, `authors: ["you"]`.

### package.json top-level keys, verbatim (first line of each key):

```json
{
  "name": "archimedes",
  "packageManager": "pnpm@11.7.0",
  "private": true,
  "version": "0.9.0",
  "type": "module",
  "//three": "...",
  "scripts": { ... },
  "dependencies": { ... },
  "devDependencies": { ... }
}
```

**There is no `license` key and no `author` key in package.json**, and **`"private": true` means nothing from this manifest is ever published to the npm registry** — so a `license` field there is tooling hygiene / consumer metadata only, never a shipped-license mechanism. It carries no legal weight for the packaged artifact. (The issue's own words: *"it is `private: true`, so that field is tooling hygiene only, nothing is published to npm"*.) `@tauri-apps/cli` is pinned exactly at **`"2.12.2"`** in `devDependencies`.

Note: the package.json version is 0.9.0 and the `//three` key is a long comment (not relevant here, quoted by key name only to keep the true top-level set visible).

---

## 2. Full `bundle` section of src-tauri/tauri.conf.json — verbatim

The file is 56 lines. The `bundle` section spans **lines 28–43**; line 30 is the `targets` line the issue cites. Verbatim:

```json
  "bundle": {
    "active": true,
    "targets": ["nsis", "app", "dmg", "appimage", "deb", "rpm"],
    "shortDescription": "Archimedes Desktop Coding Agent",
    "category": "DeveloperTool",
    "createUpdaterArtifacts": true,
    "icon": [
      "icons/32x32.png",
      "icons/64x64.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  },
```

**Confirmed with jq, not just grep:** `jq '.bundle | keys'` → `["active","category","createUpdaterArtifacts","icon","shortDescription","targets"]` — there is **no `license`, no `licenseFile`, no `linux` key at all** in `bundle`. `jq '.bundle.linux'` → `null`. A whole-file case-insensitive `grep` for `licen` across `tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml` returns **empty**.

For orientation, the top of the file (verbatim):

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Archimedes",
  "version": "0.9.0",
  "identifier": "codes.archimedes.desktop",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
```

and after `bundle` come `plugins.updater` (pubkey + endpoints, not quoted here — not licence-relevant).

---

## 3. Are the vendored tauri sources the issue cites readable in this checkout? — NO

The issue's root-cause chain cites `crates/tauri-cli/src/interface/rust.rs:1659-1675`, `crates/tauri-bundler/src/bundle/settings.rs:1257-1259`, and `crates/tauri-bundler/src/bundle/linux/rpm.rs` (lines 61, 78, 215). **None of those files exist in this working tree.** Verified:

- `find . -path ./target -prune -o -path ./node_modules -prune -o -type d \( -name "tauri-cli" -o -name "tauri-bundler" \) -print` → **nothing**.
- `find . -path ./target -prune -o -path ./node_modules -prune -o -type f \( -name "rust.rs" -o -name "settings.rs" -o -name "rpm.rs" \) -print` → only `./src-tauri/src/commands/settings.rs` (the app's own file, unrelated).
- The npm CLI package `node_modules/@tauri-apps/cli` (v2.12.2) is a JS wrapper (`tauri.js` → `require('./main')`) plus a compiled napi binary at `node_modules/.pnpm/@tauri-apps+cli-linux-x64-gnu@2.12.2/.../cli.linux-x64-gnu.node` — **no Rust sources shipped** (`find node_modules/@tauri-apps/cli -name "rust.rs" -o -name "settings.rs" -o -name "rpm.rs"` → nothing).
- The cargo registry cache has **no `tauri-cli` or `tauri-bundler` crate at all** (`ls -d ~/.cargo/registry/src/*/tauri-cli* tauri-bundler*` → empty; `find ~/.cargo -iname "*tauri-cli*" -o -iname "*tauri-bundler*"` → empty). The registry holds `tauri` 2.11.5–2.12.3, `tauri-build`, `tauri-utils` (the lockfile pins `tauri-utils` at Cargo.lock:5490) etc., but **neither bundler crate is cached** — the `@tauri-apps/cli` napi binary embeds the bundler, so cargo never fetches it as a Rust dependency.
- `src-tauri/Cargo.lock` contains no `name = "tauri-cli"` and no `name = "tauri-bundler"` entry.

**Verdict, plainly:** the cited line numbers cannot be verified or re-quoted from this machine. They are quoted inside the issue body (from the repo owner's own read of the vendored sources at tauri-cli/tauri-bundler 2.12.2) — the issue's body itself says the *"crates/…"* paths are the vendored sources inside the `@tauri-apps/cli` 2.12.2 package. Do not invent lines 1659/1257/61/78/215 in any plan as if they were re-checked here; plan against the issue's quoted content. What the planner can verify locally is instead the app-side surface (Section 1 and 2 above) plus the published `config.schema.json` that ships with `@tauri-apps/cli` 2.12.2 — `node_modules/@tauri-apps/cli/config.schema.json` is present if a schema-level existence check (e.g. `licenseFile`, `bundle.linux.files`) is wanted.

---

## 4. The MIT licence text and the copyright-line convention

### Standard MIT licence text (the template the SPDX community and choosealicense publish — quoted; the year is the file-creation year, filled by whoever creates `LICENSE`):

```
MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### What `<copyright holders>` should be filled with — measured, not guessed:

- `src-tauri/Cargo.toml` `authors = ["you"]` — the **unfilled placeholder**; it cannot support a copyright name.
- `package.json` has **no `author` field**.
- `README.md` has **no author/owner line**; its only owner-ish reference is the GitHub URL `https://github.com/danielcherubini/archimedes-desktop/...` (README.md:112, quoted in Section 6).
- **`tauri.conf.json` carries the public, owner-chosen identity**: `"identifier": "codes.archimedes.desktop"` and `"productName": "Archimedes"`.
- Git author data for every recent commit (and `git config user.name`/`user.email`) is **`Daniel Cherubini <daniel@cherubini.casa>`** — 6/6 commit signatures inspected, including `f5ba339` (HEAD) and the rpm-release commits `846374c`/`a06de49` the issue cites.
- The GitHub namespace is `danielcherubini` in three places (updater endpoints in `tauri.conf.json`, README, release.yml).

**Report, not a prescription:** the copyright name is a *person or legal entity* decision the planner must take to the owner (the status file already treats the licence choice itself as an owner-only call; the holder-name line is the same class of decision). The verifiable candidates on this machine are `Daniel Cherubini` (the git identity that authored the entire shipping history) and a `<year> Daniel Cherubini` line. The `.work-notes.md`/`CONTEXT.md` files were not read (out of scope for this area) — if a legal name for the holder lives anywhere, it is likely there, but it was not found in any Owns-set file.

---

## 5. The ADR convention in `docs/decisions/`

75 records, numbered `0001`…`0084`. **No template/README file exists** in the directory — the convention is embodied by the records themselves.

**Next free number: 0085 — verified the 0064-documented way, not by `ls | tail`.** The status file and the ADRs themselves record the append-only rule ("ADR numbers are append-only, gaps are not filled", stated in ADR 0084). Checks run:

- `git log --all --diff-filter=A --name-only --format="" -- docs/decisions/ | grep -E "0084|0085"` → **0084 appears exactly twice** (two commits — the add and, per its own history, the squashed re-add/merge; the file's own "The number 0084 — checked, not assumed" section says the same); **0085 appears nowhere**. So 0085 is free on every branch, and no gap is being filled.
- Working directory: highest file present is `0084-…`, so `0085-<slug>.md` is the next number.

**Front-matter — every recent record has exactly this shape** (verbatim from 0077, 0082, 0083, 0084):

```
---
status: accepted
date: 2026-10-29
superseded-by:
---
```

(`date` values in recent records: 0078 → 2026-10-26, 0083 → 2026-10-28, 0084 → 2026-10-29. `superseded-by:` has an empty value when nothing supersedes it.)

**Title style:** a single `# ` title that states a *decision* — the verb/modal pattern "X **is** Y", all-caps emphasis on the load-bearing words, an em-dash separation, often a trailing clause. Real examples, verbatim:

- 0078: `# Test scratch dirs are owned, and a directory census guards them`
- 0082: `# The session's money is the PROVIDER'S per-call figure, read from the response BODY — and an unknown price renders as nothing, never `$0.00``
- 0083: `# The self-modification guard is an ASK when no rule matches — the protected agent-definition dirs are a guard-membership set, not a rule set`
- 0084: `# A definition's `permission:` block is consulted at the TAIL of row 4 and can only NARROW — so it governs children only, sits below the user's rule list, and may empty an advertised tool list without ever making it ABSENT`

**Body structure (the recurring section set):** an opening thesis paragraph (3–6 sentences restating the decision in bold/keyword form); then top-level `## ` sections: `## The decision` / `## Considered Options` / `## Consequences` are the core trio (present in 0077/0078/0084), with ad-hoc `## Why …` / `## … is NOT …` sections between, and often a closing honesty section (`## Honesty about what this ADR could not check` in 0084). The filenames are `NNNN-<lowercase-hyphenated-short-summary>.md`.

**A short quotable example of the house structure** (ADR 0077's opening, verbatim):

> ```
> ---
> status: accepted
> date: 2026-10-25
> superseded-by:
> ---
>
> # A compaction continues the turn it interrupted, and its summary is the output of a tool card
>
> Two halves of one defect ([issue #90](https://github.com/danielcherubini/archimedes/issues/90)): an
> automatic compaction that could not produce a summary **ended the turn** while its own event
> …
> ## Considered Options
> ## Consequences
> ```

For a licence ADR the house pattern implies: front-matter `status: accepted` / a `date` / empty `superseded-by:`; a decision-statement `#` title; opening paragraph naming the choice and its SPDX form; then at minimum `## The decision` (or the option-weights list), `## Considered Options` (MIT / Apache-2.0 / dual — all three were actually considered, so the section writes itself), and `## Consequences` (the rpm `License` tag fix, rpmlint `no-license` disappearance, the surface where the identifier rides: Cargo.toml, package.json, tauri.conf.json, LICENSE, README). The status file's own text adds a house expectation for the "last checklist item": the outcome is recorded **in the new ADR** because the old deferral doc is deleted (Section 9).

---

## 6. What README.md says and where a licence line naturally goes

README.md (`# Archimedes Desktop`) currently has **no licence statement anywhere** (case-insensitive grep for `licen`/`copyright`/`author` hits nothing). Its current header block, verbatim:

```markdown
# Archimedes Desktop

A cross-platform (Windows / macOS / Linux) desktop app, built with
[Tauri 2](https://tauri.app), that connects to coding agents over the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com). Pi is the
first-class agent in v1; other ACP agents follow.

See [CONTEXT.md](CONTEXT.md) for the project's language and terminology.
```

The heading structure (the natural insertion anchor candidates, since there is no license/legal section today): `## What it does` → `## Prerequisites` → `## Getting started` → `## Building installers` → `## Auto-update` → `## Releasing` → `## Linux rendering: the DMABUF environment variables` → `## Development` → `## Diagnostics`. Two natural landing spots exist, and both are currently licence-free:

1. A paragraph under the intro block (after `See CONTEXT.md…`), the common "licensed under MIT" idiom; or
2. A short `## License` section (house style has no such section yet — grep confirms).

The only owner-ish string already in README is the updater URL (README.md:112): `https://github.com/danielcherubini/archimedes-desktop/releases/latest/download/latest.json`.

The issue's checklist words its own expectation: *"Choose the licence and record it where the repo records decisions (an ADR under `docs/decisions/` plus a line in `README.md`)".*

---

## 7. Verification reality — measured, not assumed

### Local tool availability (Fedora 44 Workstation):

```
$ which rpmbuild rpm rpmlint
which: no rpmbuild in (<PATH>)
/usr/bin/rpm
which: no rpmlint in (<PATH>)
$ rpm --version
RPM version 6.0.2
$ ls /usr/bin/rpm*
/usr/bin/rpm  /usr/bin/rpm2archive  /usr/bin/rpm2cpio  /usr/bin/rpmdb
/usr/bin/rpmdumpheader  /usr/bin/rpmkeys  /usr/bin/rpmquery  /usr/bin/rpmsort
/usr/bin/rpmverify
```

So: **`rpm` (6.0.2) is present, `rpmbuild` is ABSENT, `rpmlint` is ABSENT.** The issue's own sandbox note matches — it could read the header table but not run `rpm -qp`/`rpmlint`.

**What this means for the issue's proof checklist** ("the rpm header's `License` is non-empty, `rpm -qlp` lists the licence file, and `rpmlint` no longer reports `no-license"`):

- **Cannot be proven locally as a full rpm build**: no `rpmbuild` (and no `rpmlint`) on this machine — a real `pnpm tauri build` rpm validation (`-qp`, `-qlp`, rpmlint) has no local execution path here. The task's plan must place that proof on the **release leg** (CI) or accept it as an unproven-from-this-branch item. The status file already says exactly this: *"A4 cannot be proven on a real rpm here — `rpmbuild` is absent locally (only `rpm` is present), so the issue's 'prove it on a real build' checklist item lands on the release leg, not on this branch. Record that honestly in the task's acceptance note rather than claiming the header was checked."*
- **What CAN be proven locally**: `rpm -qp --qf '%{LICENSE}' <rpm>` — but only against a `.rpm` that exists; the current tree has no rpm artifact on disk (`src-tauri/target/release/bundle` was not produced in this session; nothing was built).

### What `.github/workflows/release.yml` actually does for the rpm target

There is **no rpm-specific build/assert step anywhere in release.yml**. The rpm is built implicitly by the matrix `tauri build` on both Linux (`ubuntu-latest`) build rows; the one rpm mention in either workflow file is the **dispatch-mode bundle assertion that counts artifacts by glob** — it does not inspect the rpm's header or file list. Relevant steps, quoted; first, the build job (release.yml:251-274, key lines verbatim):

```yaml
      # `@v1` (verified against the upstream repo: tags `v1`, `v1.0` and
      # `v1.0.0` all exist; v1.0.0 is the release this line resolves to). v1 is
      # the input names used below — v0's `includeUpdaterJson` no longer exists,
      # which is exactly how the old three-job file lost the race.
      - name: Build and upload the bundles
        uses: tauri-apps/tauri-action@v1
```

then the count-by-name assertion (release.yml:318-345, key lines verbatim):

```yaml
      # Dispatch mode only. Without uploads, a run that produced zero bundles
      # still goes GREEN (nothing failed), so the rehearsal would prove nothing.
      # These two steps are what make build-only mode a real test.
      - name: Assert the bundles were built (dispatch mode)
        if: github.event_name == 'workflow_dispatch'
        shell: bash
        run: |
          set -euo pipefail
          BUNDLE_DIR=src-tauri/target/release/bundle
          if [ ! -d "$BUNDLE_DIR" ]; then
            echo "::error::no bundle directory at $BUNDLE_DIR — the build produced nothing"
            exit 1
          fi
          echo "bundle tree:"
          find "$BUNDLE_DIR" -type f | sort
          count=$(find "$BUNDLE_DIR" -type f \( \
            -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \
            -o -name '*.exe' -o -name '*.msi' -o -name '*.nsis.zip' \
            -o -name '*.dmg' -o -name '*.app.tar.gz' \) | wc -l)
          if [ "$count" -eq 0 ]; then
            echo "::error::no installer bundles under $BUNDLE_DIR (see the tree above)"
            exit 1
          fi
          echo "installer bundles found: $count"
```

Line numbers verified: `tauri-action@v1` is **release.yml:268**; the `*.rpm` glob is **release.yml:331**; the `installer bundles found` echo is **release.yml:338** (matching the issue's cited 268 / 330-333). The workflow's other bundle-affecting lines: build matrix `os: [windows-latest, ubuntu-latest]` (macOS rows commented out behind the `APPLE_*` secrets gate), `TAURI_SIGNING_PRIVATE_KEY*` env, `--no-sign` appended in dispatch mode, and `uploadUpdaterJson: false` so the `publish` job (`scripts/compose-updater-manifest.sh`) is the single `latest.json` writer — none of which look inside an rpm.

**Where the proof must land, stated plainly:** the only place an rpm is ever built today is CI's release workflow (`tauri build` on `ubuntu-latest`, bundling all six `targets` from `tauri.conf.json`). A proof step for the issue's checklist either becomes a new release.yml step (e.g. `rpm -qp … --qf '%{LICENSE}'`/`rpm -qlp` after `tauri build`, possibly `sudo apt-get install rpm rpmlint` in the Linux build job) or a documented unverified item; nothing in the tree does that today, and the planner should note CI's `workflow_dispatch` rehearsal mode as the natural place to exercise such a step without shipping (the dispatch assertion step exists precisely to give build-only mode teeth).

---

## 8. CI / scripts interplay with a licence field

### `.github/workflows/ci.yml`

**No step would catch a missing or incorrect licence field.** Grep for `rpm|rpmlint|rpmbuild|licen` across both workflows hits only the release.yml:331 `*.rpm` glob quoted above. ci.yml's gates are: fmt, clippy (`--all-targets -D warnings`), `cargo test` ×3 OS arms (with the temp-dir/crash-log guards), `pnpm test`, `pnpm build`, and a `scripts` job that runs the shell-script test harnesses plus `bash scripts/check-versions.sh` on the real checkout. Tauri's config-schema validation is not run in ci.yml at all — and even `tauri build` (which does validate `tauri.conf.json` against the schema, and would surface a malformed `license`/`licenseFile` type) runs nowhere in CI except the release workflow. So: a typo in the SPDX string ("MIT " with a space, or "mit") would pass **every** CI gate and only fail rpmlint out-of-band. The planner should treat rpmlint-validity as unguarded by CI.

### `scripts/check-versions.sh`

Reads exactly three fields: `package.json` `.version`, `src-tauri/Cargo.toml` `^version = "…"`, `src-tauri/tauri.conf.json` `.version` (line-anchored `sed` for the TOML, `jq -r '.version // empty'` for the two JSON files). It is blind to every other key, **including any new `license` field and the `bundle` section** — quoted, the README's own words: *"The version lives in `three` files … CI fails any PR where they disagree (`scripts/check-versions.sh`…)"*, and AGENTS.md's `## Releasing` opens: **"The version lives in THREE files"** and spells the three paths (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`).

**Interaction answer:** a `license` addition does not interact with the version check at all — the check only extracts the three `version` values, and neither a new `[package] license = "MIT"` line (not `version`, so the `^version =` sed anchor skips it) nor a `"license"`/`bundle.license`/`bundle.linux.files` JSON key disturbs `jq -r '.version // empty'`. `scripts/check-versions.test.sh` (which ci.yml's `scripts` job runs) tests that same three-value comparison and is likewise unaffected. **No other script in `scripts/` touches these files:** `check-release-signatures.sh`, `check-temp-dir-census.sh`, `check-test-data-dir.sh`, `compose-updater-manifest.sh`, `release-notes.sh`, `updater-payload-shapes.sh` — none read `package.json`/`Cargo.toml`/`tauri.conf.json`'s licence surface (their domain is signatures, temp dirs, crash logs, the updater manifest, and notes). The Makefile was not in scope, but its only packaging overlay quoted in the README is the `appimage` recipe's `createUpdaterArtifacts:false` config override — no licence involvement reported by the README.

### Repeated fact for the planner

The version lives in three files and a licence addition touches those same three files; the two concerns are disjoint because the check is a narrowly-targeted version extractor.

---

## 9. What is ALREADY done toward a licence

**Nothing in code; a decision and a doc convention already exist in the roadmap.** Verified with several independent probes:

1. **No tracked LICENSE-shaped file, ever:** `git ls-files | grep -iE 'licen|copying|copyright'` → **empty**; `git log --all --diff-filter=A --name-only --format="" | grep -iE 'licen|copying'` → **empty** (no LICENSE/COPYING file has existed in this repo's history on any branch); `git ls-files --others --exclude-standard` → nothing untracked (a new `LICENSE` does not exist on disk either).
2. **No licence field anywhere:** `grep -ni licen` in `tauri.conf.json`, `package.json`, `Cargo.toml` → **empty**; `cargo metadata` → `"license":null,"license_file":null`.
3. **No licence statement in README.md** (Section 6) and **none in `docs/features/`** (grep → empty).
4. **`docs/decisions/` "licen" hits are the word "licence"/"license" used figuratively** in ADRs 0044, 0054, 0063, 0072, 0082, 0084 — e.g. 0054: *"The contract stays — the fold is a floor, not a licence."*; 0082: *"…**not** a licence to fall through to another field's figure"*. **None is a licensing record.** No ADR decides or even defers the software licence.
5. **The deferral is recorded in the roadmap status file only** (the issue's cited deferral document is gone — see below).

### The owner decision ALREADY logged (do not duplicate)

`docs/roadmap/backlog-79-122-124-28-status.md` (the run's memory file) contains, verbatim:

> **2026-10-29 — Licence chosen: MIT.** Owner's explicit choice at the Step 0 gate (the
> one question this run could not decide: a legal stance). SPDX form `MIT`, per the
> issue's own requirement that rpmlint validates the string against its licence list.

and, in "Blockers / open questions":

> **A4's last checklist item is void.** It tells us to update
> `docs/roadmap/multi-platform-build-and-release.md:140-143` from "Flagged, not fixed" —
> that file no longer exists (deleted when its own roadmap shipped). The outcome is
> recorded in the new ADR instead.

### The deferral doc the issue tells us to update — deleted

The issue's checklist item 6 says: update `docs/roadmap/multi-platform-build-and-release.md:140-143` from "Flagged, not fixed" to the outcome. **That file does not exist in this checkout** (docs/roadmap contains only `backlog-79-122-124-28-status.md`, `compaction-recovery-hardening-follow-ups.md`, `frontend-component-extraction-follow-ups.md`, `issue-91-fetch-hidden-window-follow-ups.md`). Git history shows it was deleted in commit `b3220ed "rmoving some done roadmaps"`, and the commit body the issue quotes ("Flagged, not fixed: the package License tag will be empty…") is in the ancestry: `git log --all -S "Flagged, not fixed" --oneline` → `b3220ed` (the delete), `a06de49`, `846374c`. **So checklist item 6 is dead on arrival in this tree** and the status file has already ruled that the outcome goes in the new ADR instead — the plan should skip editing that file, cite the status file's own "void" note, and record the outcome in ADR 0085 (and README).

---

## Risks / edge cases for the planner (grounding only, no ranking)

- **The copyright-holder name is a legal placeholder today** (`authors = ["you"]` in Cargo.toml, no `author`/`license` in package.json). The ADR/LICENSE must carry a real holder; the only verifiable candidate is the git identity `Daniel Cherubini <daniel@cherubini.casa>` (every shipping commit, including HEAD) — an owner confirmation is required, the same class of owner-only decision the status file records for the licence choice itself.
- **`private: true` in package.json** means the npm `license` field is metadata hygiene, not shipment — the shipped surfaces are Cargo.toml (Cargo fallback), tauri.conf.json (`bundle.license` is the bundler's preferred source per the issue's quoted `rust.rs`), the `bundle.licenseFile` (only read by NSIS/WiX/DMG per the issue — **not** Linux), and `bundle.linux.files` for shipping `LICENSE` inside the rpm at `/usr/share/licenses/archimedes/LICENSE` (the issue's checklist item 5).
- **`bundle.linux` currently does not exist** (verified `null`) — the `bundle.rpm.files` map would be the first `linux` subtree in this config; Tauri schema validation (run by `tauri build`, not by ci.yml) would catch a mistyped key before any rpm is produced, but there is no CI-side licence/SPDX check (Section 8).
- **SPDX string exactness matters for rpmlint**: the issue requires the SPDX form `MIT` (not prose, not "MIT License", not a space-padded variant). The planner's acceptance note must keep the string byte-exact.
- **Proof ceiling is real and pre-agreed**: local machine is `rpm` 6.0.2 without `rpmbuild`/`rpmlint`; the rpm is only ever built in release.yml's Linux leg; no proof step exists today. The status file already instructs recording that honestly in the task's acceptance note rather than claiming verification.
- **CI will not go red on this work** — that is the point of the issue: nothing in CI reads the `License` header, so "green CI" cannot be the acceptance evidence for the rpm fix; the acceptance evidence is the release-leg proof (or a new release.yml step).
- **Three duplicate licence surfaces + the new LICENSE file**: the identifier will live in (a) new root `LICENSE`, (b) `package.json`, (c) `src-tauri/Cargo.toml`, (d) `src-tauri/tauri.conf.json`, (e) README, (f) ADR 0085 — six places for one decision; the issue's own guidance is that `bundle.license` should stay the single source of truth for packaging metadata if the config is to own it (its quoted `rust.rs` prefers `bundle.license` over Cargo).

## Sources list

- Issues / records: `gh issue view 28 --repo danielcherubini/archimedes --json body` (full root-cause chain quoted in Section 0–3 of the issue body); `docs/roadmap/backlog-79-122-124-28-status.md` (decision log lines 159–161, blockers lines ~149–157, task A4 lines 108/130).
- Files quoted verbatim: `src-tauri/Cargo.toml` (lines 1–12), `package.json` (top-level), `src-tauri/tauri.conf.json` (full, 56 lines; bundle at 28–43), `README.md` (headings + head block + line 112), `AGENTS.md` (## Releasing, lines ~47–78), `.github/workflows/ci.yml` (full), `.github/workflows/release.yml` (lines 251–345), `scripts/check-versions.sh` (full).
- ADR convention: `docs/decisions/0077/0078/0082/0083/0084` (front-matter + headings), full text of 0084.
- Environment probes: `which rpmbuild rpm rpmlint`; `rpm --version`; `/etc/os-release` (Fedora 44); `find ~/.cargo …` (no tauri-cli/tauri-bundler); `node_modules/@tauri-apps/cli` layout; `cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps`.
- Git: `git log --all --diff-filter=A` scans for `licen|copying` (nothing); `git log --all -S "Flagged, not fixed"` → `b3220ed`/`a06de49`/`846374c`; author identity logs.
