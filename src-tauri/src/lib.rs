pub mod agent;
pub mod agents;
pub mod attention;
pub mod commands;
pub mod config;
pub mod navigation_guard;
pub mod open;
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
use crate::agent::{crashlog, debuglog, EventSink, SessionManager, SubagentSessionManager};
use crate::storage::Db;

/// The production `WorkerFactory` (the `current_exe()` Worker — the
/// `--worker` mode of this same binary; the `WorkerHandle`'s spawn
/// passes the flag). Tests inject the `fake_worker` fixture instead
/// (the `setup_dirs_with_factory` seam).
struct ProductionWorkerFactory;

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
    // The session manager is settings-driven (the config dir is the
    // `settings.json` home — the desktop is native-only: there is no agent
    // registry and no pi config seeding).
    let mut manager = SessionManager::new(config_dir.clone());
    // The persistence database lives in the app data directory.
    let db = Arc::new(
        Db::open(&app_data_dir.join("archimedes.db"))
            .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?,
    );
    manager.attach_db(db.clone());
    // The subagent manager (the ADR 0025 Task 5 re-plumb — the
    // in-process subagent machinery is GONE: the dispatch runs in a
    // WORKER via the `WorkerManager`'s `dispatch_subagent` flow — the
    // `WorkerManager` is forwarded by `attach_worker_manager` (the
    // `set_worker_manager` + the child-cwd registrar); the manager is NO
    // LONGER managed Tauri state (the `respond_*` commands route through
    // the `SessionManager`'s `WorkerManager` `handle_for` — a subagent
    // session's handle is in the `drives` map)).
    manager.set_subagent_manager(Arc::new(SubagentSessionManager::new()));
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
    // The router's `SinkFrame` re-emit target (the `setup_dirs` late-wire
    // — set BEFORE the `WorkerManager`'s callbacks can fire).
    manager.set_sink(sink.clone());
    // The `WorkerManager` (ADR 0025 — the session's `AgentLoop` runs in
    // the Worker): the LATE-WIRE (the `SessionManager` ↔ `WorkerManager`
    // construction cycle — the `WorkerManager`'s `on_event` / `on_crash`
    // callbacks need the `SessionManager`'s router / crash handler, and
    // the `SessionManager` needs the `WorkerManager` to send prompts):
    // the callbacks capture the `Arc<SessionManager>` (the `attach_*`
    // methods are `&self` — the `OnceLock` `set` needs no exclusive
    // access), then `attach_worker_manager` hands the `WorkerManager`
    // to the `SessionManager` after both are built.
    let manager = Arc::new(manager);
    let wm = {
        let m = manager.clone();
        let m2 = manager.clone();
        let sink_for = sink.clone();
        Arc::new(
            WorkerManager::new(
                worker_factory.unwrap_or_else(|| Arc::new(ProductionWorkerFactory)),
                Arc::new(move |session_id, code| m.handle_crash(&session_id, code)),
                Arc::new(move |session_id, is_subagent, evt| {
                    m2.route_event(&session_id, is_subagent, evt)
                }),
                // The parent-scope sink lookup (the subagent UI lifecycle
                // events — the single shared `TauriSink`).
                Arc::new(move |_| Some(sink_for.clone())),
            )
            // The ADR 0055 **Dead bound** (the `settings.json`
            // `subagentDeadBoundSecs` key): SECONDS of unexplained silence before a
            // **Subagent session** is reaped as Dead. Applied at the ONE production
            // construction site (a builder, not a 5th `WorkerManager::new`
            // parameter — the other 12 call sites keep the default).
            .with_dead_bound_secs(
                crate::config::load_settings(&config_dir).subagent_dead_bound_secs,
            ),
        )
    };
    manager.attach_worker_manager(wm.clone());
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
    // protects the WORKERS), but a `crash-<ts>-supervisor.log` now
    // exists; the live Workers exit cleanly on the stdin EOF (the
    // `worker_smoke` test's EOF case). The `ARCHIMEDES_DEBUG` init
    // reads the var ONCE (the cached check — `log` is a free no-op when
    // unset).
    crashlog::install_panic_hook("supervisor");
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
    // The turbofish is load-bearing: nothing else pins the plugin's `R` (the
    // webview argument is unused) nor the config type `C`, so inference gives up.
    let navigation_guard = tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
        .on_navigation(move |_webview, url| {
            crate::navigation_guard::is_app_url(url, dev_host.as_deref())
        })
        .build();
    let app = tauri::Builder::default()
        .plugin(navigation_guard)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::list_models,
            commands::settings::list_tools,
            commands::settings::list_known_providers,
            commands::settings::shell_sandbox_available,
            commands::settings::test_mcp_server,
            commands::settings::auth_mcp_server,
            commands::mcp::list_mcp_servers_effective,
            commands::agents::list_agent_definitions,
            commands::agents::list_agent_definitions_for_space,
            commands::spaces::list_spaces,
            commands::spaces::delete_space,
            commands::spaces::space_for_path,
            commands::spaces::set_space_trusted,
            commands::skills::list_skills,
            commands::clipboard::read_clipboard_image,
            commands::files::read_file_bytes,
            commands::files::list_space_files,
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
    use super::focus_probe_trace;

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
}
