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

## Conventions

- **TDD**: write the failing test first, confirm it fails, then make it pass.
- **Squash-merge** feature branches into `main` (one commit per feature).
- **Docs**: durable design decisions live in `docs/decisions/NNNN-slug.md`
  (ADR format); in-flight plans live in `docs/roadmap/<feature>.md` and are
  deleted on ship.

