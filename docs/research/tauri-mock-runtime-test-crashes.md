---
status: current
last-verified: 2026-10-15
verified-by: web research — 2 researcher angles (GitHub issues/PRs, upstream source), 1 local audit (inline after dispatch timeout), 2026-10-15
---

# Why `tests/ipc.rs` crashes on Windows/macOS CI — and the fixes

## Executive summary

`src-tauri/tests/ipc.rs` (the only test binary that links the Tauri mock runtime via `tauri::test::mock_builder` + `tauri::generate_context!`) crashed on the first CI runs that ever reached it on the new platforms:

- **Windows** (`windows-latest`): `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND` at process LOAD, before any test.
- **macOS** (`macos-latest`): `SIGSEGV` after 2 of 8 tests passed.

Both are **environmental/upstream-shaped, not assertion failures** — and both have real fixes. The Linux-only `#![cfg]` gate landed in `5d87ecf`+ as an interim; the fixes below remove the need for it.

## Windows — tauri#13419, the Common-Controls-v6 manifest never reaches test binaries

**Root cause** (upstream-authoritative, [tauri#13419](https://github.com/tauri-apps/tauri/issues/13419), still open):

- `tauri_build::build()` embeds the comctl32-v6 application manifest via `tauri-winres` → `embed_resource::compile()`, which emits **`cargo:rustc-link-arg-bins`** — link args scoped to `[[bin]]` targets only. Integration-test and lib-test binaries never get the manifest. (Verified locally: `tauri-winres-0.3.6/src/lib.rs:541`, `tauri-build-2.7.2` `res.compile()` path; Sculas in #13419: *"This only links the manifest to the main application binary, not any of the tests."*)
- `ipc.exe` imports `comctl32!TaskDialogIndirect` — pulled by tauri's default `common-controls-v6` feature (→ muda) and by `tauri-plugin-dialog` → `rfd/common-controls-v6` (enabled unconditionally in the plugin's Cargo.toml). Without the v6 manifest the loader binds System32 comctl32 **v5.82**, which lacks `TaskDialogIndirect` → load-time `0xc0000139`. (A missing DLL would be `0xc0000135` — so WebView2Loader is NOT the cause; dumpbin evidence in #13419.)
- **Why the 892-test lib binary survives on the same link line:** nothing under `src/` constructs a tauri `App` (grep `mock_builder src/` is empty), so the linker dead-strips the v6-only import; `tests/ipc.rs` is the one target that keeps it alive (registers the dialog plugin + builds `App`).

**The fix (upstream-blessed, [lucasfernog's comment](https://github.com/tauri-apps/tauri/issues/13419#issuecomment-3398457618), confirmed working in [#13948](https://github.com/tauri-apps/tauri/issues/13948)):** build with `WindowsAttributes::new_without_app_manifest()` (so tauri-winres stops emitting the manifest with `-link-arg-bins`), then re-emit it ourselves **unscoped** — `cargo:rustc-link-arg=/MANIFEST:EMBED` + `/MANIFESTINPUT:windows-app-manifest.xml` — which per the Cargo book reaches *"benchmarks, binaries, cdylib crates, examples, and tests"*.

**Rejected alternatives, recorded so nobody re-litigates:**

- `__TAURI_WORKSPACE__ = "true"` env (tauri's own `.cargo/config.toml` workaround): a NO-OP outside tauri's git workspace — the manifest path it reads is a workspace sibling absent from the published crate, and build-script link args don't propagate to dependents. Three independent reporters confirm (issues #13419, #13954, #13948).
- `tauri` `default-features = false, features = ["test","wry","compression"]` (FabianLars' suggestion in #13954; what tauri-specta ships): works, but Cargo feature unification means it changes the **shipped** app too (loses the v6 TaskDialog about-menu; plugin-dialog still forces rfd's v6). Second choice only.
- `mt.exe` post-link patch via a test-only cargo `runner`: works but fragile (`runner` also hijacks `cargo run`); upstream's own note says it needs a separate `--config` file to avoid breaking `tauri dev`.
- Gating `ipc.rs` to Linux: what shipped as the interim; the honest cost is the mock-runtime IPC contract never executes on Windows. Superseded by the manifest fix.
- A `webview2-com` **build-dependency** (reportedly `features = ["windows-pc"]`) "so every target embeds the PC manifest": dropped while implementing — `webview2-com` has NO feature table at all (verified: `webview2-com-0.39.1/Cargo.toml` declares only dependencies; `grep -ral windows-pc` over `~/.cargo/registry/index` and the vendored sources is empty), so `cargo` refuses to resolve the manifest ("depends on `webview2-com` with feature `windows-pc` but `webview2-com` does not have that feature"). The crate is also Windows-only and would need a `cfg(windows)` gate, and build-script link args of a *dependency* do not reach our targets anyway (the same non-propagation that makes `__TAURI_WORKSPACE__` a no-op). The unscoped `/MANIFESTINPUT` args in `build.rs` are what put the manifest on every target.

**Upstream fix to watch/👍:** tauri#13419 (`tauri-winres` `compile` → `compile_for_everything` was declined as a default); also #14580, #13948.

## macOS — a data race in OUR harness against MockRuntime's unsound `Send`/`Sync`

Not AppKit, not WebKit, not leaks:

- `mock_builder()` never creates the `tauri.conf.json` windows — config windows are created in `setup()`, which runs from the `RunEvent::Ready` arm of `run`/`run_return` ([app.rs:2689 / :1443](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/app.rs)). `MockRuntime` itself is fully headless (no tao/wry/WebKit). So the CI-has-no-WindowServer / WKWebView hypotheses are **rejected with source evidence**.
- The classic off-main AppKit assert is **rejected**: it `panic!`s with a message (tao/muda use checked `MainThreadMarker`); we observed a bare SIGSEGV.
- **Root cause:** `MockRuntime::RuntimeContext` holds `Arc<RefCell<HashMap<..>>>` with `unsafe impl Send + Sync` justified by *"we ensure this type is only used on the main thread"* ([mock_runtime.rs:56–74](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/test/mock_runtime.rs)). `main_thread_id` is stamped from whatever thread first touches the handle. Our harness builds the app on the libtest worker A, pumps `app.run()` on spawned thread B, and drives `get_ipc_response` from A → `send_message`'s "am I on the main thread?" fast-path misfires and two threads borrow the same non-atomic `RefCell` → HashMap/RefCell corruption, non-deterministic SIGSEGV ("2 passed, then crash" = coin-flip interleavings, not accumulation).
- Upstream's only mock-app test keeps **everything on one thread** ([test/mod.rs:322–336](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/test/mod.rs)); docs never sanction `App::run` off-thread. No public issue matches this shape — we are first filers.
- `--test-threads=1` / `#[serial]` **provably do not help**: libtest spawns a fresh thread per test even in sequential mode.

**The fix:** one thread owns build + run + IPC per test. Either drive the test body from inside `run`'s `RunEvent::Ready` callback, or move the whole app lifecycle into the spawned thread and marshal requests over a channel. Teardown via `handle.exit()` only (never off-thread `cleanup_before_exit` — [#12534](https://github.com/tauri-apps/tauri/issues/12534), fixed by [#15558](https://github.com/tauri-apps/tauri/pull/15558)); avoid firing real notifications in tests (`notify-rust` bypasses MockRuntime on macOS).

## Evidence

- tauri#13419 (open; Sculas root-cause comment; dumpbin quote), #13954 (dup; FabianLars feature-recipe), #14580, #13948 (lucasfernog fix, confirmed), #11028, #13718/#13719, #6926/#12247/#10164 (manifest-in-shipped-apps history), rust-embed-resource#69 + cargo#10937 (`-link-arg-tests` broken for unit tests; `rustc-link-arg` unscoped is the working lever). Cargo book build-scripts (link-arg scoping table). MS docs: NTSTATUS 0xC0000139; ComCtl32 v5/v6 side-by-side. Upstream CI patterns: tauri `test-core.yml` (no mock-app integration binary on Windows), tao `ci.yml` (gated test steps), wry `build.yml` (WebView2 runtime provisioned). tauri-specta CI green on Windows with `default-features = false`.
- Local: `src-tauri/build.rs` (now `try_build` + `new_without_app_manifest()` + the unscoped `/MANIFEST:EMBED` `/MANIFESTINPUT:windows-app-manifest.xml` `/WX` args, gated on `windows`+`msvc`; the vendored `src-tauri/windows-app-manifest.xml` is md5-identical to `tauri-build/src/windows-app-manifest.xml`), `src-tauri/tests/ipc.rs:125–152` (build-on-A/run-on-B layout), `src/lib.rs:262–268` (dialog plugin registration; lib never builds an App), vendored `tauri-winres-0.3.6/src/lib.rs:541`, `tauri-build-2.7.2/src/lib.rs:369` (`new_without_app_manifest`).

## Gaps

- macOS fix verifiable only via CI (no Mac hardware here; the crash was non-deterministic — evidence standard = N green runs).
- Nobody upstream runs a `mock_builder` **integration** binary on `windows-latest`; the manifest fix is blessed for library consumers (#13948) — CI is our proof for the test-target shape.

## Follow-ups

- File the macOS finding upstream (first filers): `unsafe impl Sync` on `RuntimeContext` + `main_thread_id`-at-build unsoundness vs the documented `mock_builder` usage.
- Delete the follow-up bullet in `docs/roadmap/multi-platform-build-and-release.md` once the gate is gone.
