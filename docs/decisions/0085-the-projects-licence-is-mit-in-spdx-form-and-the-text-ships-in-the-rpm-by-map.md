---
status: accepted
date: 2026-10-29
superseded-by:
---

# The project's licence IS MIT, in SPDX form `MIT`, and the identifier rides EVERY packaging surface — because `bundle.license` wins over Cargo and the licence TEXT rides the rpm only through `bundle.linux.rpm.files`

No file in this repo carried a licence, so the Fedora bundle shipped an **empty `License` tag** ([issue #28](https://github.com/danielcherubini/archimedes/issues/28)): the bundler resolves the licence as `Option` and the rpm writer runs `settings.license().unwrap_or_default()`, so the missing decision is written into the header as the empty string, verbatim. A licence is a **legal stance, not a build detail**, which is why the choice was the owner's and not this branch's — and the owner chose **MIT**, SPDX string **`MIT`**. The identifier is now declared on every surface the bundler and the toolchains read: `bundle.license` in `tauri.conf.json` (the one that **wins**), `Cargo.toml` `[package] license` (the documented fallback and the crate-metadata surface), `package.json` `license` (tooling hygiene — the manifest is `private: true`), and the licence **text** in a root `LICENSE`. The load-bearing part is that the identifier alone is not enough for the rpm: `bundle.licenseFile` is read for **NSIS/WiX/DMG only** and does nothing on Linux, so the text ships inside the rpm through **`bundle.linux.rpm.files`**, mapped to `/usr/share/licenses/archimedes/LICENSE`.

## The decision

**MIT, SPDX form `MIT`.** Byte-exact, in every surface. The string is not free-form prose: rpmlint validates it against its licence list and reports error-severity `no-license` on an empty tag and `invalid-license` on an unrecognised one, so a non-distributable string makes the rpm **unusable downstream**, not merely lint-dirty. A space-padded or lowercased variant (`"mit "`) passes every gate this repo has and dies only out-of-band, which is why exactness is a review check here and not a machine check — see the honesty section.

**Copyright holder: `Daniel Cherubini`, year `2026`** — `Copyright (c) 2026 Daniel Cherubini` in `LICENSE`. **This line is a human-confirmable detail, not an implementation fact.** The repo carries no author metadata of its own to derive it from: `Cargo.toml` still holds the generated `authors = ["you"]` placeholder (left untouched — it is not this decision's to fix, and filling it would be a separate claim), and `package.json` has no `author` field. So the only measured identity available is the **git author identity on every shipping commit** — `git log --format='%an <%ae>'` gives `Daniel Cherubini <daniel@cherubini.casa>` throughout, and the first commit lands 2026-09-15, which is where the year comes from. A reviewer with knowledge of a legal entity behind the project should veto and replace the holder line; nothing about the packaging wiring changes if they do.

**Four declarations, one winner.** The resolution order the issue quotes from the vendored `tauri-cli` (`rust.rs:1659-1675`) is `bundle.license` → else `Cargo.toml package.license` → else `None`. So:

| Surface | Value | Role |
|---|---|---|
| `src-tauri/tauri.conf.json` `bundle.license` | `"MIT"` | **The effective source.** It beats Cargo for every bundle. This is the notation that must stay byte-exact. |
| `src-tauri/Cargo.toml` `[package] license` | `"MIT"` | The documented Cargo fallback, and the crate-metadata surface (`cargo metadata`, crates.io, licence scanners). |
| `package.json` `license` | `"MIT"` | **Tooling hygiene only** — `"private": true` means nothing is ever published from this manifest, so the field carries no legal weight and ships nothing. |
| `LICENSE` (repo root) | full MIT text | The licence itself, and the source of the file the rpm carries. |

`README.md` gains one line, `Licensed under the [MIT License](LICENSE).`, under the intro block — the issue asks for "a line in `README.md`", and the house style has no `## License` section, so no section was invented.

**The licence TEXT rides the rpm through `bundle.linux.rpm.files`, not `licenseFile`.** This is the part that decides whether the fix ships anything:

```json
"license": "MIT",
"linux": {
  "rpm": {
    "files": {
      "/usr/share/licenses/archimedes/LICENSE": "../LICENSE"
    }
  }
}
```

`bundle.licenseFile` is a real, valid key — the shipped schema describes it as *"The path to the license file to be included in the appropriate bundles"* — but the bundler consults it for **NSIS/WiX/DMG only**; nothing under `linux/` reads it. Setting it would have produced a config that validates, a Windows installer that carries the text, and an rpm that carries **nothing** while its `License` tag finally reads `MIT` — a header claiming a licence the package does not contain. `bundle.linux.rpm.files` is a map of **in-package destination → on-disk source**, consumed by the rpm bundler's custom-files loop, which destructures it as `for (rpm_path, src_path) in settings.rpm().files.iter()` (`linux/rpm.rs:215`) — **the key is the path the file lands on inside the package, the value is the file it reads off disk.** So the key is `/usr/share/licenses/archimedes/LICENSE`, Fedora's `%license` landing path under the RPM package name `archimedes` that the release blueprint already sets, and the value is `../LICENSE`; the value resolves relative to `tauri.conf.json`'s directory (`src-tauri/`) because the CLI does `set_current_dir(config_path.parent())` before reading the config, which is what makes `../LICENSE` the repo-root file. `bundle.linux` was `null` before this change — there was no `linux` subtree at all — so this map is the first one in the config.

## Why the identifier and the text are two separate decisions

The `License` **tag** and the licence **file** are independent obligations in an rpm, and this repo was missing both for the same reason. The tag is filled from the resolution chain above, so one string fixes it. The file is a packaging input the bundler has to be *told* about, and on Linux the only lever for that is the `files` map. Fixing only the tag would satisfy the literal defect report and leave the shipped package asserting a licence it does not carry — which is the worse of the two states, because an empty tag is loud and a tag with no matching text looks resolved.

## Considered Options

- **MIT (chosen).** The owner's decision at the planning gate. Permissive, one-line obligations, and `MIT` is a string rpmlint recognises. It matches the posture of a desktop app that exists to drive other people's agents and imposes nothing on the person installing it.
- **Apache-2.0.** Rejected. It carries a patent grant, which is a real argument, but it also carries the NOTICE-file obligation and a longer text, for an app whose shipped binaries already embed a large volume of vendored upstream components (the Tauri runtime, the WebView stack) whose own notices nobody has yet inventoried. Choosing a licence that *requires* a notice-inventory obligation before the inventory exists would make the repo non-compliant with its own chosen licence on the day it adopted it. That is the copyleft-shaped failure mode in miniature, and it is the reason the heavier permissive option lost too, not just the strong-copyleft ones.
- **`MIT OR Apache-2.0` (dual).** Rejected. Dual-licensing adds downstream obligation complexity — the recipient has to know which terms they are under — without fixing any problem rpmlint or Fedora actually flags. `MIT OR Apache-2.0` is also a more fragile string to land byte-exact in a header tag than `MIT`, and this repo's whole remaining risk on this issue is the exactness of one string that no local gate can check.
- **Doing nothing and letting `unwrap_or_default()` keep writing an empty tag.** Rejected: it is the defect, and the asymmetry makes it worse — the **deb** writer emits no `License` field at all, so the missing decision is invisible in the deb and loud only in the rpm. Silence in one format is not evidence the decision was made.

## Consequences

- **The rpm's `License` tag becomes `MIT`** — `unwrap_or_default()` finally has a `Some` to unwrap. On the next real build, `rpm -qp --qf '%{LICENSE}' <rpm>` should print `MIT`, `rpm -qlp` should list `/usr/share/licenses/archimedes/LICENSE`, and rpmlint's `no-license` should go quiet without `invalid-license` appearing in its place. **Deferred, not done** — see the honesty section.
- **The decision is durable in the repo** rather than in a config comment: this ADR, the `LICENSE` file, and the README line. `docs/decisions/` is where the repo records decisions, which is what the issue's own checklist asked for.
- **`bundle.license` is the byte-exactness-critical string.** Anyone who later edits the licence must edit `tauri.conf.json` and not assume Cargo is authoritative — the resolution order makes the JSON the winner. If the two ever disagree, the JSON silently wins and the Cargo value becomes a lie that `cargo metadata` keeps telling.
- **The `files` map is now a packaging input that can rot.** `../LICENSE` is a relative path with no local build to verify it resolves. Deleting or renaming `LICENSE` does not fail any gate here; it fails the release build, or worse, silently drops the file from the package. A future move of the licence file must move this mapping with it.
- **The deb stays licence-text-free.** The bundler emits no `License` field and no `debian/copyright` for the deb, so the deb still ships no licence text. That is out of scope for #28 — the deb never claimed to — and is recorded here rather than fixed, so it is not mistaken for covered.
- **`Cargo.toml`'s `authors = ["you"]` placeholder survives this change deliberately.** It is a different claim (authorship, not licensing) and filling it from the same git identity would present a measured guess as repo metadata. Out of set.
- **The issue's checklist item 6 is VOID, and this ADR is where its outcome lives.** It pointed at `docs/roadmap/multi-platform-build-and-release.md:140-143` to flip a line from "Flagged, not fixed". **That file was deleted (commit `b3220ed`) when its own roadmap shipped**, so there is nothing to edit — do not go looking for it and do not recreate it. The outcome of that item ("choose the licence and record it") is this record.

## The number 0085 — checked, not assumed

`git log --all --diff-filter=A --name-only --format="" -- docs/decisions/ | grep -E "0085"` prints **nothing**, so 0085 is free on every branch and no gap is being filled (0064's rule: ADR numbers are append-only, gaps are not filled; 0084 restates it). The highest file present is `0084-…`. Recorded the same way 0084 recorded its own number, because `ls docs/decisions | tail -1` only sees the working tree and this repo has been bitten by numbering races twice.

## Honesty about what this branch could NOT check

**The rpm proof is deferred to a real release build. Nothing here inspected an rpm.** `rpmbuild` and `rpmlint` are **not installed on this machine** — only `/usr/bin/rpm` 6.0.2 is — and no rpm artifact exists in this tree, because the rpm is only ever built by CI's release workflow (`tauri-action@v1` on `ubuntu-latest`). So issue #28's checklist demand — a non-empty header `License`, `rpm -qlp` listing the licence file, a clean rpmlint run — **cannot be answered from this branch, and no claim to having answered it is made here.**

**CI will not catch a wrong licence either.** `release.yml`'s only rpm assertion is a count-by-glob of filenames (`-name '*.rpm'`, in the dispatch-mode "Assert the bundles were built" step). It never opens an rpm, never reads a header, never lists a file, and nothing in CI schema-validates `tauri.conf.json`. The natural home for the missing proof is that workflow's `workflow_dispatch` rehearsal mode — the mode whose assertion step exists precisely to give build-only runs teeth — optionally after `sudo apt-get install rpm rpmlint` in the Linux build job. **Adding that step is a separate change outside this task's owned files** (`.github/workflows/release.yml` is not in this set), so it is recorded as the issue's un-met proof rather than silently dropped.

**What WAS checked locally, and what that does not buy:**

- Every key added was validated against the schema the **pinned** `@tauri-apps/cli` 2.12.2 ships (`config.schema.json`): `BundleConfig.properties.license` exists, `bundle.linux` → `LinuxConfig.properties.rpm` → `RpmConfig.properties.files` exists and is an object of string→string with `"default": {}`. All three containers set **`additionalProperties: false`**, and a full ajv validation of the edited `tauri.conf.json` against that schema passes — with a negative control proving the validator has teeth: `licens`, `rpm.file`, and `linux.rpmb` are each **rejected**. (Five Rust-dialect `pattern` keywords in the schema are dropped for that check only, because JS's `u`-flag regex compiler rejects one of them; they govern `identifier`/`productName` strings, never the licence keys under audit.)
- **Three failure modes the schema cannot see, stated so nobody over-trusts the green check:** the string `"mit "` or `"mit"` (type-legal, rpmlint-lethal); `bundle.licenseFile` set *instead of* the `files` map (a valid key that does nothing on Linux); and a **swapped** `files` pair — `files` is string→string in both directions, so destination and source reversed validates perfectly and installs the licence to the wrong path. All three are review checks, and none of them is machine-checked here. **The swapped pair is not hypothetical: the map first shipped as `{ "../LICENSE": "/usr/share/licenses/archimedes/LICENSE" }`, and that is what the hand check missed.** At the pinned version the bundler reads the value as the disk source (`for (rpm_path, src_path) in files.iter()`), so the reversed pair asks it to read `/usr/share/licenses/archimedes/LICENSE` from disk; that path does not exist, `is_file()` is false, the `walkdir::WalkDir::new(src_path)` branch is taken on a non-existent path, and `tauri build --bundles rpm` fails in the release build. It was caught in review by reading the bundler's loop, not by any gate in this repo. The orientation is therefore a review check that must be re-made by anyone who edits this map: **key = path inside the package (absolute), value = source file (relative to `src-tauri/`)**.
- `cargo metadata --no-deps` reports `license: "MIT"` for the `archimedes` package (baseline before this change: `null`), and the TOML parses.
- `LICENSE` was byte-compared against the canonical SPDX/choosealicense MIT template with the year/holder line filled, and carries no leftover `<year>` or `<copyright holders>` placeholder.
- `scripts/check-versions.sh` still prints `versions match: 0.9.0` — including in `--tag` mode. It reads exactly three `version` fields (a line-anchored `sed 's/^version = /…/'` on the TOML, `jq -r '.version // empty'` on the two JSON files), so a `license` line cannot collide with either extractor; the three-file rule in AGENTS.md `## Releasing` is untouched by every edit here.
- The upstream line numbers in this ADR (`rust.rs:1659-1675`, `settings.rs:1257-1259`, `rpm.rs:61`) are **quoted from issue #28, not re-verified here** — the vendored `tauri-cli`/`tauri-bundler` sources are not in this tree and the crates are not in the local cargo registry cache. They are cited as the issue's root-cause chain, and the config surface is what this change was actually built against. **One line has since been re-read upstream: `rpm.rs:215`'s custom-files loop, fetched at the pinned tag `tauri-cli-v2.12.2`, which is what established the map's direction (`for (rpm_path, src_path) in files.iter()` — key is the in-package path) and exposed the reversed pair this record now corrects. The `set_current_dir(config_path.parent())` claim about how the value resolves is likewise read from that pinned tag (`tauri-cli/src/helpers/config.rs:197`), not inferred.**
