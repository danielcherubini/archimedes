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

**Skill-executable final step — write the release notes.** This one runs AFTER
the skill's tag push and after `release.yml` has published (it is the only step
here that cannot run before the tag exists, so run it last and do not skip it
because the workflow "already did it"). `release.yml` now puts GitHub's
*generated* notes on the release automatically, so what remains — and what no
workflow can do — is writing notes a person would read.

1. Generate the draft:
   `bash scripts/release-notes.sh --repo "<owner>/<repo>" --tag vX.Y.Z --out /tmp/notes.md`
   — the markdown body goes to `--out`, the one-line summary to stdout. Do NOT
   call `POST /releases/generate-notes` by hand: it does not validate
   `tag_name`, so a tag with no release behind it answers 200 with confident,
   correctly-formatted notes describing the PREVIOUS release. The script refuses
   that case; two `gh` lines in a terminal do not.
2. **Rewrite it.** The generated list is squash-merged PR subjects with
   `by @user` suffixes — accurate, and not something to ship as the notes. Group
   by what a user would notice (New / Fixed / Changed), drop internal-only
   entries (`docs`, `chore`, CI, test-only), keep the PR links for what stays,
   and open with the one change worth upgrading for. The script's output is the
   floor, not the result.
3. Apply: `gh release edit vX.Y.Z --notes-file /tmp/notes.md`.
4. Refresh the in-app text too — Settings → Updates renders the `notes` field of
   `latest.json`, NOT the release body, so step 3 alone leaves the app showing
   one line. Download every `*.sig` plus `latest.json` off the release, re-compose
   the manifest over the downloaded one, and re-upload it with `--clobber`. This is
   the ONE ceremony step no workflow runs for you, so it is written out as the two
   commands that actually decide the outcome — the completeness gate, and the
   composer it feeds — in the shape `.github/workflows/release.yml`'s
   "Compose latest.json" step uses them:

   ```bash
   set -euo pipefail   # a plain terminal does NOT have this on — see the trap below
   gh release download vX.Y.Z --pattern '*.sig' --dir sigs --clobber
   gh release download vX.Y.Z --pattern latest.json --clobber
   bash scripts/check-release-signatures.sh \
     --repo "<owner>/<repo>" --tag vX.Y.Z > expected-payloads.txt
   require_args=()
   while IFS= read -r payload; do
     # `if`, not `[[ … ]] && …` — mirrored from the workflow comment: the runner's
     # default shell is `bash -e`, and a false test at the end of a compound list
     # aborts. Measured: with a command AFTER the loop the `&&` form survives, but as
     # the LAST command of a step (or inside a function) it aborts the step — so the
     # `if` form is what makes editing this block safe.
     if [[ -n "$payload" ]]; then
       require_args+=(--require-payload "$payload")
     fi
   done < expected-payloads.txt
   bash scripts/compose-updater-manifest.sh \
     --sigs-dir sigs \
     --version X.Y.Z \
     --tag vX.Y.Z \
     --repo "<owner>/<repo>" \
     --out latest.json \
     --notes "<the new one-liner>" \
     ${require_args[@]+"${require_args[@]}"}
   gh release upload vX.Y.Z latest.json --clobber
   ```

   Five of those six flags are enforced by the script itself, which names the one
   you forgot: `--sigs-dir` (where the `--dir sigs` download put the signatures —
   signatures only, never installers), `--version` (bare `X.Y.Z`, never
   `v`-prefixed), `--tag` (the `v` form; the URLs are pinned to it), `--repo`, and
   `--out` (where `latest.json` was just downloaded, which is what makes the
   refusal behaviour below matter). `--notes` is the sixth, and the script DOES
   accept its absence — which is exactly why the workflow passes
   `${NOTES_SUMMARY:-Archimedes $TAG}` rather than omitting it: an empty `notes` is
   legal JSON that passes self-validation, and the in-app panel renders it as the
   whole update description. Pass the one-line summary, never the markdown body.
   **The quotes around the two angle-bracket placeholders above are load-bearing, not
   punctuation:** an UNQUOTED `<owner>/<repo>` is two bash redirections, not an
   argument, so pasting the block never runs the command at all — `<owner` is an
   INPUT redirect from a file called `owner`, and with no such file in the terminal's
   cwd the line dies as `owner: No such file or directory` before the gate or the
   composer is reached (measured; exit 1, no `expected-payloads.txt` created, so the
   loop below would feed the composer ZERO expectations if the line ever got past
   that). If a file called `owner` does exist, the second half bites: `/<repo>`
   redirects output to `/` and bash says `/: Is a directory`. The workflow quotes the
   same argument as `--repo "$GITHUB_REPOSITORY"` for the same reason. Every other
   placeholder in the block is safe to paste: `X.Y.Z` / `vX.Y.Z` are literal-shaped,
   `'*.sig'` is quoted for globbing, `latest.json` / `sigs` / `expected-payloads.txt`
   are plain paths, and the `${require_args…}` expansion is quoted inside.
   `${require_args[@]+…}`
   is copied from the workflow rather than tidied: a bare `"${require_args[@]}"` on
   an EMPTY array is an unbound-variable error under `set -u` on the older bash
   still in wide use (bash fixed it in 4.4; macOS ships 3.2), and an empty
   `expected-payloads.txt` should say what is wrong, not die as a shell fault.

   **The gate writes a FILE and the loop reads it — do not hand-run it as
   `reqs="$(bash scripts/check-release-signatures.sh …)"`.** A terminal has no
   `-e`, so inside `$(…)` a refusal is invisible: every diagnostic the gate prints
   goes to stderr, `reqs` comes back EMPTY, the loop builds ZERO
   `--require-payload` flags, and the composer runs with no expectations at all —
   which is the opt-in, behave-as-it-always-has path that composes the shrunken
   manifest and **exits 0**. Measured on this tree: that shape reaches the compose
   with 0 flags and exit 0. And note where a substitution sits — `-e` judges a
   command by its OWN status, so one buried in a word (an argument, or a here-string
   like `done <<< "$(…)"`) never aborts the block even with `-e` on; only a bare
   `reqs=$(…)` assignment would, and a terminal has no `-e` anyway. Both reasons
   point the same way: the gate's stdout goes to a file, the loop reads the file, and
   `set -euo pipefail` at the top of the block is what stops a refusal AT the gate
   instead of turning it into an unguarded compose — the exact silent shrink this
   whole step exists to prevent.

   The whole step is worth running only when the downloaded `.sig` set is
   COMPLETE, because the composer emits one key per signature it was given and
   **exits 0 on the shrunken result**, so a missing sig publishes a manifest with
   a platform missing over the good one (ADR 0052).
   **COMPLETE means one `.sig` per platform this release targets — not one per
   filename on the release.** On Windows and Linux the payload IS the installer
   (`createUpdaterArtifacts: true` signs the raw `.exe`/`.AppImage`/`.deb`/`.rpm`;
   `tauri-plugin-updater` sniffs the bytes, not the URL), so a correct Linux+
   Windows release has **4 sigs serving 6 keys**: `windows-x86_64` and
   `-nsis` share the `.exe`, `linux-x86_64` and `-appimage` share the
   `.AppImage`. **Decide completeness with
   `bash scripts/check-release-signatures.sh --repo "<owner>/<repo>" --tag vX.Y.Z`,
   which asks the RELEASE's asset list — never the manifest.** Completeness
   cannot be checked against the manifest at all: the composer builds its
   `.platforms[].url` values FROM the very signatures under test, so counting the
   distinct URL names and requiring a `.sig` for each shrinks on both sides
   when a signature was never uploaded — it passes exactly when it should fail
   (issue #41(d)). The script requires a `<name>.sig` beside every installer asset
   and prints the installer list it accepted — that stdout IS the expectation list,
   which is what the `while read` loop above turns into one `--require-payload
   <name>` per line, and what makes this step's re-compose **fail** rather than
   shrink. The flag asserts that `<name>.sig` is in `--sigs-dir`; it does not need
   the installer file itself, because `--sigs-dir` holds signatures only. `.dmg` and
   `latest.json` are on the script's allow-list because they are legitimately
   unsigned and are not updater payloads — leave them there: a release carrying an
   unsigned `.dmg` is healthy, and a check that demanded a signature for it would
   fail every release. What a
   genuinely incomplete set looks like is a *target with no signature at all* (a
   deb built but its `.deb.sig` never uploaded). Re-uploading is otherwise safe:
   the signatures and the tag-pinned URLs come out identical, and
   `tauri-plugin-updater` reads `pub_date` for display only. An incomplete set
   means stop — stale-but-correct notes beat a broken manifest.

   **When the composer refuses, it deletes `latest.json`, so re-download before you
   retry.** Every refusal it reports — every path through its `fail()`, including a
   `--require-payload` refusal — removes a pre-existing `--out`, and it does so
   whatever the flag order: the target is the `--out` you TYPED, found in the
   invocation's own arguments, so a typo two flags short of the end
   (`--verison`, with `--out` last) cannot leave the old manifest behind. So after
   such a refusal the `latest.json` the second download put there is GONE, and the
   `gh release upload` you are about to type
   fails with "no such file or directory" instead of silently `--clobber`-ing the
   OLD manifest over a release whose notes rewrite never landed. (A refusal by the
   GATE is different and safer: the block stops before the compose, so the download
   is untouched.) The composer's deletion is the point (ADR 0052's 2026-10-24
   amendment): a stale manifest sitting at `--out` is the hazard, not the safety net.
   It is also cheap to undo, because the file being removed is a copy of a published
   asset — so fix the sig set, run
   `gh release download vX.Y.Z --pattern latest.json --clobber` to put the baseline
   back, and re-compose from there. What does NOT touch `--out` is everything that
   never reaches `fail()` — i.e. everything that reports no refusal at all: a missing
   `scripts/updater-payload-shapes.sh` (a broken checkout is not a refused
   composition, and a tool that never started has formed no opinion about this
   release, so it must not destroy the operator's download); a legacy value-less flag
   at the END of the line (`… --out latest.json --notes` shifts past the end of argv
   and dies as a shell fault with no message — the flag is the `--notes` / `--arch` /
   `--repo` family, and the fix is to give it a value); and an `--out` path the OS
   refuses (`mkdir: cannot create directory …` before the write). Treat any of them
   as "nothing was decided about `--out`": the file there is still the one you
   downloaded, and uploading it would publish the PREVIOUS
   release's manifest.
5. Confirm, since `release.yml`'s notes step is `continue-on-error` on purpose (a
   release whose notes failed must still ship): `gh release view vX.Y.Z --json
   body -q .body` must show the curated text, not `Archimedes vX.Y.Z` — that
   placeholder is what every release before this step read like.

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
  deleted on ship. Anything a roadmap records that must survive that deletion
  moves while the branch is still open — a durable fact or accepted defect goes
  to `docs/features/` (see `docs/features/mcp-known-gaps.md`) or an ADR, not to
  a comment in the plan.
- **Planning**: when expanding a roadmap task into a plan (`specify`), dispatch
  the `researcher` agent definition (`subagent` with `agentName: "researcher"`)
  rather than a config-less dispatch.

### Working in this repo

These are properties of the repo, not of any branch:

- **`archimedes` is ONE compilation unit**, so a syntax error anywhere breaks
  every scoped `cargo test` run: two Rust implementation tasks can never share a
  wave. Read-only planning dispatches fan out freely. (Established with a planted
  error, not assumed.)
- **`cargo test --lib` does not rebuild `fake_worker`.** A stale
  `bin/fake_worker.rs` binary surfaces as `manager::tests` failing with
  misleading values after a protocol change; run `cargo build --all-targets`
  first when a fixture looks like it is lying.
- **`cargo check --target x86_64-pc-windows-gnu --all-targets` is the only local
  Windows proof** (the mingw target is installed). The msvc target needs `lib.exe`
  and there is no wine here, so `#[cfg(windows)]` code type-checks locally and
  only RUNS on CI's `windows-latest` leg — never describe Windows behaviour as
  behaviourally verified from this machine.
- **`TMPDIR` is not a usable workaround for temp-dir pressure in the Rust
  suite.** Two `commands::files` tests (`completion.rs`, `space_walk.rs`, via
  `assert_readdir_disagrees_with_sorted_order`) PANIC on unix unless the temp
  dir's `readdir` is unsorted — i.e. a tmpfs — because their "the survivors are
  the alphabetically first" assertion needs raw order to disagree with the sort.
  Two `sandbox` tests shell out to `TMPDIR=/tmp mktemp`, pinning `/tmp`
  explicitly. So pointing `TMPDIR` at a real disk fixes most tests and breaks
  those four. (Both halves re-measured, not copied from the plan that recorded
  them.)
- **`grep -c '#\[cfg(unix)\]'` counts LINES, including prose that names the
  attribute.** A census count needs the anchored `^#\[cfg(unix)\]$` or it
  false-reports high.
- **A boot fetch that `src/App.test.tsx` does not mock reddens tests that have
  nothing to do with it.** That file's `vi.mock("./lib/tauri")` factory spreads
  `importActual`, so an un-mocked export resolves to the real wrapper, which
  rejects outside a webview; the boot `Promise.all` rejects and its `.catch`
  swallows the reason. Measured by deleting one boot mock: **3 of the file's 41
  tests fail and only one names the fetch** — the other two are Settings /
  start-failure cases that merely need a booted store and fail on
  `activeSpacePath: null`. When `App.tsx` gains a boot fetch, add its mock in the
  same commit. (Found the hard way adding the third one — and note that only a
  minority of the file's tests need a booted store, so the blast radius is small
  but misleading, not large.)
- **The suite's green depends on file order.** Many `describe` blocks in
  `src/store/sessions.test.ts` never call `resetStores()`, so they inherit
  whatever a previous block left in the store; under
  `npx vitest run src/store/sessions.test.ts --sequence.shuffle` some fail.
  Nothing runs shuffled (no `shuffle` in `vitest.config.*`, `package.json`, or CI),
  so `pnpm test` is legitimately green — but a new test that asserts on store
  state must reset first, or it can pass for a reason nobody intends.
  `src/App.test.tsx` is the extreme case: it never calls `resetStores()` and
  hand-writes `useSessions.setState({...})` key lists per test, so a field the
  list omits survives from one test to the next — when you add a store field,
  grep that file rather than assuming the new field starts clean.
  `src/test/resetStores.ts` also documents that it cannot reach module-`let`
  state, so a store module holding its own bookkeeping needs a named reset.
- **`src/components/MessageBubble.codeblock.test.tsx`'s
  `renders a \`%s\` fence genuinely highlighted` (the `it.each` JSON case) flakes**
  — it intermittently renders the unhighlighted fallback through shiki's async
  path. Pre-existing, unrelated to whatever you just changed: if it fails once,
  re-run before investigating. It needs an owner, not a drive-by fix.
- **`Reasoning.test.tsx`'s `is O(last line), not O(whole text)` is a wall-clock
  assertion and flakes under full-suite load.** It measures
  `performance.now()` for a big input vs a small one and requires the ratio to be
  under 50, so a loaded machine or a GC pause can tip it — it passes in isolation
  and failed once on `main` right after an unrelated merge. Same advice: re-run
  before investigating, and do not "fix" it by tightening or loosening the
  threshold, which only moves the flake.
- **Plans carry stale baselines within hours** on a busy branch: re-measure test
  counts at your own HEAD rather than trusting the plan's.

