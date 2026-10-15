//! The build script.
//!
//! Windows/MSVC carries one extra load-bearing step: the Common-Controls-v6
//! application manifest has to reach EVERY target, not just the app binary.
//! `tauri_build::build()` embeds it through `tauri-winres` →
//! `embed_resource::compile()`, and that prints `cargo:rustc-link-arg-bins`
//! — link args scoped to `[[bin]]` targets only. Integration-test (and
//! bench/example/cdylib) targets therefore link against System32 comctl32
//! v5.82, which has no `TaskDialogIndirect`, so the loader kills the process
//! at LOAD time with `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND` before a
//! single test runs. That is upstream tauri#13419 (open); the full
//! investigation, the rejected alternatives and the evidence live in
//! `docs/research/tauri-mock-runtime-test-crashes.md`.
//!
//! The upstream-blessed workaround (lucasfernog in tauri#13419, confirmed in
//! tauri#13948) is exactly what the `windows-msvc` branch below does: take
//! the manifest away from `tauri-winres` (`new_without_app_manifest()`, so
//! the `-link-arg-bins`-scoped resource never carries it) and re-emit it
//! ourselves with the UNSCOPED `cargo:rustc-link-arg` form, which per the
//! Cargo book applies to "benchmarks, binaries, cdylib crates, examples, and
//! tests". `windows-app-manifest.xml` next to this file is a byte-for-byte
//! copy of the manifest `tauri-build` embeds today (verified: same md5 as
//! `tauri-build-<v>/src/windows-app-manifest.xml`), so the SHIPPED app keeps
//! the identical manifest — see the comment above the link args for the
//! superset argument.

/// The vendored copy of `tauri-build`'s default Windows application
/// manifest, next to this build script.
const WINDOWS_MANIFEST_FILE: &str = "windows-app-manifest.xml";

fn main() {
    // Only MSVC has `mt.exe`; the `-gnu` (MinGW) target keeps today's path
    // unchanged (manifest inside the compiled `.rc`, binaries-scoped) rather
    // than losing the manifest outright, so nothing regresses there.
    let embed_manifest_unscoped = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");

    // `WindowsAttributes::new_without_app_manifest()` differs from
    // `WindowsAttributes::new()` in ONE field — `app_manifest: None`. Every
    // other default (`window_icon_path: None` → resolved from
    // `bundle > icon` / `icons/icon.ico`, `static_vc_runtime: None` → read
    // from `build > windows > staticVCRuntime`, empty `append_rc_content`) is
    // untouched, so the version info, company/file/product name strings and
    // the app icon still land in the resource file exactly as before.
    let windows_attributes = if embed_manifest_unscoped {
        tauri_build::WindowsAttributes::new_without_app_manifest()
    } else {
        tauri_build::WindowsAttributes::new()
    };

    let attributes = tauri_build::Attributes::new().windows_attributes(windows_attributes);

    // `try_build` is the non-panicking twin of `tauri_build::build()`
    // (`build_with` does not exist in tauri-build 2.7.x); mirror `build()`'s
    // diagnostic so a bad `tauri.conf.json` still explains itself.
    if let Err(error) = tauri_build::try_build(attributes) {
        let error = format!("{error:#}");
        println!("{error}");
        if error.starts_with("unknown field") {
            println!(
                "found an unknown configuration field. This usually means that you are using a CLI version that is newer than `tauri-build` and is incompatible. Please try updating the Rust crates by running `cargo update` in the Tauri app folder."
            );
        }
        std::process::exit(1);
    }

    if embed_manifest_unscoped {
        // The manifest `tauri-winres` would have embedded, re-emitted
        // unscoped so tests/benches/examples/cdylbs get it too.
        //
        // Superset argument (why NOTHING silently disappears from the
        // shipped app): `WindowsAttributes` in tauri-build 2.7.2 has exactly
        // four knobs — `window_icon_path`, `static_vc_runtime`,
        // `app_manifest`, `append_rc_content` — and there is NO dpi-awareness
        // / supportedOS / requestedExecutionLevel / webview2Drop-support
        // knob anywhere in tauri-build or tauri-winres 0.3.6 (grep for those
        // strings hits doc examples only). `tauri-winres` has no default
        // manifest template at all: `WindowsResource::new()` starts with
        // `manifest: None` and tauri-build hands it ours
        // (`res.set_manifest(&manifest)`), which it writes as resource type
        // 24 id 1 — the same slot `mt.exe /MANIFEST:EMBED` fills. And
        // `tauri.conf.json` has no manifest-driven key for this app (no
        // `build.windows.webviewInstallMode` drop-support, no execution-level
        // setting). So the vendored file being byte-equal to tauri-build's
        // default IS the equal-and-nothing-lost guarantee; the "superset" is
        // only over the SET OF TARGETS, which is the whole point.
        let manifest = std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")))
            .join(WINDOWS_MANIFEST_FILE);
        let manifest = manifest.canonicalize().unwrap_or(manifest);
        println!("cargo:rerun-if-changed={}", manifest.display());
        // Embed the manifest into every target this package links.
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        // Turn linker warnings into errors — the same guard tauri's own
        // `embed_manifest_for_tests()` prints, so a manifest that stops
        // merging fails the build instead of shipping a v5.82 load crash.
        println!("cargo:rustc-link-arg=/WX");
    }
}
