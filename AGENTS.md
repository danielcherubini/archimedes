# AGENTS.md

Archimedes Desktop — a cross-platform (Windows / macOS / Linux) Tauri 2 app
that runs coding agents in-process — the desktop's own Rust runtime is the
only Agent harness (a native session, ADR 0022). Rust backend (`src-tauri/`)
+ React 19 / TypeScript frontend (`src/`). See `CONTEXT.md` for terminology
and `docs/decisions/` for ADRs.

## Build & Testing

Validation runs from two roots — the frontend from the repo root, the Rust
backend from `src-tauri/`. A branch is ready to merge when all of these are
green:

| What | Command | Where |
|------|---------|-------|
| Frontend unit tests | `pnpm test` | repo root |
| Frontend type-check + build | `pnpm build` | repo root |
| Rust tests | `cargo test` | `src-tauri/` |
| Rust lint | `cargo clippy --all-targets` | `src-tauri/` (must be 0 warnings) |
| Rust formatting | `cargo fmt --check` | `src-tauri/` |

The Rust compiler is pinned in `src-tauri/rust-toolchain.toml`, so plain
`cargo …` from `src-tauri/` is the pinned one — CI installs from that same
file rather than naming a version. Do not float it: a newer rustc adds lints,
and a lint CI hits that a local toolchain cannot see reddens `main`
unreproducible.

`@tauri-apps/cli` is pinned to the exact `tauri` version in
`src-tauri/Cargo.lock` for the same reason: the CLI *is* the bundler that writes
the AppImage/deb/dmg/NSIS artifacts, so a Rust-side Tauri bump must move it in
the same commit. A floated CLI changes shipped output — desktop entries, bundle
metadata — that no local build reproduces.

The reason is live, not historical: an older CLI exports the now-deprecated
`STATIC_VCRUNTIME` — the 2.11.4 the floated `^2` resolved to here before the
pin still does, 2.12.2 no longer does — and a newer `tauri-build` turns that
into a `cargo:warning=` (`tauri-build` 2.7.2, `src/lib.rs:939-941`). The skew
is easy to miss either way, because cargo replays a build script's stored
warnings from before the fix — a rebuild can print a warning the current
version pair no longer produces, so check the two versions rather than
trusting the warning.

The `pi-archimedes` monorepo (the agent-side extension suite, a separate repo)
is validated with `pnpm test` + `pnpm -r exec -- tsc --noEmit` from its root.

## Releasing

**The version lives in THREE files**, and nothing but the check script knows
all three: `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json`. The first two are the ones a bumping tool can
find; the third is Tauri's bundle version, and it is the one that ends up in
the artifact names, the updater manifest and the About box. A release where it
was left behind produces a bundle labelled with the previous version — which
the updater then reads as "already newer", so the drift is not cosmetic. The
`release` skill's version table knows the first two, so the step below exists
for the third. CI enforces it: `scripts/check-versions.sh` (the `scripts` job
in `.github/workflows/ci.yml`) fails any PR where the three disagree, so a
forgotten file reddens the PR that introduced it rather than the release.

**Skill-executable step** (the `release` skill reads this file at Step 1 and
applies release instructions at Step 5, so this is written to be executed, not
just read): after the skill's automated bump, set `version` in
`src-tauri/tauri.conf.json` to the SAME `X.Y.Z`, then run
`bash scripts/check-versions.sh` from the repo root and require it to print
`versions match: X.Y.Z` before tagging. The bump commit covers all three
files. The values stay bare `X.Y.Z` — no `v` prefix (the tag carries the `v`;
the manifest composer rejects a `v`-prefixed version precisely because the two
are not interchangeable).

- The minisign private key and its password live as GitHub secrets —
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — and
  nowhere in the repo; the public half is committed in
  `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, because that is
  what every installed client verifies signatures against.
- A keypair MISMATCH is **warn-only** in CI (tauri-cli logs it and carries on),
  so CI cannot be the check: verify the pair locally before tagging — the
  ceremony is in README's `## Releasing` section.
- **A draft is not a shipped release.** The updater endpoint is
  `/releases/latest/download/latest.json`, and that path serves only a
  published, non-prerelease release — a draft 404s, which every installed
  client reads as `release-not-found`. Hence `release.yml` publishes LAST,
  after the manifest is uploaded.
- **macOS packaging is gated on the `APPLE_*` signing secrets** and is silently
  skipped while they are absent — the matrix rows exist in `release.yml` but
  the step gate refuses, so "no macOS asset" on a release means no secrets, not
  a failed build.

## Conventions

- **TDD**: write the failing test first, confirm it fails, then make it pass.
- **Squash-merge** feature branches into `main` (one commit per feature).
- **Docs**: durable design decisions live in `docs/decisions/NNNN-slug.md`
  (ADR format); in-flight plans live in `docs/roadmap/<feature>.md` and are
  deleted on ship.

