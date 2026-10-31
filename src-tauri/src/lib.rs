pub mod agent;
pub mod agents;
pub mod attention;
pub mod commands;
pub mod config;
pub mod navigation_guard;
pub mod open;
pub(crate) mod roots;
pub mod skills;
pub mod storage;
#[doc(hidden)]
pub mod test_support;
pub mod types;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::Manager;

use crate::agent::worker::client::WorkerHandle;
use crate::agent::worker::manager::{WorkerFactory, WorkerManager};
use crate::agent::{
    crashlog, debuglog, EventSink, SessionManagerBuilder, SubagentSessionManager,
    TranscriptPersister,
};
use crate::storage::Db;

/// The production `WorkerFactory` (the `current_exe()` Worker — the
/// `--worker` mode of this same binary; the `WorkerHandle`'s spawn
/// passes the flag). Tests inject the `fake_worker` fixture instead
/// (the `setup_dirs_with_factory` seam).
pub struct ProductionWorkerFactory;

impl WorkerFactory for ProductionWorkerFactory {
    fn spawn(&self) -> Result<WorkerHandle, crate::agent::worker::client::WorkerError> {
        let exe = std::env::current_exe().expect("the current exe (the Worker binary)");
        WorkerHandle::spawn(exe.as_path())
    }
}

/// The shared app setup (the `test_support` seam): the session manager
/// (settings-driven native sessions), the persistence database in
/// `app_data_dir/archimedes.db`, and the `WorkerManager` (ADR 0025 — the
/// session's `AgentLoop` runs in the Worker; the `SessionManager` is the
/// Supervisor-side coordinator).
///
/// Factored out of [`run`] so the real command surface can be exercised in
/// tests without a GUI (see `tests/ipc.rs`). The `WorkerFactory` is the
/// PRODUCTION one (`current_exe()`); the test variant is
/// [`setup_dirs_with_factory`] (the injectable factory — the `test_support`
/// pattern).
pub fn setup_dirs<R: tauri::Runtime>(
    app: &tauri::App<R>,
    config_dir: PathBuf,
    app_data_dir: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    setup_dirs_with_factory(app, config_dir, app_data_dir, None)
}

/// The `setup_dirs` seam (the `test_support` pattern — the injectable
/// `WorkerFactory`): `None` = the production factory (`current_exe()`);
/// `Some(factory)` = the test factory (the `fake_worker` fixture — the
/// `tests/ipc.rs` headless command-surface test). Everything else is
/// IDENTICAL to [`setup_dirs`].
pub fn setup_dirs_with_factory<R: tauri::Runtime>(
    app: &tauri::App<R>,
    config_dir: PathBuf,
    app_data_dir: PathBuf,
    worker_factory: Option<Arc<dyn WorkerFactory>>,
) -> Result<(), Box<dyn std::error::Error>> {
    // The persistence database lives in the app data directory.
    let db = Arc::new(
        Db::open(&app_data_dir.join("archimedes.db"))
            .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?,
    );

    // The event sink (TauriSink) is managed state so commands — and the
    // headless IPC test — can obtain it without an `AppHandle` parameter.
    //
    // It must be managed under the TRAIT-OBJECT type `Arc<dyn EventSink>`:
    // the commands resolve it as `State<Arc<dyn EventSink>>` and Tauri's
    // state registry is keyed by TypeId — managing the concrete
    // `Arc<TauriSink<R>>` registers a different key, and `start_session`
    // fails at runtime with "state not managed for field `sink`".
    // (`Arc::<dyn EventSink>::new` doesn't compile because `dyn EventSink`
    // is unsized, so the coercion is spelled as an annotated binding.)
    let sink: Arc<dyn EventSink> = Arc::new(commands::sessions::TauriSink(app.handle().clone()));
    app.manage(sink.clone());

    let persister = Arc::new(TranscriptPersister::new(db.clone()));

    let mut builder =
        SessionManagerBuilder::new(config_dir.clone(), db.clone(), sink.clone(), persister)
            .with_crash_log_dir(app_data_dir.clone())
            .with_subagent_manager(Arc::new(SubagentSessionManager::new()))
            .with_dead_bound_secs(
                crate::config::load_settings(&config_dir).subagent_dead_bound_secs,
            );

    if let Some(wf) = worker_factory {
        builder = builder.with_worker_factory(wf);
    }

    let handle_any = Box::new(app.handle().clone()) as Box<dyn std::any::Any>;
    if let Ok(handle) = handle_any.downcast::<tauri::AppHandle<tauri::Wry>>() {
        builder = builder.with_app_handle(*handle);
    }

    let (manager, wm) = builder.build();

    // The `WorkerManager` is managed state (the `set_space_trusted`
    // command's running-Workers `Config` push + the `test_support`
    // registry accessor).
    app.manage(wm);
    // The manager is `Sync` (its mutable state is `Arc<Mutex<…>>`
    // internally), so it is shared directly without an outer lock.
    app.manage(manager);
    app.manage(db);
    // The attention countdown (ADR 0038/0039): the renderer decides WHEN and
    // WHAT, Rust only counts down — a backgrounded webview is throttled
    // (tauri-apps/tauri#5250) and a hidden window is this feature's whole
    // customer, so the clock cannot live in the renderer. Both external facts
    // are boxed seams (the timer stays testable with no window and no OS
    // notification, and this fn stays generic over `R`).
    //
    // The focus probe FAILS OPEN for firing: a missing window or an
    // `is_focused()` error yields `false` = "not focused" → the alert fires. A
    // window that cannot report its focus is certainly not the window the user
    // is reading.
    //
    // The raw answer is reduced by [`focus_probe_trace`], which exists so the
    // three cases are DISTINGUISHABLE in the debug log: under GNOME/Wayland
    // "no window labelled main", "`is_focused()` refused" and "it answered
    // `true`" all produce the same silence today, and only one of them is the
    // probe working as designed. The ruling is unchanged — the log is the only
    // addition.
    let focus_handle = app.handle().clone();
    let focus: crate::attention::FocusProbe = std::sync::Arc::new(move || {
        let raw = focus_handle
            .get_webview_window("main")
            .map(|w| w.is_focused().map_err(|e| e.to_string()));
        let (focused, line) = focus_probe_trace(raw);
        debuglog::log(&line);
        focused
    });
    // The text is composed by the renderer and passed through verbatim; a
    // delivery failure (no notification server on this desktop session) is
    // silently swallowed — the alert is a courtesy, never an error to surface.
    // That promise is to the USER and stands unchanged; what changes is that the
    // `ARCHIMEDES_DEBUG` log now hears the `Display` of the failure instead of
    // nothing, which is the difference between "we tried and the OS said no" and
    // "we never tried".
    //
    // Which transport runs is the seam's own business (`attention::delivery`):
    // the session-bus desktops send it themselves because the connection that
    // sent an alert is what keeps it on screen there, and macOS/Windows go
    // through the plugin.
    let deliver = attention::delivery::production(app.handle());
    app.manage(std::sync::Arc::new(attention::AttentionTimer::new(
        focus, deliver,
    )));
    Ok(())
}

/// The focus probe's raw answer, reduced to `(the boolean the countdown sees,
/// the line for the debug log)`.
///
/// PURE (no window, no `AppHandle`) so the fail-open mapping and its wording are
/// testable — the same `append_to` shape `agent/debuglog.rs` uses to keep a
/// global-state side effect out of the logic. `None` = no `WebviewWindow`
/// labelled `"main"` was resolvable from the countdown's thread; `Err(msg)` =
/// `is_focused()` refused, with its `Display`.
///
/// Both answer "not focused" — the fail-open rule this fn inherits verbatim —
/// and BOTH say which one they were, because under GNOME/Wayland the two are the
/// difference between "the probe lied about a real window" and "there was no
/// window to ask", and only the first is a focus problem.
fn focus_probe_trace(window: Option<Result<bool, String>>) -> (bool, String) {
    match window {
        // Named BY LABEL: a window that is not in the map at all (a label
        // mismatch, or a window the runtime does not expose to this thread) is
        // the candidate root cause a `Notify`-less countdown points at.
        None => (
            false,
            "attention: focus probe: no window labelled \"main\" — firing anyway (fail open)"
                .to_string(),
        ),
        Some(Err(e)) => (
            false,
            format!(
                "attention: focus probe: is_focused() refused: {e} — firing anyway (fail open)"
            ),
        ),
        // The boring case, still narrated: a `false` from a probe that worked is
        // a different diagnosis from a `false` from a probe that gave up.
        Some(Ok(focused)) => (
            focused,
            format!("attention: focus probe: is_focused()={focused}"),
        ),
    }
}

/// What asked for the webview's key focus, reduced to the two things the
/// decision needs. Pure so the platform matrix is testable off-Windows: the
/// `cfg` is evaluated at the CALL site (`cfg!(windows)`) and handed in as data,
/// so the branch that governs a platform this machine cannot compile for is
/// still a branch a test on Linux can execute.
#[derive(Debug, PartialEq, Eq)]
enum KeyFocusTrigger<'a> {
    /// `RunEvent::Ready` — fresh launch, the window revealed by
    /// `tauri-plugin-window-state` and never clicked.
    Ready,
    /// A `WindowEvent::Focused` carrying its `focused` flag and window label.
    WindowFocused(bool, &'a str),
}

/// Does this trigger ask for the webview's key focus, on this platform?
///
/// **Only the `Focused(true)` arm is gated, and only off Windows** — which is
/// the correction of a claim ADR 0057 records as verified. Its delivery matrix
/// says `Focused(true)` is not delivered on Windows, and from that it argued the
/// arm "cannot steal a sibling widget's focus". The conclusion was right about
/// the mechanism and wrong about the platform: Windows DOES route a focus event
/// here — `add_GotFocus` on the WebView2 controller sends
/// `SynthesizedWindowEvent::Focused(true)`
/// (`tauri-runtime-wry-2.11.4/src/lib.rs:5293-5310`) and the dispatcher turns it
/// into the same `RunEvent::WindowEvent` (`:4237-4252`). Two consequences, and
/// ADR 0057 was blind to both:
///
/// 1. On Windows the event means **WEBVIEW WIDGET** focus, not window
///    activation — precisely the case the safety argument ruled out. **Clicking
///    the webview fires it.**
/// 2. `Webview::set_focus()` on Windows is `MoveFocus(PROGRAMMATIC)`
///    (`wry-0.57.0/src/webview2/mod.rs:1583-1590`), and Microsoft defines that as
///    re-assigning focus inside the page — "focus is set to previously focused
///    element **or the default element** if no previously focused element
///    exists" (`ICoreWebView2Controller::MoveFocus`). So each click was answered
///    by a programmatic DOM focus move racing the click's own focus assignment:
///    the caret flickers out of the composer and the click never lands. That is
///    the reported Windows failure (ADR 0061).
///
/// `Ready` is deliberately kept on every platform, Windows included. It fires
/// once at launch, before any interaction, so it cannot participate in the loop
/// above; dropping it would change a Windows path that has shipped since v0.3.0
/// without a complaint about it, on the one platform this repo cannot test.
fn key_focus_grab_needed(is_windows: bool, trigger: &KeyFocusTrigger<'_>) -> bool {
    match trigger {
        // Fresh launch, every platform: the window the state plugin reveals holds
        // no widget key focus. Cannot fight a click — no click has happened yet.
        KeyFocusTrigger::Ready => true,
        // Activation re-assert. On Windows this is the WEBVIEW widget's focus
        // event, and re-asserting there breaks clicking, so Windows is excluded.
        KeyFocusTrigger::WindowFocused(true, "main") => !is_windows,
        _ => false,
    }
}

/// The webview key-focus attempt, reduced to its log line.
///
/// PURE (no window, no `AppHandle`) so the wording is testable — the same
/// `focus_probe_trace` shape one screen above, and for the same reason: the
/// mock runtime has no widget, so this is the half headless can pin, and
/// `tests/webview_key_focus.rs` owns the behaviour. `None` = no `WebviewWindow`
/// labelled `"main"` was resolvable from the event-loop callback; `Err(msg)` =
/// `Webview::set_focus()` refused, with its `Display`.
///
/// **Every arm returns a line** — nothing here is silent. A fix justified by a
/// measurement has to be readable in the field: "keys are dead and there is no
/// `focus:` line" must not be ambiguous between "the arm never ran" and "it ran
/// and succeeded", which is the same reasoning that makes `focus_probe_trace`
/// narrate its boring case. It is also what makes the deferred manual
/// measurement in `tests/webview_key_focus.rs` self-reading.
///
/// The impure wrapper's `debuglog::log` call is covered by these three lines
/// plus that ignored check — do NOT add a mock `App` to pin it: a second
/// `generate_context!()` in this test binary duplicates `embed_plist`'s
/// `_EMBED_INFO_PLIST` and reddens macOS `cargo test` while
/// `cargo clippy`/`check` stay green (they emit metadata only).
fn webview_focus_trace(lookup: Option<Result<(), String>>) -> Option<String> {
    match lookup {
        // Named BY LABEL: the label the config declares is `main`, so a `None`
        // here is either a label mismatch or an arm that ran before the window
        // existed — and those want different fixes.
        None => Some("focus: no window labelled \"main\" — key focus not grabbed".into()),
        Some(Err(e)) => Some(format!("focus: webview set_focus refused: {e}")),
        // The boring case, still narrated (see the doc comment): this line is
        // the evidence the manual measurement is waiting for.
        Some(Ok(())) => Some("focus: webview key focus grabbed".into()),
    }
}

/// Grab KEY focus for the webview WIDGET (not the window) — see ADR 0056, and
/// ADR 0061 for WHEN this may be called (never from a focus-in on Windows).
///
/// ⚠ The MECHANISM IS UNVERIFIED. The symptom is user-confirmed (no key reaches
/// JS at fresh launch until the window is clicked) but the reason is not: the
/// earlier theory that wry's creation-time `grab_focus()` lands on an unmapped
/// widget was REFUTED (see ADR 0056). This call is a candidate fix; the
/// measurement is deferred to `tests/webview_key_focus.rs -- --ignored`.
///
/// `window.as_ref()` resolves through `AsRef<Webview<R>> for WebviewWindow<R>`
/// — the only `AsRef`/`Deref` impl on that type, so it needs no disambiguation,
/// and `Webview::set_focus()` is ungated. Note `WebviewWindow::set_focus` is the
/// WRONG (window-level) sibling — the window-state plugin already calls that
/// one, and it is precisely what does not move the widget's key focus. The
/// ungated accessors are the only ones available: `Manager::get_webview`,
/// `webviews` and `get_focused_window` are all `#[cfg(feature = "unstable")]`
/// and this crate builds `tauri` with no features.
fn grab_webview_key_focus<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) {
    let line = webview_focus_trace(
        handle
            .get_webview_window("main")
            .map(|window| window.as_ref().set_focus().map_err(|e| e.to_string())),
    );
    if let Some(line) = line {
        debuglog::log(&line);
    }
}

/// The Worker mode (ADR 0025): a fresh tokio runtime + the stdio JSONL
/// worker (`agent::worker::run_worker_inner`). Checked BEFORE Tauri
/// init in `main` — the Tauri runtime never starts in a Worker.
pub fn run_worker() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("the worker tokio runtime");
    runtime.block_on(agent::worker::run_worker_inner());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The Supervisor's crash hook (ADR 0025 Task 6 — the Task-2 shared
    // hook, tag `"supervisor"`): a Supervisor panic STILL kills the app
    // (it IS the app — the `release` profile's `panic = "unwind"` only
    // protects the WORKERS), but a `crash-<ts>-supervisor-<pid>.log` now
    // exists; the live Workers exit cleanly on the stdin EOF (the
    // `worker_smoke` test's EOF case). The `ARCHIMEDES_DEBUG` init
    // reads the var ONCE (the cached check — `log` is a free no-op when
    // unset).
    //
    // The directory is resolved HERE, at install time, and handed to the
    // hook: the hook must never resolve anything during the panic, or the
    // closure occupying the single process-global hook slot decides where
    // every thread's crash log goes.
    //
    // A `None` data dir is not a supported state — `setup()` hard-fails
    // on it (`lib.rs`, "could not resolve the platform data dir"), so
    // skipping the hook here is belt-and-braces, not a mode.
    if let Some(base) = dirs::data_dir() {
        crashlog::install_panic_hook("supervisor", base.join("archimedes"));
    }
    debuglog::init_from_env();
    // The navigation guard (ADR 0051 Task 3): a navigation to anything that is
    // not the app's OWN page is refused, so an anchor nobody wrote a handler
    // for cannot replace this frameless window (no back, no reload). It is a
    // `plugin::Builder` hook rather than a window-builder one because the app
    // window is declared in `tauri.conf.json`, and a plugin's hook IS consulted
    // for a config-created webview; any plugin that says no wins
    // (`tauri-2.12.2/src/plugin.rs:953-962`). `TAURI_DEV_HOST` is read ONCE
    // here so the predicate itself stays pure — see `crate::navigation_guard`
    // for what is allowed, and why (the app's own url, and IPC, must not be
    // refused).
    let dev_host = std::env::var("TAURI_DEV_HOST").ok();
    // The turbofish is load-bearing: nothing else pins the plugin's `R` nor
    // the config type `C`, so inference gives up.
    let navigation_guard = tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
        .on_navigation(move |webview, url| {
            crate::navigation_guard::is_render_webview(webview.label())
                || crate::navigation_guard::is_app_url(url, dev_host.as_deref())
        })
        .build();
    let app = tauri::Builder::default()
        .plugin(navigation_guard)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            // issue #91: the render webview for a `fetch_content` escalation
            // is built `visible(false)`, but this plugin's default flags are
            // `StateFlags::all()` — including `VISIBLE` — and its
            // `on_window_ready` restore `show()`s + `set_focus()`es any label
            // with NO saved state. Every render label embeds a fresh uuid, so
            // it never has one: the plugin was revealing a window the app
            // deliberately hid, and stealing focus. The filter (a prefix test,
            // not `with_denylist`'s exact labels — the render label set is not
            // enumerable in advance) also keeps those labels from permanently
            // growing `.window-state.json`. `main` stays tracked: `tauri.conf.json`
            // ships `"visible": false` and ADR 0021 relies on this plugin to
            // reveal it, so no `with_state_flags` change here.
            tauri_plugin_window_state::Builder::default()
                .with_filter(crate::navigation_guard::should_track_label)
                .build(),
        )
        // The OS notification for an attention alert (ADR 0038) — called from
        // Rust only, so no capability entry and no npm package (the plugin's
        // `request_permission` is a documented no-op on desktop).
        .plugin(tauri_plugin_notification::init())
        // The auto-updater (ADR 0053) — a BUILDER, not `init()`. Registered for
        // the Rust side only: nothing in `capabilities/default.json` refers to it,
        // so the webview reaches it through our three commands and never holds
        // updater or restart rights. It is also the ONE target-gated plugin here
        // (its dep is gated to the three desktop OSes, which is all this app
        // builds); a mobile port would gate this registration and `commands::update`
        // with the same `cfg` — `generate_handler!` takes no per-entry `cfg`, so it
        // would be a second handler list, not an attribute.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::sessions::start_session,
            commands::sessions::send_prompt,
            commands::sessions::close_session,
            commands::sessions::respond_permission,
            commands::sessions::respond_interactive_request,
            commands::sessions::resume_session,
            commands::sessions::set_session_config_option,
            commands::sessions::cancel_session,
            commands::sessions::compact_session,
            commands::sessions::get_stalled_info,
            commands::history::list_sessions,
            commands::history::load_history,
            commands::history::delete_session,
            commands::history::set_session_archived,
            commands::history::session_recency,
            commands::history::reorder_sessions,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::list_models,
            commands::settings::list_tools,
            commands::settings::list_known_providers,
            commands::settings::shell_sandbox_available,
            commands::settings::test_mcp_server,
            commands::settings::auth_mcp_server,
            commands::settings::test_search_provider,
            commands::mcp::list_mcp_servers_effective,
            commands::agents::list_agent_definitions_for_space,
            commands::agents::list_agent_definition_reports,
            commands::spaces::list_spaces,
            commands::spaces::delete_space,
            commands::spaces::space_for_path,
            commands::spaces::set_space_trusted,
            commands::spaces::reorder_spaces,
            commands::skills::list_skills,
            commands::clipboard::read_clipboard_image,
            commands::files::read_file_bytes,
            commands::files::list_space_listing,
            commands::files::list_completion_entries,
            commands::attention::attention_arm,
            commands::attention::attention_disarm,
            commands::open::external_open,
            commands::window_state::get_window_state,
            commands::update::check_update,
            commands::update::install_update,
            commands::update::relaunch_app,
        ])
        .setup(|app| {
            // The on-disk dirs are named `archimedes` (NOT the bundle
            // identifier — Tauri's `config_dir()` / `app_data_dir()`
            // append the identifier, which would give
            // `…/codes.archimedes.desktop`): `~/.config/archimedes` +
            // `~/.local/share/archimedes` (Linux), `~/Library/Application
            // Support/archimedes` (macOS), `%APPDATA%/archimedes` +
            // `%LOCALAPPDATA%/archimedes` (Windows). `dirs` resolves the
            // platform base dirs the same way Tauri does; a `None` base
            // means the platform home is undeterminable — a hard error
            // (the app has nowhere to persist state).
            let config_dir = dirs::config_dir()
                .map(|p| p.join("archimedes"))
                .ok_or_else(|| -> Box<dyn std::error::Error> {
                    "could not resolve the platform config dir".into()
                })?;
            let app_data_dir = dirs::data_dir().map(|p| p.join("archimedes")).ok_or_else(
                || -> Box<dyn std::error::Error> {
                    "could not resolve the platform data dir".into()
                },
            )?;
            setup_dirs(app, config_dir, app_data_dir)?;

            #[cfg(target_os = "linux")]
            commands::window_state::install_gtk_bridge(app);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    // The `run` callback form (ADR 0025 — the `RunEvent` hook): on
    // `Exit` (the event loop is exiting — the Tauri 2 name for the
    // `Exited` event; the app is about to terminate), reap the live
    // Workers (the graceful `close` + grace + `kill` — the Workers'
    // stdin EOF → clean exit 0). The `reap_all` is async (the `close`
    // + grace + `kill` select) — the `Exit` callback is NOT in a tokio
    // context (the event loop is Tauri's own), so a fresh
    // current-thread runtime drives it (a short-lived, bounded block —
    // the process is exiting anyway).
    app.run(|handle, event| {
        // The webview, not the window, must hold key focus or no key event reaches
        // JS. `Ready` does that on every platform; the `Focused(true)` re-assert is
        // withheld on Windows, and that withholding is the fix for "nothing is
        // clickable on Windows" (ADR 0061, superseding ADR 0057's platform matrix).
        // `&event`: RunEvent is owned here and `label` is a String, so a by-value
        // `if let` partially moves `event` and the `Exit` arm below stops compiling
        // (E0382). `..` is required — the variant is `#[non_exhaustive]`.
        //
        // The decision is `key_focus_grab_needed`, NOT a hand-written match here:
        // the platform is passed in as `cfg!(windows)` DATA so the Windows branch
        // is executed by a test on Linux (`tests::windows_never_grabs_key_focus_*`).
        // A `cfg`-gated match here would compile that branch out of the Linux test
        // binary, which is exactly how ADR 0057's Windows claim went unexamined
        // while this repo's CI was green.
        //
        // THREE facts, each of which reads wrong without them:
        //
        // 1. `Ready` is here because tauri's OWN `setup()` — the one that creates
        //    the config window — runs inside the `Ready` arm before this callback,
        //    so the grab cannot precede the window's existence. ⚠ Do NOT also
        //    claim it is ordered after the window-state plugin's reveal: the
        //    plugin's `on_window_ready` goes through `run_on_main_thread`, which
        //    executes inline, so that ordering is a coincidence of the inline
        //    queue and not a guarantee.
        //
        // 2. ⚠ `Focused(true)` DOES arrive on Windows. ADR 0057 recorded the
        //    opposite after reading only `WindowEventWrapper::map_from_tao`, where
        //    the `#[cfg(windows)]` path really does return `Self(None)` for our
        //    shape. It missed the SECOND, Windows-only source: the WebView2
        //    controller's `add_GotFocus` handler synthesises
        //    `SynthesizedWindowEvent::Focused(true)`
        //    (`tauri-runtime-wry-2.11.4/src/lib.rs:5293-5310`), and that dispatches
        //    straight into the `RunEvent::WindowEvent` matched below (`:4237-4252`).
        //    So on Windows this event means WEBVIEW WIDGET focus — the very case
        //    0057 argued was impossible — and re-asserting it moves the DOM caret
        //    off the element the user just clicked. On Linux/macOS the only source
        //    is window activation (`connect_focus_in_event` / `windowDidBecomeKey`),
        //    so the re-assert is safe there and is what fixes minimise/restore.
        //
        // 3. The macOS `Webview::focus()` implementation runs
        //    `self.webview.window().unwrap()` before `makeFirstResponder`
        //    (`wry-0.57.0/src/wkwebview/mod.rs:1057-1064`) — so a webview that
        //    was ever detached from its window turns this arm into a PANIC inside
        //    the event-loop callback. Accepted (tauri's own macOS build attaches
        //    the webview to the window), but it is why this arm is not free.
        let trigger = match &event {
            tauri::RunEvent::Ready => Some(KeyFocusTrigger::Ready),
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Focused(focused),
                ..
            } => Some(KeyFocusTrigger::WindowFocused(*focused, label)),
            _ => None,
        };
        if let Some(trigger) = trigger {
            if key_focus_grab_needed(cfg!(windows), &trigger) {
                grab_webview_key_focus(handle);
            }
        }
        if let tauri::RunEvent::Exit = event {
            if let Some(wm) = handle.try_state::<Arc<WorkerManager>>() {
                let wm = wm.inner().clone();
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("the exit reap runtime");
                rt.block_on(wm.reap_all());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{focus_probe_trace, key_focus_grab_needed, webview_focus_trace, KeyFocusTrigger};

    // ── The platform gate (`key_focus_grab_needed`) ─────────────────────────
    //
    // The Windows input failure (a user with a real machine: nothing clickable,
    // no typing, the composer visibly gaining and losing focus) is caused by the
    // focus-in arm running ON WINDOWS. ADR 0057's delivery matrix asserts that
    // cannot happen — "Windows routes webview focus through
    // `add_GotFocus`/`add_LostFocus` INSTEAD", i.e. never reaches this arm. It
    // does reach it: that handler sends
    // `SynthesizedWindowEvent::Focused(true)` (`tauri-runtime-wry-2.11.4/src/lib.rs:5293-5310`)
    // and the dispatcher turns it into exactly the `RunEvent::WindowEvent` this
    // arm matches (`:4237-4252`). So on Windows the arm fires on WEBVIEW widget
    // focus, and `Webview::set_focus()` there is `MoveFocus(PROGRAMMATIC)`
    // (`wry-0.57.0/src/webview2/mod.rs:1583-1590`) — it yanks DOM focus away from
    // the element the user just clicked. Hence the flicker and the dead clicks.
    //
    // These pin the matrix so the false premise cannot be re-introduced by a
    // reader who trusts the comment over the crate.

    /// Windows must never grab **from the focus-in arm**. That event means
    /// WEBVIEW WIDGET focus there, and `set_focus()` on Windows is
    /// `MoveFocus(PROGRAMMATIC)`, which re-assigns DOM focus — so answering a
    /// click with it is what made clicks vanish and the caret flicker.
    #[test]
    fn windows_never_grabs_from_the_focus_in_arm() {
        assert!(
            !key_focus_grab_needed(true, &KeyFocusTrigger::WindowFocused(true, "main")),
            "on Windows Focused(true) is a WIDGET focus change — grabbing there \
             steals the caret from whatever was just clicked"
        );
    }

    /// `Ready` stays on Windows. It fires once at launch before any interaction,
    /// so it cannot be part of the click/focus loop, and removing it would alter
    /// a Windows path that has shipped since v0.3.0 uncomplained — on the one
    /// platform this repo has no way to test. Pinned so a later "simplify by
    /// disabling Windows entirely" change has to answer this test.
    #[test]
    fn windows_still_grabs_once_at_ready() {
        assert!(
            key_focus_grab_needed(true, &KeyFocusTrigger::Ready),
            "fresh launch needs the grab on Windows too — it precedes any click"
        );
    }

    /// Linux and macOS keep BOTH triggers: `Ready` for fresh launch, and
    /// `Focused(true)` for minimise/restore and ⌘-tab, which re-map the window
    /// with nothing re-asserting the widget. ADR 0057 got this half right.
    #[test]
    fn linux_and_macos_keep_both_triggers() {
        assert!(
            key_focus_grab_needed(false, &KeyFocusTrigger::Ready),
            "fresh launch: the revealed window holds no key focus"
        );
        assert!(
            key_focus_grab_needed(false, &KeyFocusTrigger::WindowFocused(true, "main")),
            "activation: minimise/restore needs the re-assert too"
        );
    }

    /// A blur is not a focus-in: grabbing on `Focused(false)` would move focus
    /// at the exact moment the user is leaving the window.
    #[test]
    fn a_focus_loss_never_grabs_on_any_platform() {
        for windows in [true, false] {
            assert!(
                !key_focus_grab_needed(windows, &KeyFocusTrigger::WindowFocused(false, "main")),
                "Focused(false) must not grab (windows={windows})"
            );
        }
    }

    /// The `label == "main"` filter is behavioural, not cosmetic: a second window
    /// (a future Settings window, a WebviewWindow per Space) activating must not
    /// yank key focus into the main webview.
    #[test]
    fn only_the_main_window_focus_in_grabs() {
        assert!(
            !key_focus_grab_needed(false, &KeyFocusTrigger::WindowFocused(true, "settings")),
            "another window's focus-in must not grab the MAIN webview's focus"
        );
    }

    /// A window that cannot be FOUND is not a window the user is reading, so
    /// the probe fires (fail open) — and says it never got a window, BY LABEL,
    /// because under GNOME/Wayland `get_webview_window("main")` returning `None`
    /// is a live candidate for "the countdown ran and no notification followed".
    #[test]
    fn a_missing_window_fires_and_says_which_window_was_missing() {
        let (focused, line) = focus_probe_trace(None);
        assert!(!focused, "no window means unfocused, so the alert fires");
        assert!(
            line.starts_with("attention:"),
            "the greppable prefix: {line}"
        );
        assert!(line.contains("main"), "the line names the label: {line}");
        assert!(
            line.contains("no window"),
            "and says the lookup failed: {line}"
        );
    }

    /// `is_focused()` refusing is the OTHER Wayland candidate; the ruling must
    /// name the error, or the log cannot tell it apart from a real `false`.
    #[test]
    fn an_is_focused_error_fires_and_names_the_error() {
        let (focused, line) = focus_probe_trace(Some(Err("focus probe boom".into())));
        assert!(
            !focused,
            "a window that cannot answer is treated as unfocused"
        );
        assert!(
            line.contains("is_focused()"),
            "the line names the call: {line}"
        );
        assert!(line.contains("focus probe boom"), "and its Display: {line}");
    }

    /// The unremarkable case still has to say what it returned: `false` from a
    /// probe that worked reads differently from `false` from a probe that gave up.
    #[test]
    fn the_probe_reports_the_boolean_it_handed_back() {
        let (focused, line) = focus_probe_trace(Some(Ok(true)));
        assert!(focused, "a focused window suppresses the alert");
        assert!(line.contains("is_focused()=true"), "{line}");
        let (focused, line) = focus_probe_trace(Some(Ok(false)));
        assert!(!focused);
        assert!(line.contains("is_focused()=false"), "{line}");
    }

    // The delivery line moved to `attention::delivery::tests` with the delivery
    // itself (`the_success_line_carries_the_id_the_server_gave`,
    // `the_failure_line_names_the_error`, `the_plugin_line_admits_it_knows_nothing`)
    // — the claim it pins is now per-transport, so it lives with the transports.

    // ── The webview KEY-focus seam (`webview_focus_trace`) ──────────────────
    //
    // The same pure-reduction shape as `focus_probe_trace` above, and for the
    // same reason: the mock runtime has no widget, so the only half a headless
    // test can pin is what the attempt SAYS. A second `generate_context!()` in
    // this binary duplicates `embed_plist`'s `_EMBED_INFO_PLIST` and reddens
    // macOS `cargo test` while clippy stays green — so there is deliberately no
    // `App`/`mock_builder` here, and the behaviour itself belongs to the
    // `#[ignore]`d human-read check in `tests/webview_key_focus.rs`.

    /// A window that is not in the map means the grab never happened, and the
    /// line has to say WHICH window it went looking for — `main` is the label
    /// the config declares, so a mismatch there is the whole diagnosis.
    #[test]
    fn a_missing_window_says_which_window_was_missing() {
        let line = webview_focus_trace(None).expect("a failed lookup always has something to say");
        assert!(line.starts_with("focus:"), "the greppable prefix: {line}");
        assert!(line.contains("main"), "the line names the label: {line}");
        assert!(
            line.contains("no window"),
            "and says the lookup failed: {line}"
        );
    }

    /// The widget refusing the grab is a DIFFERENT failure from there being no
    /// widget to ask, so the line names the call and carries its `Display`.
    #[test]
    fn a_refused_focus_names_the_error() {
        let line = webview_focus_trace(Some(Err("focus boom".into())))
            .expect("a refused grab always has something to say");
        assert!(line.starts_with("focus:"), "the greppable prefix: {line}");
        assert!(
            line.contains("set_focus"),
            "the line names the call that refused: {line}"
        );
        assert!(line.contains("focus boom"), "and its Display: {line}");
    }

    /// The success case is NARRATED, and that is the deliberate divergence from
    /// the plan, which had this arm silent. Three reasons, all real: a fix
    /// justified by a measurement has to be readable in the field ("keys dead
    /// and no `focus:` line" cannot tell "the arm never ran" from "it ran and
    /// worked"); `focus_probe_trace` in this very file already narrates its
    /// boring case for exactly that reason ("the boring case, still narrated");
    /// and the deferred manual measurement in `tests/webview_key_focus.rs` is
    /// only self-reading if a success leaves a trace. So NO arm of
    /// `webview_focus_trace` is silent — an absent line always means the arm
    /// never ran.
    #[test]
    fn a_successful_grab_says_so() {
        let line = webview_focus_trace(Some(Ok(())))
            .expect("a successful grab is narrated too — that line is the measurement's evidence");
        assert!(line.starts_with("focus:"), "the greppable prefix: {line}");
        assert!(line.contains("grabbed"), "and says the lever fired: {line}");
    }

    // ── The window-state registration (`tauri_plugin_window_state`) ─────────
    //
    // issue #91: the `fetch_content` render webview is built `visible(false)`,
    // but this plugin's DEFAULT flags are `StateFlags::all()` — `VISIBLE`
    // included — and its `on_window_ready` restore answers a label with no
    // saved state by calling `show()` + `set_focus()`. Every render label
    // carries a fresh uuid, so it NEVER has saved state: the plugin revealed a
    // window the app deliberately hid, and stole focus to do it.
    // `navigation_guard::should_track_label` is the predicate that excludes it,
    // and its own unit test proves the predicate answers correctly — but nothing
    // about whether this registration CONSULTS it. Deleting the `.with_filter`
    // line below leaves every other test in this binary green and reintroduces
    // the bug whole, so the configuration itself has to be pinned at its site of
    // use.
    //
    // The assertion is TEXTUAL because no headless form of it exists: the mock
    // runtime has no widget (see the note above), and a real `App` cannot be
    // built in this binary at all — a second `generate_context!()` duplicates
    // `embed_plist`'s `_EMBED_INFO_PLIST`, a link error on macOS. Reading our
    // own source is the same trade the frontend already makes with `readFileSync`
    // in `src/components/chromeButton.test.ts` and
    // `src/components/settings/primitives.test.tsx`: pin the convention a
    // behavioural test cannot reach.

    /// The window-state plugin must be registered WITH the render-webview
    /// filter. Two conditions, both on the same statement: the qualified
    /// `Builder` token exists, and `with_filter(should_track_label)` follows it
    /// closely.
    #[test]
    fn window_state_plugin_is_registered_with_the_render_webview_filter() {
        // Cargo runs the test binary with cwd at the crate root (`src-tauri/`),
        // so a repo-relative path would miss; anchor on the manifest dir.
        let src = std::fs::read_to_string(format!("{}/src/lib.rs", env!("CARGO_MANIFEST_DIR")))
            .expect("lib.rs readable");

        // Anchor on the FULLY QUALIFIED token. A bare `Builder` is ambiguous
        // here — this file also holds `tauri::plugin::Builder::<Wry>` (the
        // navigation guard), `tauri::Builder` (the app) and
        // `tokio::runtime::Builder` — and matching the wrong one reddens this
        // test while the registration is perfectly fine.
        //
        // `find` takes the FIRST occurrence, which is the registration itself.
        // If someone deletes that registration, the next occurrence is this
        // test's own prose, ~600 bytes before the `assert!` below — outside any
        // sane window — so the test goes RED rather than finding the filter
        // string a few lines away and passing on the strength of its own text.
        let anchor = "tauri_plugin_window_state::Builder";
        let idx = src
            .find(anchor)
            .expect("the window-state plugin is registered by its qualified Builder");

        // A BOUNDED window after the anchor, so the check cannot drift onto an
        // unrelated later `.plugin(...)` call. It is whitespace-blind — the
        // registration is spread over several lines by `rustfmt` and
        // reformatting must not redden this test — but NOT length-blind: adding
        // another method or a comment line inside the registration can push the
        // filter past this window, and that reddens the test BY DESIGN, as a
        // prompt to re-read what this registration now does. Widening `WINDOW`
        // is the correct response to that red, not deleting the assertion.
        const WINDOW: usize = 200;
        let statement = &src[idx..idx + WINDOW.min(src.len() - idx)];
        assert!(
            statement.contains("with_filter(crate::navigation_guard::should_track_label)"),
            "the window-state registration must carry the filter that keeps the \
             `fetch_content` render webview hidden and out of `.window-state.json` \
             (issue #91) — `with_filter(crate::navigation_guard::should_track_label)` \
             is missing from the {} bytes after `{anchor}`",
            statement.len(),
        );
    }
}
