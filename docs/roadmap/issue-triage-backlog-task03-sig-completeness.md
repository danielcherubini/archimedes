---
status: committed
parent: docs/roadmap/issue-triage-backlog-status.md
done-when: A built-but-unsigned installer can no longer pass the release ceremony — `bash scripts/check-release-signatures.test.sh` ends `all checks passed` and goes RED when the new check's per-asset direction or its `.dmg`/`latest.json` allow-list is mutated, `bash scripts/check-release-signatures.sh --repo danielcherubini/archimedes --tag v0.6.0` exits 0 printing exactly the four installer names, and no file in the repo still tells the releaser to "count distinct `.platforms[].url` basenames … and require a `.sig` for each".
---

# Issue #41(d): the release sig-completeness check runs in the inverse direction

**Goal:** Make "every installer on the release is signed" a real, falsifiable check — asked of the **release**, never of the manifest the signatures produced.

**Architecture:** One new script, `scripts/check-release-signatures.sh`, reads `gh release view "$TAG" --json assets` and requires a `<name>.sig` beside **every non-allow-listed asset** (per asset, never by counting). It is the primary gate, runs in `release.yml`'s `publish` job **before** `latest.json` is composed, and prints the installer payload names it accepted so the composer call can pass them to a new `--require-payload` flag — the secondary gate, which protects the human-at-a-terminal path in AGENTS.md step 4. The docs that currently instruct the vacuous check are rewritten to point at the script.

**Tech Stack:** bash + jq (no new tools), GitHub Actions YAML, markdown. No Rust, no frontend.

---

## Parallelisation

**Verdict:** SERIAL — this consumed-mode plan contains exactly one task, and one task cannot be a wave. (The parent roadmap groups this task with T2 as wave 1a; that grouping is `roadmap`'s to make, and it holds because the two tasks share no files and neither compiles the Rust crate. Nothing here decides it.)

---

### Task 3: Inverse the sig-completeness check; make the composer fail on an expected-but-unsigned target

**Parallel:** none — single-task plan; see the verdict above.

**Context:**

`scripts/compose-updater-manifest.sh` enumerates platforms **only** from the `*.sig` files present on disk. Three places make that structural, all verified against the tree:

- `sig_paths=("$sigs_dir"/*.sig)` (under `shopt -s nullglob`) is the sole source of targets;
- the `-deb` and `-rpm` keys are each emitted inside `if [[ -n "$deb_sig" ]]` / `if [[ -n "$rpm_sig" ]]`;
- the orphan loop walks `sig_paths` and calls `references_sig` / `superseded_sig` — that is **sig → key**, never **installer → sig**.

So an installer that was built but whose `.sig` was never uploaded is silently omitted **with exit 0**. Reproduced on this tree (unmodified `main` composer, fixture dir holding `Archimedes_0.3.1_amd64.AppImage{,.sig}`, `…_amd64.deb{,.sig}`, and **unsigned** `…_amd64.rpm` + `…_x64-setup.exe`):

```
composed …/latest.json: 3 platform key(s), version 0.3.1, tag v0.3.1
EXIT=0
keys: linux-x86_64, linux-x86_64-appimage, linux-x86_64-deb
```

The rpm and the Windows payload are gone; those installs never learn an update exists.

The documented check is no protection. `AGENTS.md` step 4 says *"count distinct `.platforms[].url` basenames in the shipped manifest and require a `.sig` for each"*, and the ADR 0052 amendment repeats it. That is **vacuous**: the composer derives its keys FROM the `.sig` files it was handed, so a never-uploaded `.deb.sig` removes the target from both sides at once. The check's left side is a projection of its right side, so it passes exactly when it should fail. It is still worth doing while refreshing notes on an existing manifest; it does not establish release completeness. (Verified: `git show main:AGENTS.md` still carries that sentence — the ceremony as documented on `main` is the unfalsifiable one, so the docs are part of this task, not a follow-up.)

`.github/workflows/release.yml`'s `publish` job currently asserts only that **at least one** `.sig` exists (`gh release download "$TAG" --pattern '*.sig'` then `ls sigs/*.sig || …`). That is the same hole one level up.

**The remedy is the inverse direction, and it needs no new machinery:** every installer asset on the release must have a `.sig` beside it, read from `gh release view "$TAG" --json assets`. Two constraints a naive version gets wrong, both MANDATORY:

1. **Allow-list the non-payload assets.** A `.dmg` is never an updater payload and has no `.sig` (`README.md`: *"a `.dmg` gets no `.sig` at all and is never an updater payload"*; `CONTEXT.md`'s **Updater manifest** entry says the same). `latest.json` is the manifest, not a payload. And every `*.sig` in the list is a signature, not an installer — otherwise the check demands `X.sig.sig`. Without the allow-list the check fails on every real release.
2. **The ratio is NOT 1:1 — match PER ASSET, never by counting.** `src-tauri/tauri.conf.json` has `createUpdaterArtifacts: true`, so the raw installer IS the payload and several manifest keys share one file: `windows-x86_64` / `windows-x86_64-nsis` share the `.exe`, `linux-x86_64` / `linux-x86_64-appimage` share the `.AppImage`. Measured against the live release `v0.6.0`, the asset set is exactly `Archimedes-0.6.0-1.x86_64.rpm{,.sig}`, `Archimedes_0.6.0_amd64.AppImage{,.sig}`, `Archimedes_0.6.0_amd64.deb{,.sig}`, `Archimedes_0.6.0_x64-setup.exe{,.sig}`, `latest.json` — **4 installers, 4 sigs, 6 manifest keys**. A file-count-vs-key-count check false-alarms on that healthy release; that is the exact "2 sigs missing" phantom that nearly withheld v0.3.1 (ADR 0052's amendment records it). The inverse check therefore never reads the manifest at all.

**Which gate is primary.** `scripts/check-release-signatures.sh` (the inverse release check) is the **primary gate** — it is the only one whose input is the release itself, which is the ground truth. The composer's new `--require-payload` flag is **secondary, defence-in-depth**: it exists so the AGENTS.md step-4 path (a human re-composing `latest.json` by hand after a notes rewrite) fails the same way, because that path never runs the release check. The composer flag alone would not be enough: it can only assert what its caller tells it, and today's caller tells it nothing.

**Already resolved — parts (a), (b), (c) of issue #41 are NOT in scope and need no work.** Verified against this tree:

- **(a) superseded crash-log docs:** `docs/roadmap/crash-log-hardening.md` does not exist (`ls` fails). It was deleted by `2bd8967` *"docs: remove crash-log-hardening roadmap — shipped (PR #40)"*, and the duplicate copy that rode into #38 was reverted by `48737ae`. The crash-log code is real and matches `main`'s docs: `src-tauri/src/agent/crashlog.rs` defines `MAX_CRASH_LOG_AGE_DAYS = 30` and `MAX_CRASH_LOG_FILES = 50`, and `CONTEXT.md`'s **Crash log** entry names the pid-carrying `crash-<ts>-<tag>-<pid>.log` shape and the injected directory.
- **(b) the #38/#40 add/add collision:** moot — the revert landed and `main` carries exactly one `## Amendment (2026-10-18)` in `docs/decisions/0025-sessions-in-worker-processes.md` and one **Crash log** entry in `CONTEXT.md`.
- **(c) the unfalsifiable `kill -9` check:** gone. `src-tauri/tests/worker_e2e.rs`'s `crash_path_on_crash_fires_and_rows_stay_intact` carries the NOTE that a SIGKILL never fires the panic hook, so no log is expected on that path.

Do not widen into crash logging. This task touches no `.rs`, no `.ts`/`.tsx`, and no file under `src-tauri/` or `src/`.

**Files:**
- Create: `scripts/check-release-signatures.sh`
- Create: `scripts/check-release-signatures.test.sh`
- Modify: `scripts/compose-updater-manifest.sh` — add `--require-payload`
- Modify: `scripts/compose-updater-manifest.test.sh` — new cases for that flag
- Modify: `.github/workflows/release.yml` — new `publish` step + pass `--require-payload` to the composer
- Modify: `.github/workflows/ci.yml` — one new step in the `scripts` job
- Modify: `AGENTS.md` — step 4 of `## Releasing` rewritten
- Modify: `docs/decisions/0052-single-writer-updater-manifest.md` — a **second** amendment
- Modify: `README.md` — the "order a release actually takes" sentence gains the gate

**What to implement:**

**1. `scripts/check-release-signatures.sh` (new — the primary gate).**

Shape it after `scripts/release-notes.sh`, which is the file in this directory that already wraps `gh`: `set -euo pipefail`, a `usage()` heredoc, a `fail()` that prints `error: …` to stderr and exits 1, a hand-rolled `while [[ $# -gt 0 ]] / case` parser in which a value-taking flag guards with `if [[ $# -lt 2 || -z "${2:-}" ]]` **before** `shift 2` (that is `check-versions.sh`'s idiom; note that the composer's existing flags do *not* guard, so `--notes` as the last argument currently dies silently with exit 1 — copy the *guarding* idiom, not that one), and early `command -v gh` / `command -v jq` checks with the "X is required…" message style both scripts already use.

CLI:

```
usage: check-release-signatures.sh --repo owner/name --tag vX.Y.Z
```

Both required; `--tag` must match `^v[0-9]+\.[0-9]+\.[0-9]+$` (the same regex `release-notes.sh` applies, with the same reasoning). `--repo` is required, not defaulted from the checkout — `release-notes.sh`'s fork-safety argument applies verbatim: an unaddressed `gh` call resolves the repository from the CHECKOUT, which on a fork or renamed repo is not the repository being released. Pass it as `--repo "$repo"` on the `gh` call.

Logic:

1. `assets_json="$(gh release view "$tag" --json assets --repo "$repo")"` — on failure, `fail` with a message naming the tag (so a typo'd tag reads as "no release for $tag", not as "zero installers").
2. Derive the two name sets with `jq` (no `--jq` on the `gh` call — `release-notes.sh` documents why `--jq`/`--paginate` shapes are a trap; here just pipe into real `jq`):
   - **skip set** — names ending in `.sig`, names ending in `.dmg`, and the exact name `latest.json`;
   - **installer set** — every other asset name.
   Do **not** filter on the asset's `state` field (`gh` exposes `uploaded` / `pending`, measured against `v0.6.0`). Presence of the name is what "a sig beside it" means; filtering on `uploaded` would make a pending installer with a pending sig pass, which is not a claim worth making. Record this reason in a comment, and pin it with a test (case 10 below).
   The allow-list is an **allow-list of non-payloads**, so a future format whose bundler does not sign (or an added asset like a checksum file) fails loud and forces someone to add it deliberately. That bias is intended; say so in the comment. `.msi` needs no entry — `tauri-cli` signs `WindowsMsi`, and it is not in `tauri.conf.json`'s `bundle.targets` anyway.
   It is a **skip filter, never a required set**: none of `.dmg`, `latest.json` or `*.sig` may be demanded. The gate runs while the release is still a DRAFT and before `Upload the updater manifest`, so `latest.json` does not exist yet on a normal run (and no `.dmg` exists at all until macOS packaging is enabled) — a "required allow-list entries" reading would fail every release at the point it is supposed to protect. Pin that with a case: installers + sigs and **no** `latest.json` asset at all → exit 0.
3. **Anti-vacuity gate:** if the installer set is EMPTY, `fail` — "release $tag carries no installer assets at all (only …)". Without this, a release whose assets never uploaded, or an asset list that came back empty for any reason, passes the loop vacuously — the same class of bug this task exists to fix. (Measured: `{"assets":null}` and `{"assets":[]}` both yield an empty set through `[.assets[]?]`, so the guard is load-bearing, not defensive.)
4. For each installer name `X`: if `X.sig` is not in the asset-name set, record a failure naming **both** `X` and the missing `X.sig`. Accumulate all of them and print every one before exiting 1 — one run must report every unsigned installer, not the first.
5. Exit 1 with a message that names the count and each offender, phrased so the operator's next action is obvious ("upload the missing signatures, or remove the installer from the release — do not compose a manifest over an incomplete sig set").
6. Exit 0 printing **the accepted installer names, one per line, on stdout, sorted with `LC_ALL=C sort`** (C collation so the order is byte order and not the runner's locale — the asset names mix `-` and `_`, which sort differently under en_US.UTF-8; and a stable order keeps the workflow's `--require-payload` argument list reproducible). Every diagnostic goes to stderr; stdout is the machine-consumed contract, exactly as in `release-notes.sh`. This list is the composer's expectation list — that is what keeps the two gates from holding two copies of the allow-list.

**2. `scripts/compose-updater-manifest.sh` — add `--require-payload` (the secondary gate).**

- New `while`/`case` arm: `--require-payload) … ; shift 2 ;;` accumulating into a `required_payloads=()` array (repeatable; several flags of the same name are the normal call shape). Guard the value the same way as above: a missing or empty value is `fail "--require-payload requires a payload asset name (e.g. Archimedes_0.2.0_amd64.deb)"`, not a silent exit.
- **Semantics: a claim about a NAME, not about bytes.** `--require-payload NAME` asserts that `$sigs_dir/NAME.sig` exists. It does **not** require `NAME` itself to be on disk — and must not, because on the real pipeline `--sigs-dir` holds **signatures only** (`gh release download --pattern '*.sig'`). Say exactly that in the flag's comment, and record the rejected alternative: scanning the directory for installer files that lack a `.sig` would need `release.yml` to download ~300 MB of installers into the `publish` job to obtain information `gh release view --json assets` already gives for free. That is why there is no `--installers-dir`.
- Reject `NAME` already ending in `.sig` ("pass the payload name, not the signature name") so a mistyped flag can never become a silent no-op.
- Place the check **after** the existing "no .sig files found in $sigs_dir" refusal and **before** the pattern-matching / key-derivation section, so an expected-but-absent signature fails before any key is built and before `--out` is written (`fail()` already removes `$out_file` on every exit path, so a rejected composition leaves nothing for the next step to upload — keep that property).
- Iterate `required_payloads` with the file's existing empty-array idiom (`(( ${#required_payloads[@]} == 0 )) && …`) — `set -u` plus an older bash treats `"${arr[@]}"` on an empty array as unbound, and the file already guards this way in `references_sig` / `superseded_sig`.
- Failure message must name the payload, the expected sig filename, and the directory: `expected updater payload $name has no signature in $sigs_dir (expected $name.sig) — refusing to compose a manifest that silently drops an installed platform`.
- Do **not** touch the orphan loop, the `claim()` collision rule, the accepted-suffix patterns, `--arch`, or the self-validation block. Everything already in that file is correct and pinned by 628 lines of tests; the flag is additive.

**3. `scripts/compose-updater-manifest.test.sh` — new cases (append before the `if ((failures > 0))` footer).**

Use the harness's existing pieces verbatim: `make_sigs_dir`, `run_compose`, `assert_eq`, `assert_fails`, `assert_contains`, `assert_not_contains`, `assert_manifest_eq`, `path_exists`, `out_file`, and the payload-name variables already defined near the top (`deb_payload`, `deb_sig`, `rpm_sig`, `rpm_payload`, `win_exe_sig`, `win_exe_payload`, `appimage_bare_sig`/`_payload`, `five_keys`).

The task brief predicted this harness would need a **new fixture helper** for "installer present, sig absent". Verified against the tree, and the prediction is **wrong for this harness**: `make_sigs_dir` already takes an arbitrary name list, and because `--require-payload` asserts about a name rather than about bytes on disk, the "installer present, sig absent" case is just `make_sigs_dir` called without `$deb_sig` plus `--require-payload "$deb_payload"` on the command line. Adding a helper that touches empty installer files into the sigs dir would assert nothing the composer reads and would mislead the next reader into thinking the composer looks at installer bytes. **Add no helper here.** (The genuinely new fixture machinery — a `gh` shim — belongs to the new test file in step 4, which is where a release-shaped fixture actually has to be built.)

Variable order matters when appending: `win_exe_sig` / `win_exe_payload` are defined partway down (before case 6b), `darwin_sig` / `darwin_payload` before case 7, and `rpm_sig` / `rpm_payload` before case 10 — while `win_sig`, `appimage_targz_sig`/`_payload`, `appimage_bare_sig`/`_payload`, `deb_sig` / `deb_payload`, `five_keys`, `tag`, `version`, `repo`, `base_url` are in the top block. Appending after that harness's own case 15 (the rpm-without-AppImage case, the last one before the footer) reaches all of them; do not move any of those definitions into the top block for tidiness, because their comments carry the reasoning for the patterns they exercise.

Cases:
- the full five-key fixture, called with `--require-payload "$deb_payload" --require-payload "$appimage_bare_payload"` over a sigs dir that holds both sigs → exit 0 and `.platforms | keys | sort | join(" ")` still equals `$five_keys` (the flag adds no key to anything; it only refuses).
- sigs dir holding AppImage + Windows sigs but **no** `$deb_sig`, with `--require-payload "$deb_payload"` → `assert_fails`, `assert_contains` the deb payload name, `assert_contains "expected $deb_sig"`, and `assert_eq "no manifest survives an expected-but-unsigned target" "no" "$(path_exists "$out_file")"`.
- the #41(d) regression itself: a sigs dir with AppImage + deb sigs, and `--require-payload` for the deb, the AppImage, **the rpm and the Windows `.exe`** whose sigs are absent → exit 1 and the output names **both** `$rpm_payload` and `$win_exe_payload` (both offenders reported in one run).
- `--require-payload "${deb_sig}"` (a `.sig` passed by mistake) → exit 1, `assert_contains "pass the payload name"`.
- `--require-payload` as the final argument with no value → exit 1 and `assert_contains "requires a payload asset name"` (this is the guard; note in a comment that the pre-existing flags' silent-exit behaviour is deliberately left alone — out of scope, and changing it would re-pin existing cases).
- no `--require-payload` at all on a set that composes → unchanged exit 0 (the flag is opt-in; existing cases already prove this, so one explicit case is enough and no existing assertion may change).

**4. `scripts/check-release-signatures.test.sh` (new harness).**

Plain bash, `set -euo pipefail`, the same header/footer shape and `assert_*` helpers as `compose-updater-manifest.test.sh` (`failures` counter, `mktemp -d` + `trap 'rm -rf "$tmp_root"' EXIT`, `assert_eq` / `assert_contains` / `assert_not_contains` / `assert_fails`, final `all checks passed`). Locate the script under test as `$test_dir/check-release-signatures.sh` and `exit 1` FATAL if it is missing.

`gh` is replaced by a shim on `PATH` — copy the pattern from `scripts/release-notes.test.sh`: a `$fake_bin/gh` heredoc, `export PATH="$fake_bin:$PATH"` inside the run helper, an invocation log so a case can assert what was asked. The shim needs far less than the notes one: it handles `release view` only, pulls `--repo`/`-R` out of argv **wherever it sits** before dispatching (the notes shim's flag-normalisation block, copied, is what keeps a case from failing because of the shim's parsing), and prints a JSON document taken from an env var (`FAKE_ASSETS_JSON`), or exits 1 with `release not found` when `FAKE_RELEASE_EXISTS=false`. Make the shim exit 70 with `fake gh: unhandled command: $*` on anything else, so an implementation that reaches for `gh release download` or `gh api` fails loudly rather than being served a convenient answer.

Fixture builder (this **is** the new helper the brief asks for, just for this harness): `make_assets NAME...` — prints a `{"assets":[{"name":…,"state":"uploaded"},…]}` document, so a case reads as a list of asset names.

Cases:
1. The real healthy shape (`rpm`, `rpm.sig`, `AppImage`, `AppImage.sig`, `deb`, `deb.sig`, `exe`, `exe.sig`, `latest.json`) → exit 0, and stdout is exactly the four installer names in the script's `LC_ALL=C` sort order (`…x86_64.rpm`, `…amd64.AppImage`, `…amd64.deb`, `…x64-setup.exe`), one per line — `assert_eq` against that four-line expected string, which pins stdout-as-contract because `release.yml` consumes it.
2. Same minus `deb.sig` → exit 1, names `…_amd64.deb`, names `…_amd64.deb.sig`.
3. Both `rpm.sig` and `exe.sig` absent → exit 1, output names **both** installers (all offenders in one run).
4. macOS-on shape: `Archimedes.app.tar.gz`, `Archimedes.app.tar.gz.sig`, `Archimedes_0.2.0_amd64.dmg`, `latest.json` → exit 0, and `assert_not_contains` the `.dmg` name in stdout (the allow-list case; without it the check fails on every macOS release).
5. `latest.json` alone (no installers) → exit 1 — the anti-vacuity gate.
6. **The anti-ratio case:** the healthy four-installer/four-sig set plus a `latest.json` asset whose content carries SIX `platforms` keys → exit 0. This is the direct falsification of the "4 sigs, 6 keys ⇒ 2 sigs missing" phantom that nearly withheld v0.3.1: the check never reads the manifest, so key count cannot move its verdict. (The JSON content is decoration here — say so in the comment; what is being pinned is that a six-key manifest next to four installers is HEALTHY.)
7. No `*.sig` is treated as an installer: `assert_eq` that no stdout line ends in `.sig` (pins that nothing demands `X.sig.sig`).
8. Missing release (`FAKE_RELEASE_EXISTS=false`) → exit 1, names the tag.
9. `--repo` reaches `gh`: `assert_contains "--repo $repo"` against the shim's log (fork safety, the same pin `release-notes.test.sh` makes).
10. `state` is not consulted: an installer asset marked `pending` with no `.sig` → exit 1 (pins the decision in step 1.2 above).
11. Argument validation: missing `--tag`, missing `--repo`, a `--tag 0.2.0` with no `v` → each exit 1 with a message that names the flag.
12. Missing `gh` / missing `jq` on `PATH` → exit 1 with the "is required" message (build a narrowed `PATH` the way `release-notes.test.sh` builds its `nojq_bin`; if the narrowed-PATH trick cannot be built on this machine, `echo` a FATAL and exit 1 rather than silently skipping, matching that file's precedent).
13. **Integration pin:** read `$test_dir/../.github/workflows/release.yml` and assert (a) the completeness step's `name:` line appears at a lower line number than `- name: Compose latest.json`, and (b) the `Compose latest.json` step body contains `--require-payload`. Fail loudly if the workflow file is absent. Rationale to put in the comment: a gate that silently moves *after* the thing it gates, or a composer call that quietly drops the flags, restores the vacuity with nothing red anywhere — and the `scripts` job is the only place that can see it. Implement with `grep -n` on the two step names and an integer comparison; do not add a YAML parser dependency.
14. Installers + their sigs and **no `latest.json` asset at all** → exit 0. This is the state the gate sees on a normal run (it executes before the manifest is uploaded), and it is the pin that keeps the allow-list a skip filter rather than a required set.
15. **The pairing case (what kills a counting implementation):** installers `Archimedes_0.2.0_amd64.AppImage` + `Archimedes_0.2.0_amd64.deb`, sigs `Archimedes_0.2.0_amd64.AppImage.sig` + `Archimedes-0.2.0-1.x86_64.rpm.sig` — the two COUNTS are equal (2 installers, 2 sigs) but the pairing is wrong: the deb is unsigned and the rpm sig is orphaned. → exit 1, naming `…_amd64.deb` and `…_amd64.deb.sig`. A check that compares counts reports this release healthy; only per-asset matching sees it. This is the one case that distinguishes "every installer has a sig" from "as many sigs as installers".

**5. `.github/workflows/release.yml` — one new step, and the composer call gains its expectations.**

Insert into the `publish` job immediately **after** `- name: Download the signatures` and **before** `- name: Generate the release notes`:

```yaml
      # The completeness gate, asked of the RELEASE, and deliberately BEFORE the
      # manifest is composed: the composer derives its keys FROM the .sig files it
      # is handed, so any completeness question put to the manifest afterwards is
      # answered by a projection of the manifest itself (issue #41(d) — the check
      # AGENTS.md used to prescribe passed exactly when it should fail). Running
      # it before the notes step also means a release that is not complete is
      # never edited, never composed over, and stays a draft.
      # stdout is the accepted installer payload list, one per line; the compose
      # step feeds it back as --require-payload so the two gates share ONE
      # allow-list rather than each keeping a copy.
      - name: Check every installer asset is signed
        run: |
          bash scripts/check-release-signatures.sh \
            --repo "$GITHUB_REPOSITORY" --tag "$TAG" > expected-payloads.txt
          echo "signed installer payloads:"
          cat expected-payloads.txt
```

Then in `- name: Compose latest.json`, build and pass the flags before the composer call:

```yaml
          require_args=()
          while IFS= read -r payload; do
            # `if`, not `[[ … ]] && …` — the runner's default shell is `bash -e`,
            # where a false test at the end of a compound list aborts the step.
            if [[ -n "$payload" ]]; then
              require_args+=(--require-payload "$payload")
            fi
          done < expected-payloads.txt
```

and add `${require_args[@]+"${require_args[@]}"}` to the composer invocation (the `+` guard: an empty array under `set -u` is an unbound expansion, and the repo uses that idiom throughout `scripts/`). Keep `--sigs-dir sigs`, `--version "$VER"`, `--tag "$TAG"`, `--repo "$GITHUB_REPOSITORY"`, `--out latest.json`, `--notes "${NOTES_SUMMARY:-Archimedes $TAG}"` exactly as they are. Do not move `Upload the updater manifest` or `Publish the release`, do not touch `create-release` or `build`, and do not add a job.

Ordering answer, stated for the record: **before** the manifest is composed. After is where the vacuity lives — a composed-and-uploaded `latest.json` cannot tell you what was never signed. The gate must also precede `Upload the updater manifest` (which it does, being before the compose step) so an incomplete release never publishes a manifest.

Two placement details, so this is not re-litigated at execution time: (1) the gate does not read `sigs/`, so it could sit even earlier (right after `Resolve the version`). Put it **after** `Download the signatures` anyway — that step's own failure ("no `.sig` assets on $TAG — the build jobs uploaded nothing signable") is the more specific diagnosis when the build jobs uploaded nothing at all, and keeping the order preserves it. (2) Leave `Download the signatures`'s `ls sigs/*.sig || …` assertion in place. It is now strictly weaker than the new gate, but it checks the *download* rather than the release, and removing it would trade a precise message for a general one.

Why the composer flag is worth passing in CI even though the gate just passed: the two read **different things**. The gate reads the release's asset *list* (`gh release view --json assets`); the composer reads the *downloaded* sigs (`gh release download --pattern '*.sig'`, the step above). A download that came back short — a glob mismatch, a runner hiccup, a pattern change — leaves a complete release and an incomplete `sigs/` directory, and only `--require-payload` catches that. That is the reason to state in the workflow comment, and it is what makes the two gates complementary rather than duplicated.

**6. `.github/workflows/ci.yml`** — in the `scripts` job, after `- name: Test the updater-manifest composer`, add this one step with a short comment in the file's existing voice (every other script test in that job carries a comment saying why the script is a script under `scripts/` rather than YAML):

```yaml
      - name: Test the release signature completeness check
        run: bash scripts/check-release-signatures.test.sh
```

**7. `AGENTS.md` step 4 of `## Releasing`** — replace the sentence beginning `Verify it that way — count distinct \`.platforms[].url\` basenames in the shipped manifest and require a \`.sig\` for each` (and the trailing `because counting files against key names reports a false "2 sigs missing" on every healthy release` clause that justifies it) with the inverse instruction. Keep, unchanged, everything the sentence is attached to: the "COMPLETE means one `.sig` per platform this release targets — not one per filename on the release" rule, the **4 sigs serving 6 keys** fact, the "a genuinely incomplete set is a target with no signature at all" definition, the "re-uploading is otherwise safe" note, and "an incomplete set means stop — stale-but-correct notes beat a broken manifest". The ratio fact stays because it is what stops a human from re-inventing the counting check. The replacement must (a) name `bash scripts/check-release-signatures.sh --repo <owner>/<repo> --tag vX.Y.Z` as the command that decides completeness, (b) say plainly that completeness is checked against the **release's asset list**, never against the manifest, because the manifest's URLs are derived from the very signatures being tested, (c) tell the reader to hand the script's stdout to the composer as `--require-payload` flags, which is what makes step 4's re-compose fail rather than shrink, and (d) keep the `.dmg` / `latest.json` allow-list fact visible so nobody "fixes" the check by removing it.

**8. `docs/decisions/0052-single-writer-updater-manifest.md`** — append a **second** `## Amendment (2026-10-23)` section (precedent for two amendments in one ADR: `0016` and `0040` each carry two). Follow the house shape exactly: a `**AMENDED <date> — <what changed, and what stands>.**` lead naming that the single-writer decision and the amended payload-shape premise both stand and this ADR is NOT superseded, then what changed. The content: the 2026-10-18 amendment corrected *what complete means* (4 sigs / 6 keys, not 6 sigs) but left the reader with a **verification procedure that cannot fail** — "count the distinct `platforms[].url` basenames and require a `.sig` for each" tests the manifest against the signatures that generated it, so a never-uploaded signature shrinks both sides together. Completeness is now `scripts/check-release-signatures.sh`, asked of the release asset list per asset (`X` present ⇒ `X.sig` present), with an explicit allow-list for the assets that are legitimately unsigned (`.dmg`, `latest.json`, the `.sig`s themselves) and an explicit refusal when the release carries no installers at all; `compose-updater-manifest.sh --require-payload` closes the same hole on the manual re-compose path. Leave the 2026-10-18 text standing above as written and say in the new section that it is deliberately left standing and corrected here — that is `0016`'s stated convention. Do not edit the ADR's front-matter `status`.

**9. `README.md`** — in the `## Releasing` pipeline sentence (the bolded `**skill version bump … → the publish job generates the release notes … → composes and uploads latest.json … and only then flips the draft**` line), insert the completeness gate between the notes and the compose, and add one short sentence saying that the publish job refuses to compose over a release where any installer lacks its `.sig`, pointing at `scripts/check-release-signatures.sh`. Also worth one clause: `.dmg` and `latest.json` are legitimately unsigned and are not updater payloads — README already states the `.dmg` half near the top of the section, so keep it consistent with that wording rather than restating it differently.

**Not in scope (say so in the commit body, do not "fix" it):**
- Parts (a)/(b)/(c) of #41 — already resolved (evidence above).
- macOS: the `publish` job still passes no `--arch`, so a two-arch macOS release would need the composer called once per arch. `--require-payload` does not make that worse (`Archimedes.app.tar.gz` would simply be required, and the composer already refuses a darwin sig without `--arch`), but do not design the multi-arch publish job here.
- `make check` does **not** run `scripts/*.test.sh` — only ci.yml's `scripts` job does. Changing the shared `Makefile` target is a tree-wide build-config edit and belongs to no task in this roadmap.
- The composer's pre-existing silent exit when `--notes` / `--arch` / `--sigs-dir` is passed with no value (measured: `--notes` last → exit 1, no message). Fixing it would re-pin existing cases for no #41 benefit.
- `CONTEXT.md`: no new glossary term for this. The **Updater manifest** entry and the **Build** / **Upload** / **Publish** entry (CONTEXT.md's name for the release pipeline, which already records that a `.dmg` has no `.sig` and is never an updater payload) remain true as written; adding a term for one script is the kind of inflation the glossary warns against.

**Steps:**

- [ ] Write the failing harness first: `scripts/check-release-signatures.test.sh` (cases 1–15 above), with the `gh` shim. Run `bash scripts/check-release-signatures.test.sh`.
  - Expected: FATAL `… check-release-signatures.sh does not exist — implement it before running these tests.` If it does not say that, the harness is not locating the script under test correctly.
- [ ] Implement `scripts/check-release-signatures.sh`. Re-run `bash scripts/check-release-signatures.test.sh`.
  - Expected: every line `ok`, ending `all checks passed`. Any `FAIL` naming an asset the allow-list covers means the allow-list is applied to the installer side instead of the skip side — fix the set, not the test.
- [ ] Prove the harness is not itself vacuous (three mutation probes, each reverted immediately):
  - delete `.dmg` from the allow-list → case 4 must go RED;
  - replace the per-asset loop with a count comparison against the **`.sig` count** → case 15 (equal counts, wrong pairing) must go RED;
  - replace it with a count comparison against the **manifest's key count** (the phantom the v0.3.1 release nearly died of) → case 6 must go RED.
  - If any probe stays green, the case meant to catch it is decorative — rewrite that case before continuing. `git diff` must show the mutations gone afterwards, and `grep -c` the script for the original per-asset loop to be sure the revert is complete.
- [ ] Add the `--require-payload` cases to `scripts/compose-updater-manifest.test.sh`. Run `bash scripts/compose-updater-manifest.test.sh`.
  - Expected: the "expected-but-unsigned" cases FAIL — but read which assertion fails. `--require-payload` is today an unknown argument, so the composer already exits **1** (`error: unknown argument: --require-payload`): `assert_fails` passes pre-implementation and the assertions that must go RED are the `assert_contains` ones naming the payload / `expected …deb.sig`, plus the "no manifest survives" assertion (an unknown-argument failure never writes `--out`, so `path_exists` also reads `no` — pin the message, not the exit code). If a new case fails on `assert_fails` instead, the case is asserting the wrong property.
  - The opt-in case (no flag at all → exit 0) passes both before and after; it is a regression pin, not a TDD case.
- [ ] Implement `--require-payload` in `scripts/compose-updater-manifest.sh`. Re-run `bash scripts/compose-updater-manifest.test.sh`.
  - Expected: `all checks passed`, with **no existing assertion edited or deleted** — 628 lines of prior policy (the five/six-key sets, the orphan rule, the `.exe` claim, the rpm spelling, the newline round-trip) must survive untouched.
- [ ] Reproduce the #41(d) scenario by hand and confirm the composer gate fires on the exact input that used to pass silently. Build the fixture from the Context section — a temp dir holding `Archimedes_0.3.1_amd64.AppImage.sig`, `…_amd64.deb.sig` and `…_amd64.AppImage.tar.gz.sig` (any bytes), and NOTHING for the rpm or the `.exe` — then run the composer twice over it:
  - `bash scripts/compose-updater-manifest.sh --sigs-dir <dir> --version 0.3.1 --tag v0.3.1 --repo o/r --out /tmp/old.json` → still exit 0 with 3 keys (the flag is opt-in; this is the pre-change behaviour, preserved).
  - the same command plus `--require-payload Archimedes_0.3.1_amd64.deb --require-payload Archimedes_0.3.1_amd64.AppImage --require-payload Archimedes_0.3.1_amd64.rpm --require-payload Archimedes_0.3.1_x64-setup.exe` → exit 1 naming `Archimedes_0.3.1_amd64.rpm` and `Archimedes_0.3.1_x64-setup.exe`, and `/tmp/…json` not left behind.
  - The release-side half of the same scenario is case 3 of the new harness (a shim fixture, not a manual run) — do not try to point the script at a local directory; it speaks to a release, by design.
- [ ] Verify against the REAL release, read-only: `bash scripts/check-release-signatures.sh --repo danielcherubini/archimedes --tag v0.6.0`.
  - Expected: exit 0 and exactly four lines on stdout (`Archimedes-0.6.0-1.x86_64.rpm`, `Archimedes_0.6.0_amd64.AppImage`, `Archimedes_0.6.0_amd64.deb`, `Archimedes_0.6.0_x64-setup.exe`), with `latest.json` and the four `.sig`s skipped. Note the real remote is **`danielcherubini/archimedes`** (`git remote -v`); `danielcherubini/archimedes-desktop` is a fixture value inside the test harnesses and must not be "corrected" in either of them, and must not be used for this live check.
- [ ] Edit `.github/workflows/release.yml` (new step + `require_args` in the compose step) and `.github/workflows/ci.yml` (the new `scripts` step). Re-run `bash scripts/check-release-signatures.test.sh`.
  - Expected: case 13 (the integration pin) goes green only once the step really sits above `Compose latest.json` **and** the composer call carries `--require-payload`. If it fails, the step was placed after the notes/compose or the flag was dropped.
  - YAML sanity, optional and local only: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))"`. This machine has PyYAML; there is no `actionlint` or `shellcheck` installed and no lint step for workflows in this repo, so this is a convenience, never the gate.
- [ ] Rewrite `AGENTS.md` step 4, append the ADR 0052 amendment, update `README.md`. Then run the greps that prove the vacuity is gone:
  - `grep -rn 'basenames' --include='*.md' AGENTS.md README.md CONTEXT.md docs/decisions docs/features` → the ONLY remaining hits are inside `docs/decisions/0052-single-writer-updater-manifest.md`, where the phrase survives solely in historical text (the 2026-10-18 amendment as written, deliberately left standing, and the new amendment naming what it replaced). Zero hits in `AGENTS.md`, `README.md`, `CONTEXT.md`, or `docs/features/` — a hit in any of those means step 7 is unfinished. (Scope the grep to the instruction docs, not the whole tree: this plan quotes the retired sentence to explain what it replaced, and a roadmap doc is not a place the releaser executes from.)
  - `grep -rn 'check-release-signatures' AGENTS.md README.md .github/workflows/` → hits in all three.
- [ ] Full AGENTS.md bar (nothing in Rust/frontend changes, so this is a regression gate, not a proof):
  - `pnpm test` and `pnpm build` from the repo root;
  - `cargo test`, `cargo clippy --all-targets`, `cargo fmt --check` from `src-tauri/`.
  - Expected: all green as measured at the roadmap's `a6e3f02` baseline (3049 FE tests / 149 files, 1355 Rust tests, 0 clippy warnings, fmt clean). Any red here means a file outside the declared list was touched — `git status` before committing.
- [ ] Real gate for this task, run last: `bash scripts/compose-updater-manifest.test.sh` and `bash scripts/check-release-signatures.test.sh` (the two the ci.yml `scripts` job will run).
- [ ] Commit: `fix(release): the sig-completeness check runs in the inverse direction — every installer must be signed (#41)`

**Acceptance criteria:**
- [ ] `bash scripts/check-release-signatures.test.sh` ends `all checks passed`, and goes RED under each of the three mutation probes (allow-list without `.dmg`; per-asset check replaced by a sig-count comparison; replaced by a manifest-key-count comparison) — the check is falsifiable, not decorative.
- [ ] A fixture release holding an unsigned `…_amd64.rpm` and an unsigned `…_x64-setup.exe` exits **1** from both gates, naming both installers and both missing `.sig` names — where the pre-change composer exited **0** with 3 keys on identical input (the reproduction recorded in Context, re-run in step "Reproduce the #41(d) scenario").
- [ ] A healthy release — 4 installers, 4 sigs, `latest.json` carrying **six** platform keys — exits **0** from the completeness check. The 4-sigs/6-keys ratio cannot produce a false alarm, because no code path compares a file count to a key count.
- [ ] `bash scripts/check-release-signatures.sh --repo danielcherubini/archimedes --tag v0.6.0` exits 0 and prints exactly the four installer names (`.dmg`/`latest.json`/`*.sig` skipped), proving the allow-list matches reality rather than the fixture.
- [ ] A release whose only asset is `latest.json` exits **1** — the inverse check cannot pass vacuously either.
- [ ] `grep -rn 'basenames' --include='*.md' AGENTS.md README.md CONTEXT.md docs/decisions docs/features` finds no instruction anywhere to count manifest basenames and require a sig (the phrase remains only in ADR 0052's historical + naming-what-it-replaced text); `AGENTS.md` step 4 names `scripts/check-release-signatures.sh` and the release asset list as the thing that decides completeness, while keeping the 4-sigs/6-keys fact and the "incomplete means stop" rule.
- [ ] `.github/workflows/release.yml`: the completeness step runs before `- name: Compose latest.json`, and that compose step carries `--require-payload` — pinned by case 13, so it cannot silently drift back.
- [ ] `bash scripts/compose-updater-manifest.test.sh` passes with **zero** existing assertions edited or removed, and `bash scripts/compose-updater-manifest.test.sh` + `bash scripts/check-release-signatures.test.sh` are both wired into ci.yml's `scripts` job.
- [ ] The AGENTS.md bar is green at the commit; `git status --porcelain` shows only the nine declared files as modified/created. (Untracked `docs/roadmap/issue-triage-backlog-taskNN-*.md` files — this plan among them, plus siblings from parallel `specify` runs — belong to the orchestrator, not to this commit: commit by explicit pathspec, never `git add -A`.)

**What cannot be exercised without a real release (do not claim otherwise):**
- The `publish` job cannot be rehearsed by `workflow_dispatch`: `create-release` is `if: github.event_name == 'push'`, so on a dispatch it is SKIPPED and `publish`'s `needs.create-release.result == 'success'` guard skips `publish` too. The new step therefore **never runs in dispatch mode** — only a real tag push exercises it. Everything the step does is covered locally by the shim harness; the YAML wiring itself is covered only by case 13's text-level pin plus the next real release.
- A `pending` (mid-upload) asset against the real API, and the macOS path end-to-end (`.dmg` / `.app.tar.gz` / two `--arch`es), have no live fixture today: `v0.6.0` has no macOS assets and the `APPLE_*` secrets gate the matrix rows. Both are proven by fixture only.
- The `gh` shim returns a canned document, so it proves the script's logic and argv, not GitHub's schema. The schema was measured against `v0.6.0` with `gh release view v0.6.0 --json assets` (`name`, `state`, `size`, `contentType`, …) and `gh` 2.97.0; record that in the script's comment so a future reader knows which gh the shape was read from.
