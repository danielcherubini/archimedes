# Archimedes Desktop — Tauri agent runtime for the desktop app

This repo is the monorepo for the **Archimedes Desktop** application — a cross-platform (Windows/macOS/Linux) Tauri 2 app that runs coding agents in-process. Rust backend (`src-tauri/`) + React 19 / TypeScript frontend (`src/`). See `CONTEXT.md` for project-wide terminology.

## Build & Testing

Validation runs from two roots — the frontend from the repo root, the Rust backend from `src-tauri/`.

| What | Command | Where |
|------|---------|-------|
| Frontend unit tests | `pnpm test` | repo root |
| Frontend type-check + build | `pnpm build` | repo root |
| Rust tests | `cargo test` | `src-tauri/` |
| Rust lint | `cargo clippy --all-targets` | `src-tauri/` (must be 0 warnings) |
| Rust formatting | `cargo fmt --check` | `src-tauri/` |

`cargo test` is one call per target (`--lib`, `--bin`, `--test`), and `--lib` does **not** rebuild `bin/fake_worker.rs`. If a fixture looks like it is lying (e.g., `manager::tests` failing after a protocol change), run `cargo build --all-targets` first.

The Rust compiler is pinned in `src-tauri/rust-toolchain.toml`, so plain `cargo …` from `src-tauri/` is the pinned one — CI installs from that same file rather than naming a version. Do not float it: a newer rustc adds lints, and a lint CI hits that a local toolchain cannot see reddens `main` unreproducibly.

`@tauri-apps/cli` is pinned to the exact `tauri` version in `src-tauri/Cargo.lock` for the same reason: the CLI *is* the bundler that writes the AppImage/deb/dmg/NSIS artifacts, so a Rust-side Tauri bump must move it in the same commit. A floated CLI changes shipped output — desktop entries, bundle metadata — that no local build reproduces.

The `pi-archimedes` monorepo (the agent-side extension suite, a separate repo) is validated with `pnpm test` + `pnpm -r exec -- tsc --noEmit` from its root.

## Build Commands

- **Local development** (`src-tauri/`): `cargo run`
- **Frontend development** (repo root): `pnpm dev`
- **Frontend production bundle** (repo root): `pnpm build`
- **Rust release artifacts**: `cd src-tauri && cargo build --release`

## Project Structure

- `src-tauri/src/`: Rust implementation of the agent harness, includes drivers, commands, tests, and the Tauri plugins.
- `src/`: React + TypeScript frontend, including components, store, utils, and the Tauri bridge.
- `docs/`: durable design decisions and roadmap. `docs/features/` contains per-actor obligations. `docs/decisions/` holds ADRs (Architecture Decision Records). `docs/roadmap/` is gitignored (staged work that `finish` will delete).
- `src-tauri/resources/` holds internal assets; `src/assets/` holds UI resources.

## Validation Notes

- The Rust compiler is pinned (`src-tauri/rust-toolchain.toml`), so run `cargo …` **from `src-tauri/`**; any `cargo` from elsewhere picks up a newer version.
- `cargo test --lib` does not rebuild `bin/fake_worker.rs`; stale fixtures surface as `manager::tests` failures after a protocol change — run `cargo build --all-targets` first.
- `TMPDIR` is not a usable workaround for temp-dir pressure in the Rust suite. Some `commands::files` tests PANIC unless the temp dir's `readdir` is unsorted (i.e. a tmpfs). Those tests shell out to `TMPDIR=/tmp mktemp`, pinning `/tmp` explicitly. So pointing `TMPDIR` at a real disk fixes most tests and breaks those four. Two `sandbox` tests also `TMPDIR=/tmp mktemp`.
- `grep -c '#\[cfg(unix)\]'` counts lines, including prose that names the attribute. A census count needs the anchored `^#\[cfg(unix)\]$` or it false-reports high.
- `src/App.test.tsx` does not mock `vi.mock("./lib/tauri")`. That file's factory spreads `importActual`, so an un-mocked export resolves to the real wrapper, which rejects outside a webview; the boot `Promise.all` rejects and its `.catch` swallows the reason. If `App.tsx` gains a boot fetch, add its mock in the same commit. Many other tests need a booted store and fail on `activeSpacePath: null`. When you add a store field, grep that file rather than assuming the new field starts clean.
- Many `describe` blocks in `src/store/sessions.test.ts` never call `resetStores()`, so they inherit whatever a previous block left in the store; shuffling tests fails. Nothing runs shuffled (no `shuffle` in `vitest.config.*`, `package.json`, or CI), so `pnpm test` is legitimately green — but a new test that asserts on store state must reset first, or it can pass for a reason nobody intends.
- Some test imports and assertions cross into the agent harness types; those are covered by `cargo test` and never require a full CI.

## Branch Strategy

- **Squash‑merge feature branches into `main`** (one commit per feature). The history on `main` is linear and each commit is a self‑contained, tested change.
- `docs/roadmap/` is gitignored (`.gitignore:31`). Every branch that has a "plan” cleans up its own artifact family before or during `finish`. The dashless `harness-trust-and-cost*` glob matches 21 of 22 files and leaves the spec file orphaned; a `harness-*` glob also swallows this branch’s own `harness-cost-close-out*` family — so the suffix choice is load‑bearing.
- The `release` skill runs at Step 1 on `package.json`, `src-tauri/Cargo.toml`, and (Step 5) also `src-tauri/tauri.conf.json`. The three values must match; the guard `scripts/check-versions.sh` enforces it on CI.

## Development Guide Links

- `AGENTS.md` — agent-skill usage conventions for this repo.
- `CONTEXT.md` — master terminology and structure notes.
- `docs/features/` — the "open work" / "recorded, not open work" ledger.
- `docs/decisions/` — ADRs (append‑only, bridged, never edited in‑place).

## License

This repo is part of the `pi‑archimedes` ecosystem and is maintained under the project‑wide license. See `.github` / `.gitignore` for details.
