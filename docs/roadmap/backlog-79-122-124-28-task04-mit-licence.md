# TASK A4 — #28: Adopt MIT and wire the SPDX id through every packaging surface

**Task:** Make the rpm's `License` tag non-empty and make the licence decision durable.
**Source of the work:** [issue #28](https://github.com/danielcherubini/archimedes/issues/28) — `danielcherubini/archimedes`.
**Grounded at:** `f5ba339` (`docs/roadmap/backlog-79-122-124-28-ground-packaging-licence.md`).
**Owner decision, already made (do not re-open):** the licence is **MIT**, SPDX string **`MIT`** (byte-exact — rpmlint validates the string against its licence list; a non-distributable or unrecognised string makes the rpm unusable downstream rather than merely lint-dirty). Apache-2.0 and `MIT OR Apache-2.0` were considered and rejected. Recorded in `docs/roadmap/backlog-79-122-124-28-status.md` (Decisions log, 2026-10-29).
**Target file:** this plan. **Gate:** `pnpm test`, `pnpm build` (repo root); `cargo test`, `cargo clippy --all-targets`, `cargo fmt --check` (src-tauri/).

---

## The defect being fixed (as established by the issue)

No file in the repo carries a licence today, so the bundler resolves the rpm's `License:` tag to nothing:

- **Re-root-caused in the issue** (vendored tauri-cli/tauri-bundler 2.12.2 sources, as quoted in its body): `crates/tauri-cli/src/interface/rust.rs:1659-1675` resolves the bundler licence as `bundle.license` → else `Cargo.toml package.license` → else `None`; `crates/tauri-bundler/src/bundle/settings.rs:1257-1259` returns that `Option` with no default; `crates/tauri-bundler/src/bundle/linux/rpm.rs:61` runs `settings.license().unwrap_or_default()` and the empty string is written verbatim into the header. **Those cited files/line numbers are NOT readable from this machine** (the grounding proved the vendored sources are not in this tree and the `tauri-cli`/`tauri-bundler` crates are not in the cargo registry cache here), so this plan works from the config surface — never re-quote the upstream lines as if re-checked here.
- Locally verified, this tree: `src-tauri/Cargo.toml` `[package]` has **no `license`** -> `cargo metadata --no-deps` reports `license: None, license_file: None, authors: ['you']`; `package.json` has **no `license`/`author`**; `src-tauri/tauri.conf.json` `bundle` has **no `license`/`licenseFile`/`linux` key anywhere** (`jq '.bundle | keys'` -> `["active","category","createUpdaterArtifacts","icon","shortDescription","targets"]`; `jq '.bundle.linux'` -> `null`); `grep -ni licen` across all four files is empty; no `LICENSE`/`COPYING`-shaped file has ever been tracked.
- One plan-level conclusion the issue itself draws: the deb path writes **no** `License` field at all, so the same missing decision is invisible in the deb and loud in the rpm — the rpm is the only packaged surface that *must* carry it.

## The current `bundle` section — verbatim (src-tauri/tauri.conf.json lines 28–43)

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

`bundle.linux` is **`null`** today — there is no `linux` subtree at all. The `bundle.rpm.files` map this plan adds will be the **first** `linux` subtree in the config (schema-verified below, so it cannot be a mistyped key: `tauri build` schema-validates `tauri.conf.json`).

## Why the obvious key is the wrong one for the rpm

`bundle.licenseFile` exists in the Tauri config (`@tauri-apps/cli` 2.12.2 `config.schema.json`: `BundleConfig.properties.licenseFile`, *"The path to the license file to be included in the appropriate bundles"*), but the issue establishes the bundler reads it **only for NSIS/WiX/DMG** — nothing under `linux/`. For the rpm, the licence text must be shipped through **`bundle.rpm.files`**, consumed by the bundler's custom-files loop (issue: `rpm.rs:215`), mapped to `/usr/share/licenses/archimedes/LICENSE` (the Fedora-recommended `%license` landing path — matching the identifier `codes.archimedes.desktop`, whose RPM package name the blueprint already sets to `archimedes`).

## Which surface actually wins — and why the plan sets all of them

Resolution order per the issue's quoted `rust.rs:1659-1675`: **`bundle.license` beats `Cargo.toml package.license`**. So `tauri.conf.json` is the *effective* source for every bundle; the Cargo.toml field is the documented Cargo fallback and the crate-metadata surface (visible to `cargo metadata`, crates.io, licence scanners). Both are set; the plan says plainly that **`bundle.license` is the one that wins**, so `tauri.conf.json` is the notation that must stay byte-exact.

## Owned file set — plan edits ONLY these

| File | Action | Content |
|---|---|---|
| `LICENSE` | **new** (repo root) | the full MIT licence text |
| `package.json` | edit | `"license": "MIT"` |
| `src-tauri/Cargo.toml` | edit | `license = "MIT"` in `[package]` |
| `src-tauri/tauri.conf.json` | edit | `bundle.license` + `bundle.linux.rpm.files` |
| `README.md` | edit | a licence line (anchor: see README step) |
| `docs/decisions/0085-mit-licence.md` | **new** | house-format ADR |

## Steps

- [ ] **1. Create `LICENSE` at the repo root with the full MIT text** (the standard template — quoted verbatim in the grounding, Section 4; it is the SPDX/choosealicense public-domain template). The copyright line is `Copyright (c) 2026 Daniel Cherubini` — the **git author identity** measured on every shipping commit including HEAD (`git log -3 --format='%h %an <%ae>' f5ba339` → `Daniel Cherubini <daniel@cherubini.casa>`), because the repo carries no author metadata at all (`Cargo.toml` still has the unfilled `authors = ["you"]` placeholder; no `author` in package.json). **This line is a human-veto point at review** — the exact wording is the holder's call, not an implementation detail; the plan records the identity used and why.
- [ ] **2. `src-tauri/tauri.conf.json` — add `bundle.license` and the rpm files map** (this is the load-bearing fix; the bundler's resolution order prefers `bundle.license` over Cargo). Insert **inside** `bundle` (alphabetical jq tag order: `active`, `category`, `createUpdaterArtifacts`, `icon`, `license`, `linux`, `shortDescription`, `targets`):
  ```json
      "license": "MIT",
      "linux": {
        "rpm": {
          "files": {
            "../LICENSE": "/usr/share/licenses/archimedes/LICENSE"
          }
        }
      },
  ```
  Notes: `license` is byte-exact `MIT` (a space or `mit` passes every CI gate and dies only at rpmlint out-of-band, so the string is acceptance-critical). `files` values are install destinations; the source path is **relative to the `src-tauri/` directory** (`tauri.conf.json`'s dir), hence `../LICENSE`. Both keys are verified present in the shipped `config.schema.json` (`BundleConfig.properties.license` type `["string","null"]` with the Cargo.fallback description; `LinuxConfig.properties.rpm.files` object of string→string with `"default": {}`). Do **not** touch `version` — the three-file version rule (AGENTS.md `## Releasing`, enforced by `scripts/check-versions.sh` in ci.yml) is untouched by every edit in this plan (see Acceptance).

  > **CORRECTION (post-implementation review, this plan is wrong about the map's direction):** the orientation above is reversed — `bundle.linux.rpm.files` is **key = path inside the package, value = on-disk source** (the bundler iterates `for (rpm_path, src_path) in settings.rpm().files.iter()`, `linux/rpm.rs:215`, re-read at tag `tauri-cli-v2.12.2`). The shipped pair is therefore `{ "/usr/share/licenses/archimedes/LICENSE": "../LICENSE" }`, and the verbatim block and acceptance criterion 2 above are superseded by ADR 0085, which carries the corrected form.
- [ ] **3. `src-tauri/Cargo.toml` — add `license = "MIT"` to `[package]`**, as the Cargo fallback / crate-metadata surface: one line, e.g. directly after `version = "0.9.0"` / before `description`. The `^version = "…"` line-anchored sed in `scripts/check-versions.sh` cannot match `^license`, so the version check is unaffected. `cargo metadata --no-deps` must then report `license: 'MIT'`.
- [ ] **4. `package.json` — add `"license": "MIT"`** (alphabetical top-level placement: `"license"` between `"identifier"`-absent position, i.e. after `"dependencies"`/before `"name"` or safely anywhere top-level — convention: after `"name"`; jq tag order places it after `dependencies`). **`"private": true` means this is tooling hygiene only** — nothing is ever published to npm from this manifest, so it carries no legal weight and no shipped-license mechanism; it exists so tooling (licence scanners, `pnpm`, dependabot) reads a real value.
- [ ] **5. `README.md` — add the licence line** at the intro-block anchor (the grounding identifies two licence-free candidates — intro paragraph or a new `## License` section; only one anchor is used, so use the **intro-block anchor: add one line under the `See [CONTEXT.md](CONTEXT.md)…` paragraph**). Suggested wording, matching the issue's "a line in `README.md`":
  > Licensed under the [MIT License](LICENSE).
  
  Link form is preferred (the root `LICENSE` file is added by this plan), so a plain `[MIT License](LICENSE)` text link. Do **not** add a `## License` section — the grounding confirms house style has none, and a link is all the issue asks for.
- [ ] **6. Add `docs/decisions/0085-…md` — the licence ADR, in house format.** The number is **the next free ADR number** (verified the 0064-documented way over `git log --all --diff-filter=A`: 0085 appears nowhere). The **outcome of the void checklist item 6**
  is recorded here, **not** in `docs/roadmap/multi-platform-build-and-release.md` — that file was deleted (commit `b3220ed`) when its own roadmap shipped, so there is nothing to edit and nobody should go looking for it (see Acceptance, void item). Outline:

  ```markdown
  ---
  status: accepted
  date: 2026-10-29
  superseded-by:
  ---

  # The project's licence IS MIT, SPDX form `MIT`, and the identifier rides every packaging surface

  Opening thesis paragraph (3–6 sentences, bold/keyword form, house style — see ADR 0077):
  the repo ships an rpm whose `License` tag is empty by design
  (`license().unwrap_or_default()`, issue #28); the licence choice is a legal stance,
  not a build detail; the owner chose MIT; the SPDX string is what survives into the rpm
  header; wire it through every surface the bundler reads — `bundle.license` wins over
  `Cargo.toml package.license` (resolution order, issue-quoted rust.rs), and the licence
  TEXTS ship via `bundle.rpm.files` → `/usr/share/licenses/archimedes/LICENSE` because
  `licenseFile` is NSIS/WiX/DMG-only, never Linux.

  ## The decision
  MIT; SPDX form `MIT`; holder `Daniel Cherubini` (git author identity, veto point);
  identifier in `tauri.conf.json` `bundle.license` (effective), `Cargo.toml`
  `[package] license`, `package.json` `license` (private → tooling hygiene), the text in
  root `LICENSE`; shipped inside the rpm at `/usr/share/licenses/archimedes/LICENSE` via
  `bundle.rpm.files`.

  ## Considered Options
  MIT (chosen) / Apache-2.0 / `MIT OR Apache-2.0` (dual) — and why the rejected two lost
  (copyleft obligations for an app whose binaries embed vendored components; the dual
  form adds obligation complexity without fixing any rpmlint-recognised problem for this
  project). Also note the CONSTRAINT: the string must be rpmlint-valid (error-severity
  `no-license` on empty, `invalid-license` on unrecognised) — a non-distributable string
  makes the rpm unusable downstream rather than merely lint-dirty.

  ## Consequences
  rpm `License:` tag becomes `MIT` (the empty `unwrap_or_default()` default is silenced
  by an actual Some); `rpm -q archimedes --qf '%{LICENSE}'` and rpmlint's
  `no-license`/`invalid-license` both go quiet on the next real build; the decision is
  durable in the repo (ADR + LICENSE + README); the OLD deferral doc the issue pointed to
  is deleted, so **checklist item 6 is recorded here instead**; the deb remains
  licence-text-free (bundler emits no License field and no `debian/copyright` — out of
  scope for this issue, recorded for honesty).
  ```

## Acceptance criterion — SPLIT: what this branch can prove vs what is deferred

**This is a proof ceiling, stated honestly, not papered over:** `rpmbuild` and `rpmlint`
are **NOT installed** on this machine (only `/usr/bin/rpm` 6.0.2 is), and no rpm artifact
can be produced on this branch (the rpm is only ever built by CI's release workflow —
`tauri-apps/tauri-action@v1` on `ubuntu-latest`). So the issue's checklist demand — a real
rpm whose header `License` is non-empty, `rpm -qlp` listing the licence file, rpmlint
without `no-license` — **cannot be answered from this branch**. And CI will **not** catch a
wrong licence either: `release.yml`'s only rpm assertion is a glob count by filename
(`release.yml:331` → `-name '*.rpm'`, in the dispatch-mode "Assert the bundles were built"
step), never a header or file-list inspection, and no schema validation of
`tauri.conf.json` runs anywhere in CI. Two consequences the plan refuses to paper over:
(a) no acceptance criterion below claims an rpm was inspected — that proof lands on the
**next real release build** (the release leg), and (b) the SPDX string is guarded only by
human review, so it is spelled byte-exact in every step above and the reviewer checks it.

### Verifiable locally on this branch (these are THE acceptance criteria)

1. [ ] **`LICENSE` exists at the repo root** and its text matches the standard MIT template exactly (the grounding's Section 4 quote is the reference), with the `&lt;year&gt;`/holder line filled as `2026 Daniel Cherubini` unless a human vetoes the wording at review.
2. [ ] **JSON validity + schema validity of `src-tauri/tauri.conf.json`**: `jq empty src-tauri/tauri.conf.json` succeeds; `bundle.license == "MIT"` and `bundle.linux.rpm.files == {"../LICENSE": "/usr/share/licenses/archimedes/LICENSE"}` — and the multi-line `bundle` block still ends `},` exactly as the above verbatim block does (no trailing-comma drift). Schema keys verified against the pinned CLI's shipped `config.schema.json` (`@tauri-apps/cli` 2.12.2), so this is checked against the same schema `tauri build` will use (that validation itself only runs in a real build, which this branch does not do).
3. [ ] **TOML parses**: `cargo metadata --no-deps` succeeds and reports `license: 'MIT'` for the `archimedes` package.
4. [ ] **`package.json` is valid JSON** with `"license": "MIT"` (and still `"private": true`).
5. [ ] **README** carries one licence line; **`docs/decisions/0085-…md`** exists with the house front-matter and the sections above.
6. [ ] **`scripts/check-versions.sh` still passes and agrees it is unaffected** — run `bash scripts/check-versions.sh` from the repo root: must print `versions match: 0.9.0`. The grounding (and the script's source, read in full) confirms it extracts exactly three `version` fields via line-anchored `sed 's/^version = /…/'` (TOML) and `jq -r '.version // empty'` (JSON) — a `license = "MIT"` line and `"license"`/`bundle.*` keys cannot collide with either extractor — so the three-file rule (AGENTS.md `## Releasing`, ci.yml `scripts` job) is untouched by every edit here. State this in the vet note rather than assuming it.
7. [ ] **Gate green** (the branch gates, run from the integrated tree after this plan's edits): `pnpm test`, `pnpm build` (repo root); `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check` (src-tauri/).

### Deferred to the next real release build (NOT local acceptance criteria — no claim made)

- [ ] On a real rpm produced by a release-leg build: `rpm -qp --qf '%{LICENSE}' <rpm>` prints `MIT` (non-empty); `rpm -qlp <rpm>` lists `/usr/share/licenses/archimedes/LICENSE`; `rpmlint` on the rpm no longer reports `no-license` (and not `invalid-license`). The natural place to exercise this without shipping is the release workflow's `workflow_dispatch` rehearsal mode (the same mode that gives its count-by-glob assertion teeth today), optionally after `sudo apt-get install rpm rpmlint` in the Linux build job — but **adding that CI step is a separate change outside this task's owned files** (`.github/workflows/release.yml` is not in the A4 owns set); it is recorded here as the issue's un-met proof, not silently dropped.

## Void checklist item — say it so nobody goes looking

The issue's checklist item 6 ("Update `docs/roadmap/multi-platform-build-and-release.md:140-143` from 'Flagged, not fixed'…") is **V O I D**: that file was deleted (commit `b3220ed`) when its own roadmap shipped, so there is nothing to edit. The status file already rules this: "**A4's last checklist item is void.** … The outcome is recorded in the new ADR instead." The ADR (step 6) is where the outcome lives. Do not search for the file and do not recreate it.

## Facts carried forward (so the implementer does not re-derive them)

- **Git identity used for the copyright line:** `Daniel Cherubini <daniel@cherubini.casa>` — measured (every recent commit incl. HEAD `f5ba339`), not guessed; the repo has no other author metadata (`authors = ["you"]` Cargo placeholder). **Human veto point** at review for the exact copyright wording.
- **`bundle.license` wins over `Cargo.toml package.license`** (issue-quoted `rust.rs:1659-1675` resolution order) — set both, treat `tauri.conf.json` as the effective source.
- **`bundle.licenseFile` is NSIS/WiX/DMG-only** — the rpm licence text ships via `bundle.linux.rpm.files` (this map becomes the first `linux` subtree; `bundle.linux` is `null` today).
- **Upstream line numbers are quoted from the issue only** — the vendored tauri-cli/tauri-bundler sources are not readable on this machine; never re-quote them as verified.
- **`package.json` is `"private": true`** — its `license` field is tooling hygiene only.
- **`scripts/check-versions.sh` reads only the three `version` fields** — licence additions to those same files cannot interact with it; it is unaffected and is still a gate (`ci.yml` `scripts` job).
- **SPDX string is byte-exact `MIT`** — a space-padded or lowercased variant passes every CI gate here and dies only in rpmlint, so its exactness is a review check, not a machine check.
- **ADR 0085 is the next free number** and the house front-matter is `status: accepted` / `date: 2026-10-29` / empty `superseded-by:`; the ADR is a durable decision record, **not** a config comment (this repo's convention).

## Sources

- Issue: `gh issue view 28 --repo danielcherubini/archimedes --json body` (read in full — root-cause chain, checklist, void item, deb/rpm asymmetry).
- Grounding: `docs/roadmap/backlog-79-122-124-28-ground-packaging-licence.md` (all verbatim blocks above are from its Sections 1/2/4/5/6/7/9).
- Status/decision: `docs/roadmap/backlog-79-122-124-28-status.md` (MIT decision, A4 owns set, both proof-ceiling blockers, void item).
- Schema: `node_modules/.pnpm/@tauri-apps+cli@2.12.2/node_modules/@tauri-apps/cli/config.schema.json` (`bundle.license`, `bundle.licenseFile`, `linux.rpm.files` — existence + types verified by direct read).
- Verifiers: `cargo metadata --no-deps` (baseline `license: None`), `jq '.bundle | keys'` (`null` linux), `git ls-files | grep -iE 'licen|copying'` (empty), `which rpmbuild rpmlint` (absent), `git log` identity, `scripts/check-versions.sh` (full read), `.github/workflows/release.yml:331` (glob only), `AGENTS.md:47-78`.