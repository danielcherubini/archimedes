//! The app's configuration model + `settings.json` I/O + the known-providers
//! catalog (extracted from `commands/settings.rs`, which keeps only the
//! `#[tauri::command]` wrappers + the wire DTOs).
//!
//! `{ "theme": "system" | "dark" | "light", "paneLayout": {...}, ... }`
//! with sane defaults written on first run. All extended fields are
//! `#[serde(default)]` so a pre-feature file parses to the defaults (no
//! migration needed). A corrupt file yields the defaults + a logged warning
//! — a bad file must never block app startup.
//!
//! LAYERING: this module is a LEAF (std + serde + exactly two `agent`
//! vocabulary imports — `agent::harness::WireApi` and
//! `agent::policy::{FilePolicy, AccessRule}`; no `commands` / `storage`
//! imports) — the domain (`agent`) and the IPC layer (`commands`) both depend
//! on it, never the other way.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::harness::WireApi;
use crate::agent::policy::{AccessRule, FilePolicy};

/// A user-managed LLM provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// The provider's id: the slug of its name (the desktop's Settings page
    /// derives it from the name — a name commit re-identifies the provider,
    /// remapping the `default_model` / `default_thinking_levels` references
    /// old → new; a blank name keeps the current id).
    pub id: String,
    pub name: String,
    /// Normalized base URL (…/v1).
    pub base_url: String,
    /// Plaintext (empty = local gateway, no key).
    pub api_key: String,
    /// The wire API (ADR 0024): `"openai-completions"` (the default — a
    /// pre-feature file parses to it, no migration) / `"anthropic-messages"`
    /// / `"openai-responses"` / `"litellm"` (discovery via `GET /model/info`,
    /// wire = openai-completions — ADR 0026).
    #[serde(default = "default_provider_api")]
    pub api: String,
    /// The key-management page URL (set by the known-providers picker — the
    /// row's "Get key" link; `None` for a hand-typed provider).
    #[serde(default)]
    pub key_url: Option<String>,
    /// The provider's auth mode (issue #125): `"api_key"` (the default — a
    /// pre-feature file parses to it) | `"oauth"` | `"oidc"` | `"gcloud_adc"`.
    /// A STRING, not an enum, matching `api`'s permissive-boundary style;
    /// validate at use, not at parse. Additive: pre-feature files parse
    /// untouched via the serde default.
    #[serde(default = "default_provider_auth_mode")]
    pub auth_mode: String,
}

fn default_provider_api() -> String {
    "openai-completions".to_string()
}

fn default_provider_auth_mode() -> String {
    "api_key".to_string()
}

/// Font settings for the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontSettings {
    /// UI font size in px (default 14).
    #[serde(default = "default_font_size")]
    pub size_px: u32,
    /// `None` = the design system's pinned sans stack (the app default —
    /// the `index.css` stack resolves to `"Noto Sans"` first, with the
    /// system tail as the offline fallback).
    #[serde(default)]
    pub ui_family: Option<String>,
    /// `None` = the design system's pinned mono stack (the app default —
    /// the `index.css` stack resolves to `"Fira Code"` first, with the
    /// system tail as the offline fallback).
    #[serde(default)]
    pub code_family: Option<String>,
}

fn default_font_size() -> u32 {
    14
}

fn default_theme() -> String {
    "dark".to_string()
}

/// The serde missing-field default for a `true`-by-default bool (the shape of
/// `default_theme` / `default_font_size`: a non-`false` default needs a
/// named function, `#[serde(default)]` alone would mean `false`).
fn default_true() -> bool {
    true
}

/// The serde missing-field default for `attention_alert_delay_secs`: 15 s —
/// half of pi-archimedes' 30 s terminal default, affordable here because the
/// desktop also gates the alert on window focus (ADR 0038). SECONDS, not
/// millis: the value crosses the IPC boundary as `delaySecs`.
fn default_attention_delay_secs() -> u64 {
    15
}

/// The serde missing-field default for `subagent_dead_bound_secs`: 1800 s (the
/// 30 minutes the ADR 0055 **Dead bound** shipped with). SECONDS, not millis —
/// the same unit rule as `attention_alert_delay_secs`.
fn default_subagent_dead_bound_secs() -> u64 {
    1800
}

/// The `web_search` / `fetch_content` configuration (the settings' `web`
/// block). Every field is optional; an unset key means "this Search provider
/// is not available" (or, for `defaultProvider`/`proxy`, "auto"/"none").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WebSettings {
    pub brave_api_key: String,
    pub tavily_api_key: String,
    pub perplexity_api_key: String,
    /// The self-hosted SearXNG instance base URL.
    pub searxng_url: String,
    /// `"auto"` (default) or one of `brave|tavily|perplexity|searxng|duckduckgo`.
    pub default_provider: String,
    /// An explicit proxy URL. Empty = fall back to `HTTPS_PROXY`/`HTTP_PROXY`.
    pub proxy: String,
}

/// (ADR 0066 / 0067) One agent's override — the VALUE of
/// `Settings::agent_overrides`.
///
/// **Field ABSENCE is the only meaning of "this override does not speak"**
/// (ADR 0067): an unset field is absent from the document
/// (`skip_serializing_if = "Option::is_none"`), never `null` — a `"model":
/// null` would be a third state for the resolver to reconcile, and the whole
/// point of the rule is that the UI's "clear this override" and the
/// resolver's "skip this layer" are literally the same fact. A `tools` list
/// that is EMPTY also speaks not (ADR 0067, enforced in
/// `launch::resolve_agent_launch`), so no override can zero out a child.
///
/// Derived `Default` is safe HERE and only because every field is an
/// `Option` (all-absent = "says nothing") — unlike `FontSettings`, whose
/// hand-written `Default` exists because a derived one would produce
/// `size_px: 0`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentOverrideFields {
    /// The model ref (`"provider/id"`, or a hand-edited
    /// `"provider/id:<level>"` — the `:<level>` suffix is a thinking-level
    /// candidate handled downstream, exactly as in ADR 0023).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// A thinking level. Honoured only when the model that actually runs
    /// advertises it (`launch::resolve_agent_launch` demotes it otherwise).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// The tool allowlist. An EMPTY list is ABSENT (ADR 0067).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
}

/// The persisted app settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// `"system" | "dark" | "light"` (default `"dark"`).
    #[serde(default = "default_theme")]
    pub theme: String,
    /// (ADR 0027) The color scheme: `"zai" | "dracula"`. `None` = `"zai"` (a
    /// pre-feature file — `#[serde(default)]`, no migration). Orthogonal to
    /// `theme` (the light/dark mode): we ship Dracula's dark variant only (a
    /// scope decision), so `dracula` PINS the app dark and the mode is ignored
    /// — the spec's light reading, Alucard Classic, is deferred, not impossible.
    #[serde(default)]
    pub palette: Option<String>,
    /// Free-form pane layout state (owned by the frontend).
    #[serde(default)]
    pub pane_layout: Value,
    /// Whether to trust new Spaces by default.
    #[serde(default)]
    pub default_trust_new_spaces: bool,
    /// Whether the composer's `#` MCP-server mention is live (ADR 0031's
    /// follow-up). `#[serde(default)]` = `false`, so a pre-feature
    /// `settings.json` ships `#` OFF: `#` is the one mention prefix that
    /// collides with pasted text (`#include`, `#123`, `#hashtag` all match
    /// the token grammar), so it is opt-in while `$` and `@` are always on.
    /// Gates the TRIGGER only — the display side still parses a persisted
    /// `<mcp>` block, and the MCP catalog command stays available.
    #[serde(default)]
    pub mcp_mentions_enabled: bool,
    /// (ADR 0030) The per-direction file-access policies. `#[serde(default)]`
    /// — a pre-feature file parses to `FilePolicy::default()` (all `Allow`),
    /// so no migration runs. NOTE: that default is WIDER than the pre-feature
    /// hardcoded behavior — out of the box a session reads and writes anywhere
    /// and runs `bash` with no prompt, including in an untrusted Space (this
    /// makes ADR 0010's prompt opt-in). Intentional; see ADR 0030 Deviation 2.
    #[serde(default)]
    pub file_policy: FilePolicy,
    /// The web tools' configuration (ADR-less; see `docs/roadmap/web-search-and-fetch.md`).
    /// `#[serde(default)]` — a pre-feature file parses to `WebSettings::default()`
    /// (all empty ⇒ only the keyless `duckduckgo` Search provider is available).
    #[serde(default)]
    pub web: WebSettings,
    /// `"provider/id"`; `None` = system default.
    #[serde(default)]
    pub default_model: Option<String>,
    /// The per-app thinking-level seed (the native session start's last
    /// rung: remembered > stored > this > `None`); `None` = the model's
    /// own default. `#[serde(default)]` — a pre-feature file parses to
    /// `None` (no migration needed).
    #[serde(default)]
    pub default_thinking_level: Option<String>,
    /// The harness-level tool filter: `[]` = all tools enabled (the native
    /// `AgentLoop` maps an empty list to `None` = all). `#[serde(default)]`
    /// — a pre-feature file parses to `[]` (no migration needed).
    #[serde(default)]
    pub enabled_tools: Vec<String>,
    /// User-managed providers (default `[]`).
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    /// (ADR 0019) The user-managed MCP servers: `name → entry` in pi's
    /// `mcpServers` entry shape VERBATIM (an entry copy-pastes between the
    /// two files). Merged into the harness's effective set at global
    /// precedence (project > desktop > pi-global). `#[serde(default)]` —
    /// a pre-feature file parses to `{}` (no migration).
    #[serde(default)]
    pub mcp_servers: HashMap<String, Value>,
    /// Font settings.
    #[serde(default)]
    pub font: FontSettings,
    /// (ADR 0015) The per-model remembered thinking level: the composed
    /// model key (`"<provider>/<id>"`) → the last EXPLICITLY chosen level.
    /// `#[serde(default)]` — a pre-feature file parses to an empty map.
    #[serde(default)]
    pub default_thinking_levels: HashMap<String, String>,
    /// (ADR 0023 — RETIRED by ADR 0066) The per-agent subagent model map:
    /// agent name → model key. READ-ONLY from here on — `load_settings` folds
    /// its values into [`Settings::agent_overrides`] and clears it, and
    /// `skip_serializing` (UNCONDITIONAL, not `skip_serializing_if =
    /// "HashMap::is_empty"`) is what makes the dead key disappear from the
    /// file on the next save, permanently. The two spellings are equivalent
    /// for anything reaching a save through `load_settings` (the fold clears
    /// the map); the unconditional form also survives a writer that builds a
    /// `Settings` literal by hand, which is the one path where a retired key
    /// could leak back onto the wire.
    ///
    /// Honouring the legacy key on READ is what makes the upgrade a
    /// non-loss: the models a user pinned in Settings keep applying.
    #[serde(default, skip_serializing)]
    pub subagent_models: HashMap<String, String>,
    /// (ADR 0066) Global Agent overrides keyed by agent NAME — the one
    /// override layer between the explicit `subagent` params and an Agent
    /// definition's frontmatter (ADR 0067's chain: explicit > override >
    /// frontmatter > parent). There is NO per-Space map: the Space decides
    /// which definitions get listed, never which overrides apply (ADR 0066's
    /// *Deferred: per-Space* is the only door back to a second map, and it
    /// re-opens additively).
    ///
    /// Serialized camelCase like every other key in this file —
    /// `agentOverrides: { "scout": { "model": … } }` — and matched
    /// CASE-INSENSITIVELY by name, exactly as ADR 0023's map was (the stored
    /// key is never rewritten; the UI writes `def.name` verbatim).
    ///
    /// `#[serde(default)]` and deliberately **NOT** `skip_serializing_if`:
    /// every map field in this struct serializes an EMPTY map as `"key": {}`
    /// (`mcpServers`, `defaultThinkingLevels`), and the TypeScript
    /// `AppSettings` declares each of them required. Dropping the key when
    /// empty would hand the renderer `undefined` for a required field and make
    /// the Agents modal throw for every user who has never pinned anything.
    /// Pinned by
    /// `agent_overrides_default_to_an_empty_map_that_still_serializes`.
    #[serde(default)]
    pub agent_overrides: HashMap<String, AgentOverrideFields>,
    /// The working-indicator spinner style (the `braille-loader` variant name,
    /// e.g. `"typing"` / `"pendulum"`): the animation the chat's top working
    /// indicator runs while the agent is busy. `None` = the frontend's
    /// `typing` default (a pre-feature file — `#[serde(default)]`, no
    /// migration).
    #[serde(default)]
    pub spinner_style: Option<String>,
    /// The **Transcript**'s empty-state animation: `"off"` / `"static"` /
    /// `"animated"`. `None` = the frontend's `"animated"` default (a
    /// pre-feature file — `#[serde(default)]`, no migration). `prefers-reduced-motion`
    /// can pin `"animated"` to `"static"` but can never un-`off` a deliberate
    /// `"off"` (ADR 0070).
    #[serde(default)]
    pub empty_state_animation: Option<String>,
    /// Session naming (ported from pi-archimedes' `session-name`): the master
    /// switch for the post-first-exchange title request. `#[serde(default =
    /// "default_true")]` — pi ships naming ON, so a pre-feature file reads as
    /// enabled (unlike the `#[serde(default)]` bools above, whose default is
    /// `false`).
    #[serde(default = "default_true")]
    pub session_naming_enabled: bool,
    /// The model used for title generation: the composed key
    /// (`"provider/id"`, or a hand-edited `"provider/id:<level>"`). `None` /
    /// blank = the session's own model (pi's `model` setting).
    #[serde(default)]
    pub session_naming_model: Option<String>,
    /// The thinking level for the title request. Honoured ONLY when the chosen
    /// model advertises it; `None` = omit the `reasoning_effort` key (the
    /// default — `ModelOptions.reasoning_effort: None` already means "no
    /// thinking" here, so pi's `minimal` default would ADD cost). JSON-only:
    /// there is no settings row for it.
    #[serde(default)]
    pub session_naming_reasoning: Option<String>,
    /// Attention alerts (ADR 0038/0039): the master switch for the OS
    /// notification raised when a session has been paused on the user
    /// (finished, or waiting on a gate) for longer than
    /// `attention_alert_delay_secs`. `#[serde(default = "default_true")]` — the
    /// feature ships ON, so a pre-feature file reads as enabled (the
    /// `session_naming_enabled` pattern, not the `#[serde(default)]`-false one).
    #[serde(default = "default_true")]
    pub attention_alerts_enabled: bool,
    /// The delay between an attention trigger and the alert, in SECONDS.
    /// `#[serde(default = "default_attention_delay_secs")]` = 15 — half of
    /// pi-archimedes' 30 s terminal default, affordable here because the desktop
    /// also gates on window focus. There is no clamping LAYER on purpose: the
    /// Settings select is the only producer, and the only bound is the
    /// sanity ceiling in `commands::attention`.
    #[serde(default = "default_attention_delay_secs")]
    pub attention_alert_delay_secs: u64,
    /// The ADR 0055 **Dead bound**: SECONDS a **Subagent session** may stay
    /// silent with no tool execution outstanding before it is reaped as Dead.
    /// It bounds UNEXPLAINED SILENCE **as the Supervisor observes it** (the gap
    /// between frames the pump actually read — a parent starved of CPU can
    /// observe a gap a live child never stopped producing into), never the length
    /// of the delegation — an **Active Subagent** (producing frames, or holding an
    /// outstanding `tool_call_id`) has no timeout of any kind, so no value here
    /// can cut a working child. 1800 s: the provider layer already self-bounds a
    /// stalled stream at a 5-minute idle `read_timeout`, so silence past twice
    /// that with nothing in flight is a wedged Worker, not a slow model.
    /// `settings.json`-only (no Settings-UI control, deliberately — the
    /// `session_naming_reasoning` precedent).
    #[serde(default = "default_subagent_dead_bound_secs")]
    pub subagent_dead_bound_secs: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            palette: None,
            pane_layout: Value::Object(Default::default()),
            default_trust_new_spaces: false,
            mcp_mentions_enabled: false,
            file_policy: FilePolicy::default(),
            web: WebSettings::default(),
            default_model: None,
            default_thinking_level: None,
            enabled_tools: Vec::new(),
            providers: Vec::new(),
            mcp_servers: HashMap::new(),
            font: FontSettings::default(),
            default_thinking_levels: HashMap::new(),
            subagent_models: HashMap::new(),
            agent_overrides: HashMap::new(),
            spinner_style: None,
            empty_state_animation: None,
            session_naming_enabled: true,
            session_naming_model: None,
            session_naming_reasoning: None,
            attention_alerts_enabled: true,
            attention_alert_delay_secs: default_attention_delay_secs(),
            subagent_dead_bound_secs: default_subagent_dead_bound_secs(),
        }
    }
}

/// HAND-WRITTEN (do NOT `#[derive(Default)]` — a derived `Default` would
/// give `size_px: 0`, a second "default" that diverges from the serde
/// missing-field default of 14):
impl Default for FontSettings {
    fn default() -> Self {
        Self {
            size_px: default_font_size(),
            // The app default (a fresh settings file): Noto Sans for the
            // UI, Fira Code for code — both the `index.html` Google Fonts
            // families (the quoted CSS family names the frontend's
            // `applySettingsFont` splices into the `--font-sans` /
            // `--font-mono` stacks).
            ui_family: Some("\"Noto Sans\"".to_string()),
            code_family: Some("\"Fira Code\"".to_string()),
        }
    }
}

fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

/// Read the settings from the config dir. A MISSING file → the defaults
/// (written to disk, as today — a write failure is LOGGED via `eprintln!`
/// and the defaults are still returned: the write is best-effort, the app
/// must not fail to load). A CORRUPT file (unreadable OR unparseable) → the
/// defaults + a logged warning (`eprintln!`), NOT an `Err` — a bad file must
/// never block app startup; the file is left untouched until the next
/// `save_settings`.
pub fn load_settings(config_dir: &Path) -> Settings {
    let path = settings_path(config_dir);
    if !path.exists() {
        let settings = Settings::default();
        let json = match serde_json::to_string_pretty(&settings) {
            Ok(json) => json,
            Err(e) => {
                eprintln!("settings: failed to serialize defaults: {e}");
                return settings;
            }
        };
        if let Err(e) = fs::write(&path, json) {
            eprintln!("settings: failed to write defaults to {path:?}: {e}");
        }
        return settings;
    }
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) => {
            eprintln!("settings: unreadable {path:?}: {e}; using defaults");
            return Settings::default();
        }
    };
    match serde_json::from_str::<Settings>(&raw) {
        Ok(mut settings) => {
            // A hand-edited file may carry a blank level (the frontend never
            // SAVES `""`): a blank level is "no level" — the same as `null`.
            if settings.default_thinking_level.as_deref() == Some("") {
                settings.default_thinking_level = None;
            }
            // The naming override follows the same rule but is deliberately
            // WIDER: an ALL-WHITESPACE key is blank too, so a hand-typed
            // value with a stray space is read as "no override" instead of a
            // model id that misses the catalog. The trim tests blankness
            // ONLY — a non-blank value keeps its spelling verbatim (the
            // resolver that consumes it does its own trimming). The
            // reasoning override has NO such rule: a blank level is passed
            // through untouched.
            if settings
                .session_naming_model
                .as_deref()
                .is_some_and(|model| model.trim().is_empty())
            {
                settings.session_naming_model = None;
            }
            // (ADR 0066) Fold the retired `subagentModels` map (ADR 0023) into
            // `agentOverrides` so an upgrading user keeps every model they
            // pinned, then CLEAR the legacy map so the dead key never returns
            // to the file (`subagent_models` is `skip_serializing`).
            //
            // It lives HERE and not in the `get_settings` command because the
            // Worker reads this file directly (`launch.rs`) — a command-side
            // fold would give the two processes different views of one file.
            //
            // GUARDED by "the new map is EMPTY", NOT merged: a file carrying
            // BOTH keys is a hand-edit and the new key wins wholesale. Merging
            // per-agent would make the legacy key able to RESURRECT a value the
            // user has already cleared in the modal.
            //
            // Scope note: this runs only on the read that PRECEDES a save for a
            // file that PARSES — the missing-file and corrupt/unreadable paths
            // return `Settings::default()` and never fold, so a hand-edited
            // legacy key inside an otherwise-corrupt file is dropped (the
            // pre-existing behaviour for every field in this struct).
            if settings.agent_overrides.is_empty() && !settings.subagent_models.is_empty() {
                settings.agent_overrides = settings
                    .subagent_models
                    .drain()
                    .map(|(name, model)| {
                        (
                            name,
                            AgentOverrideFields {
                                model: Some(model),
                                thinking: None,
                                tools: None,
                            },
                        )
                    })
                    .collect();
            }
            settings.subagent_models.clear();
            settings
        }
        Err(e) => {
            eprintln!("settings: corrupt {path:?}: {e}; using defaults");
            Settings::default()
        }
    }
}

/// Persist the settings (overwrites the file). In-process writers (the
/// `set_config_option` memory writes — ADR 0015) call this directly; the
/// command delegates to it.
pub fn write_settings(config_dir: &Path, settings: &Settings) -> Result<(), String> {
    let path = settings_path(config_dir);
    fs::write(
        &path,
        serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Persist the settings ATOMICALLY (temp-file + rename). The relay's
/// whole-document overwrites (the permissions append) use this so a torn
/// write can never destroy the file — the rename is atomic-on-POSIX and
/// atomic-in-practice on Windows NTFS (`tempfile` 3.x's `persist` uses
/// `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`, so it succeeds when the
/// destination exists; the crate's documented copy+remove fallback covers
/// cross-volume/dir edge cases). Deliberately NOT the shared entry point:
/// the Settings page (`save_settings`) keeps [`write_settings`], whose exact
/// serialized bytes are pinned by the tests above.
///
/// No non-atomic fallback on purpose: a partial `fs::write` after a failed
/// `persist` is exactly the torn write this exists to prevent, so a failure
/// returns `Err` and the temp is cleaned by its `Drop`.
pub fn write_settings_atomic(config_dir: &Path, settings: &Settings) -> Result<(), String> {
    use std::io::Write;

    let path = settings_path(config_dir);
    // `new_in` needs a non-empty parent: `config_dir` is the settings file's
    // own directory (the same dir `write_settings` writes into).
    let mut tmp = tempfile::NamedTempFile::new_in(config_dir)
        .map_err(|e| format!("settings: temp create failed: {e}"))?;
    tmp.write_all(
        serde_json::to_string_pretty(settings)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    // Mode preservation (DECIDED): `NamedTempFile` creates the temp with mode
    // 0o600 (`file/imp/unix.rs`: `unwrap_or(0o600)`) and the rename takes the
    // TEMP's mode — without this the atomic write would silently tighten
    // `settings.json` from its configured mode (typically 0644) to 0600 on
    // unix. That silent mode change is exactly the unrequested behaviour
    // change this repo's rules forbid, so the existing file's mode is copied
    // onto the temp before the rename. Pinned by
    // `write_settings_atomic_preserves_the_existing_files_mode_on_unix`
    // (`#[cfg(unix)]` — Windows has no mode concept, so nothing is pinned
    // there and this block is not even compiled).
    #[cfg(unix)]
    {
        if let Ok(md) = fs::metadata(&path) {
            // Best-effort: a mode we cannot read (or cannot set) must not fail
            // the write — the file's CONTENTS are the load-bearing half.
            let _ = fs::set_permissions(&tmp, md.permissions());
        }
    }
    tmp.persist(&path).map_err(|e| e.to_string())?;
    Ok(())
}

/// The relay's settings-write shape: load FRESH, mutate in place, atomic
/// overwrite. The fresh [`load_settings`] is load-bearing — writing a
/// document built from a STALE read can silently clobber another writer's
/// field.
///
/// This NARROWS the read-modify-write window to one function call; it is NOT
/// a lock and does NOT close the window. `settings.json` has six+ independent
/// writers (the Settings page's whole-document save, `set_config_option`, this
/// relay, …) and nothing serializes them, so NO lock is added here.
///
/// THE RESIDUAL LOST UPDATE, concretely (recorded, deliberately NOT fixed in
/// this task): (1) the user sees the permissions prompt and clicks "Always
/// allow this directory"; (2) this helper reads `settings.json` (no rule yet),
/// appends the rule in memory, and `write_settings_atomic` lands it — the file
/// is correct; (3) a moment later the Settings page's user clicks Save, and
/// `save_settings` writes a WHOLE document composed from a `useSettingsDocument`
/// store snapshot taken BEFORE step 2 (that store refreshes only when the
/// Settings page loads); (4) the whole-document overwrite replaces the file
/// with a document that has no rule — the user's "always allow" silently
/// evaporates. It is SILENT because the relay already returned `Ok` and its
/// failure path is best-effort-logged anyway: afterwards the file simply lacks
/// the rule, with no error anywhere. `useSettingsDocument`'s Agents-modal write
/// queue serializes only the frontend's OWN modal writes; it never serializes
/// against the Rust writers. Atomicity protects the FILE (no torn write), not
/// the WRITERS — that is exactly why this sequence survives.
///
/// The recorded follow-up is a settings-write `RwLock` or a save-version /
/// merge at the `useSettingsDocument` boundary. A second Rust writer touching
/// this file MUST come through here rather than a
/// `load_settings`-mutate-`write_settings` sequence with a stale read.
pub fn load_mutate_write<F: FnOnce(&mut Settings)>(config_dir: &Path, f: F) -> Result<(), String> {
    let mut settings = load_settings(config_dir);
    f(&mut settings);
    write_settings_atomic(config_dir, &settings)
}

/// Append exactly one rule, unless an IDENTICAL one is already present
/// (dedupe by path + direction + decision — a second "always allow this
/// directory" click is idempotent, not a duplicate Settings row that
/// re-orders the file). A rule that differs in ANY field is a NEW rule and
/// appends: a hand-written `deny` for the same path coexists with an appended
/// `allow`.
///
/// Dedupe compares the PERSISTED spelling verbatim — `~/.pi/agent/agents` and
/// `/home/u/.pi/agent/agents` are two rules, because matching canonicalizes at
/// MATCH time, never at write time (see `AccessRule::path`). `Vec::contains`
/// is `O(n)`, which is right for a hand-sized rule list.
pub(crate) fn append_rule(rules: &mut Vec<AccessRule>, rule: AccessRule) {
    if !rules.contains(&rule) {
        rules.push(rule);
    }
}

/// A known provider template (the built-in catalog — the Settings'
/// known-providers picker's data source; ADR 0024). Seeded from the
/// ZCode builtin provider catalog (`config/provider/zcode-builtin.json`
/// `templateRules` — base URLs / key URLs / wire APIs VERBATIM; ids +
/// display names ADAPTED (see the `KNOWN_PROVIDERS` comment).
pub struct KnownProvider {
    pub id: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    pub api: WireApi,
    pub key_url: &'static str,
}

pub const KNOWN_PROVIDERS: &[KnownProvider] = &[
    // (the 20 entries — seeded from the ZCode catalog: base URLs / key
    // URLs / wire apis VERBATIM from `templateRules`; ids + display names
    // ADAPTED — ZCode `zai-standard-api` → `zai-api`, `moonshot-kimi` →
    // `kimi`, `qwen-alibaba-model-studio-cn`/`-intl` → `alibaba-cn`/`-intl`,
    // `opencode-*-messages` → `opencode-*-anthropic`, names simplified
    // (`Z.ai Coding Plan` → `Z.ai`, `BigModel Coding Plan` → `BigModel`);
    // the order is the ZCode catalog's order with the six OpenCode entries
    // regrouped: go-chat, go-anthropic, go-responses, zen-chat,
    // zen-anthropic, zen-responses)
    KnownProvider {
        id: "zai",
        name: "Z.ai",
        base_url: "https://api.z.ai/api/anthropic",
        api: WireApi::AnthropicMessages,
        key_url: "https://z.ai/manage-apikey/apikey-list",
    },
    KnownProvider {
        id: "zai-api",
        name: "Z.ai API",
        base_url: "https://api.z.ai/api/paas/v4",
        api: WireApi::OpenAiCompletions,
        key_url: "https://z.ai/manage-apikey/apikey-list",
    },
    KnownProvider {
        id: "bigmodel",
        name: "BigModel",
        base_url: "https://open.bigmodel.cn/api/anthropic",
        api: WireApi::AnthropicMessages,
        key_url: "https://bigmodel.cn/coding-plan/personal/overview",
    },
    KnownProvider {
        id: "bigmodel-api",
        name: "BigModel API",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        api: WireApi::OpenAiCompletions,
        key_url: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    },
    KnownProvider {
        id: "kimi",
        name: "Kimi",
        base_url: "https://api.moonshot.cn/anthropic",
        api: WireApi::AnthropicMessages,
        key_url: "https://platform.kimi.com/console/api-keys",
    },
    KnownProvider {
        id: "minimax",
        name: "MiniMax",
        base_url: "https://api.minimaxi.com/anthropic",
        api: WireApi::AnthropicMessages,
        key_url: "https://platform.minimaxi.com/console/access?tab=api-keys",
    },
    KnownProvider {
        id: "deepseek",
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/anthropic",
        api: WireApi::AnthropicMessages,
        key_url: "https://platform.deepseek.com/api_keys",
    },
    KnownProvider {
        id: "alibaba-cn",
        name: "Alibaba Cloud (China)",
        base_url: "https://dashscope.aliyuncs.com/apps/anthropic",
        api: WireApi::AnthropicMessages,
        key_url: "https://bailian.console.aliyun.com/cn-beijing?tab=model",
    },
    KnownProvider {
        id: "alibaba-intl",
        name: "Alibaba Cloud (Global)",
        base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        api: WireApi::OpenAiCompletions,
        key_url: "https://modelstudio.console.aliyun.com/ap-southeast-1?tab=dashboard",
    },
    KnownProvider {
        id: "xiaomi-mimo",
        name: "Xiaomi MiMo",
        base_url: "https://api.xiaomimimo.com/anthropic",
        api: WireApi::AnthropicMessages,
        key_url: "https://platform.xiaomimimo.com/",
    },
    KnownProvider {
        id: "openai",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        api: WireApi::OpenAiResponses,
        key_url: "https://platform.openai.com/api-keys",
    },
    KnownProvider {
        id: "anthropic",
        name: "Anthropic",
        base_url: "https://api.anthropic.com/v1",
        api: WireApi::AnthropicMessages,
        key_url: "https://console.anthropic.com/settings/keys",
    },
    KnownProvider {
        id: "xai",
        name: "xAI",
        base_url: "https://api.x.ai/v1",
        api: WireApi::OpenAiResponses,
        key_url: "https://console.x.ai",
    },
    KnownProvider {
        id: "openrouter",
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api",
        api: WireApi::AnthropicMessages,
        key_url: "https://openrouter.ai/keys",
    },
    KnownProvider {
        id: "opencode-go-chat",
        name: "OpenCode Go (Chat)",
        base_url: "https://opencode.ai/zen/go/v1",
        api: WireApi::OpenAiCompletions,
        key_url: "https://opencode.ai/auth",
    },
    KnownProvider {
        id: "opencode-go-anthropic",
        name: "OpenCode Go (Anthropic)",
        base_url: "https://opencode.ai/zen/go/v1",
        api: WireApi::AnthropicMessages,
        key_url: "https://opencode.ai/auth",
    },
    KnownProvider {
        id: "opencode-go-responses",
        name: "OpenCode Go (Responses)",
        base_url: "https://opencode.ai/zen/go/v1",
        api: WireApi::OpenAiResponses,
        key_url: "https://opencode.ai/auth",
    },
    KnownProvider {
        id: "opencode-zen-chat",
        name: "OpenCode Zen (Chat)",
        base_url: "https://opencode.ai/zen/v1",
        api: WireApi::OpenAiCompletions,
        key_url: "https://opencode.ai/auth",
    },
    KnownProvider {
        id: "opencode-zen-anthropic",
        name: "OpenCode Zen (Anthropic)",
        base_url: "https://opencode.ai/zen/v1",
        api: WireApi::AnthropicMessages,
        key_url: "https://opencode.ai/auth",
    },
    KnownProvider {
        id: "opencode-zen-responses",
        name: "OpenCode Zen (Responses)",
        base_url: "https://opencode.ai/zen/v1",
        api: WireApi::OpenAiResponses,
        key_url: "https://opencode.ai/auth",
    },
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::policy::{AccessPolicy, AccessRule, RuleDecision, RuleDirection};

    #[test]
    fn default_settings_are_dark_with_empty_layout() {
        let settings = Settings::default();
        assert_eq!(settings.theme, "dark");
        assert!(settings.pane_layout.is_object());
        assert_eq!(settings.default_thinking_level, None);
        assert!(settings.enabled_tools.is_empty());
        assert!(!settings.default_trust_new_spaces);
        assert_eq!(settings.default_model, None);
        assert!(settings.providers.is_empty());
        assert_eq!(settings.font, FontSettings::default());
        assert!(settings.subagent_models.is_empty());
        assert!(!settings.mcp_mentions_enabled);
        // Session naming ships ON (pi's posture) — the ONE bool whose default
        // is not `false`.
        assert!(settings.session_naming_enabled);
        assert_eq!(settings.session_naming_model, None);
        assert_eq!(settings.session_naming_reasoning, None);
        // (Task 4) The rule list is the same story: a file written BEFORE the
        // `rules` key existed parses with an EMPTY list (`#[serde(default)]`),
        // and an empty list is never written back (`skip_serializing_if`), so
        // the three-direction wire shape stays byte-identical until the first
        // `allow-directory` append.
        assert!(
            settings.file_policy.rules.is_empty(),
            "an old file has NO user rules, got {:?}",
            settings.file_policy.rules
        );
        // And through the REAL file, not just the value.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{ "theme": "dark", "paneLayout": {} }"#,
        )
        .unwrap();
        assert!(load_settings(dir.path()).file_policy.rules.is_empty());
    }

    #[test]
    fn a_pre_feature_settings_json_parses_to_the_new_defaults() {
        // A file written before the extended fields existed must parse (all
        // new fields `#[serde(default)]`) rather than be treated as corrupt.
        let settings: Settings =
            serde_json::from_str(r#"{ "theme": "dark", "paneLayout": {} }"#).unwrap();
        assert_eq!(settings.default_thinking_level, None);
        assert!(settings.enabled_tools.is_empty());
        assert!(!settings.default_trust_new_spaces);
        assert_eq!(settings.default_model, None);
        assert!(settings.providers.is_empty());
        assert!(settings.mcp_servers.is_empty());
        assert_eq!(settings.font, FontSettings::default());
        assert!(settings.subagent_models.is_empty());
        assert_eq!(settings.spinner_style, None);
        assert_eq!(settings.palette, None);
        // (ADR 0031 follow-up) `#` ships OFF: a file written before the
        // setting existed must NOT silently enable the one trigger that
        // collides with pasted text.
        assert!(!settings.mcp_mentions_enabled);
        // Session naming is the opposite case: it ships ON, so the same
        // pre-feature file reads as ENABLED with no model/reasoning override
        // (`default = "default_true"` — see
        // `session_naming_settings_default_on_and_round_trip_in_camel_case`).
        assert!(settings.session_naming_enabled);
        assert_eq!(settings.session_naming_model, None);
        assert_eq!(settings.session_naming_reasoning, None);
    }

    #[test]
    fn mcp_mentions_enabled_defaults_off_and_round_trips() {
        // (ADR 0031 follow-up) The `#` MCP-server mention is OPT-IN: the
        // default is `false` (`#[serde(default)]`), so a pre-feature
        // `settings.json` — and a fresh first-run file — ship `#` OFF while
        // `$` and `@` stay always-on. An explicit `true` survives the
        // write/read cycle under the camelCase wire key.
        assert!(!Settings::default().mcp_mentions_enabled);
        let file: Settings = serde_json::from_str(r#"{ "theme": "dark" }"#).unwrap();
        assert!(!file.mcp_mentions_enabled);
        // The explicit ON value round-trips through the JSON shape.
        let on: Settings = serde_json::from_str(r#"{ "mcpMentionsEnabled": true }"#).unwrap();
        assert!(on.mcp_mentions_enabled);
        let settings = Settings {
            mcp_mentions_enabled: true,
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(
            json.contains("\"mcpMentionsEnabled\":true"),
            "camelCase key: {json}"
        );
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, settings);
        // And through the real file (write_settings → load_settings).
        let dir = tempfile::tempdir().unwrap();
        write_settings(dir.path(), &settings).unwrap();
        let raw = fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(
            raw.contains("\"mcpMentionsEnabled\""),
            "camelCase key on disk: {raw}"
        );
        let back = load_settings(dir.path());
        assert!(back.mcp_mentions_enabled);
        assert_eq!(back, settings);
        // A first-run file (no file at all) writes the defaults: `#` OFF.
        let fresh = tempfile::tempdir().unwrap();
        assert!(!load_settings(fresh.path()).mcp_mentions_enabled);
    }

    #[test]
    fn session_naming_settings_default_on_and_round_trip_in_camel_case() {
        // Session naming (the port of pi-archimedes' `session-name`): the
        // master switch defaults to `true`, NOT `false` like every other
        // settings bool, because pi ships naming ON — so a pre-feature file
        // and a fresh first-run file both read as enabled (no migration, and
        // no silent feature loss for existing users). The two overrides are
        // `None`: the title request uses the session's own model with no
        // `reasoning_effort`.
        assert!(Settings::default().session_naming_enabled);
        assert_eq!(Settings::default().session_naming_model, None);
        assert_eq!(Settings::default().session_naming_reasoning, None);
        // A pre-feature file (no naming keys at all) parses to exactly that.
        let pre_feature: Settings =
            serde_json::from_str(r#"{ "theme": "dark", "paneLayout": {} }"#).unwrap();
        assert!(pre_feature.session_naming_enabled);
        assert_eq!(pre_feature.session_naming_model, None);
        assert_eq!(pre_feature.session_naming_reasoning, None);
        // An explicit OFF plus both overrides parse from the camelCase wire
        // names (the `ModelPicker` writes the composed key; the `:<level>`
        // suffix is the hand-edited form).
        let overridden: Settings = serde_json::from_str(
            r#"{ "sessionNamingEnabled": false, "sessionNamingModel": "tama/m-1:xhigh", "sessionNamingReasoning": "minimal" }"#,
        )
        .unwrap();
        assert!(!overridden.session_naming_enabled);
        assert_eq!(
            overridden.session_naming_model.as_deref(),
            Some("tama/m-1:xhigh")
        );
        assert_eq!(
            overridden.session_naming_reasoning.as_deref(),
            Some("minimal")
        );
        // All three round-trip through the real file in camelCase
        // (`write_settings` → `load_settings`).
        let settings = Settings {
            session_naming_enabled: false,
            session_naming_model: Some("tama/m-1".to_string()),
            session_naming_reasoning: Some("low".to_string()),
            ..Settings::default()
        };
        let json = serde_json::to_string_pretty(&settings).unwrap();
        for key in [
            "\"sessionNamingEnabled\"",
            "\"sessionNamingModel\"",
            "\"sessionNamingReasoning\"",
        ] {
            assert!(json.contains(key), "missing {key} in {json}");
        }
        let dir = tempfile::tempdir().unwrap();
        write_settings(dir.path(), &settings).unwrap();
        let back = load_settings(dir.path());
        assert_eq!(back, settings);
        // A first-run file (no file at all) writes the defaults: naming ON.
        let fresh = tempfile::tempdir().unwrap();
        assert!(load_settings(fresh.path()).session_naming_enabled);
    }

    #[test]
    fn attention_alert_defaults_survive_a_pre_feature_file() {
        // Attention alerts (ADR 0038/0039): the master switch ships ON and the
        // delay defaults to 15 s, so a `settings.json` written before this
        // feature existed reads as "alerts on, 15 s" with no migration (the
        // `session_naming_enabled` pattern for the bool — `#[serde(default =
        // "default_true")]`, NOT the `#[serde(default)]`-false one).
        let pre_feature: Settings = serde_json::from_str("{}").unwrap();
        assert!(pre_feature.attention_alerts_enabled);
        assert_eq!(pre_feature.attention_alert_delay_secs, 15);
        assert!(Settings::default().attention_alerts_enabled);
        assert_eq!(Settings::default().attention_alert_delay_secs, 15);
        // A first-run file (no file at all) is WRITTEN with both keys present.
        let fresh = tempfile::tempdir().unwrap();
        let defaults = load_settings(fresh.path());
        assert!(defaults.attention_alerts_enabled);
        assert_eq!(defaults.attention_alert_delay_secs, 15);
        let written = fs::read_to_string(fresh.path().join("settings.json")).unwrap();
        for key in ["\"attentionAlertsEnabled\"", "\"attentionAlertDelaySecs\""] {
            assert!(written.contains(key), "missing {key} in {written}");
        }
        // Both explicit values round-trip through the real file in camelCase
        // (`write_settings` → `load_settings`): an OFF switch and a non-default
        // delay must survive verbatim, with no clamping or normalizing.
        let settings = Settings {
            attention_alerts_enabled: false,
            attention_alert_delay_secs: 60,
            ..Settings::default()
        };
        let dir = tempfile::tempdir().unwrap();
        write_settings(dir.path(), &settings).unwrap();
        let raw = fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(raw.contains("\"attentionAlertDelaySecs\": 60"), "got {raw}");
        let back = load_settings(dir.path());
        assert!(!back.attention_alerts_enabled);
        assert_eq!(back.attention_alert_delay_secs, 60);
        assert_eq!(back, settings);
        // A hand-edited value outside the Settings select's four options is
        // read VERBATIM — there is no clamping layer here by design (the only
        // bound is the sanity ceiling in `commands::attention`).
        let hand_edited: Settings = serde_json::from_str(
            r#"{ "attentionAlertsEnabled": true, "attentionAlertDelaySecs": 90 }"#,
        )
        .unwrap();
        assert_eq!(hand_edited.attention_alert_delay_secs, 90);
    }

    #[test]
    fn subagent_dead_bound_secs_defaults_to_1800() {
        // The ADR 0055 **Dead bound** (the subagent silence bound): a
        // `settings.json` written before this key existed reads as 1800 s with
        // no migration (the `attention_alert_delay_secs` pattern — a
        // non-`false` default needs a named `default_*` fn, `#[serde(default)]`
        // alone would mean `0`).
        let pre_feature: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(pre_feature.subagent_dead_bound_secs, 1800);
        assert_eq!(Settings::default().subagent_dead_bound_secs, 1800);
        // A first-run file (no file at all) is WRITTEN with the key present, so
        // the user can hand-edit it without guessing the name.
        let fresh = tempfile::tempdir().unwrap();
        assert_eq!(load_settings(fresh.path()).subagent_dead_bound_secs, 1800);
        let written = fs::read_to_string(fresh.path().join("settings.json")).unwrap();
        assert!(
            written.contains("\"subagentDeadBoundSecs\""),
            "missing subagentDeadBoundSecs in {written}"
        );
        // An explicit value round-trips through the real file in camelCase
        // (`write_settings` → `load_settings`), verbatim — there is no clamping
        // layer, deliberately (the bound is `settings.json`-only: NO Settings-UI
        // control, the `session_naming_reasoning` precedent).
        let settings = Settings {
            subagent_dead_bound_secs: 45,
            ..Settings::default()
        };
        let dir = tempfile::tempdir().unwrap();
        write_settings(dir.path(), &settings).unwrap();
        let raw = fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(raw.contains("\"subagentDeadBoundSecs\": 45"), "got {raw}");
        let back = load_settings(dir.path());
        assert_eq!(back.subagent_dead_bound_secs, 45);
        assert_eq!(back, settings);
        // A hand-edited value is read VERBATIM (the same no-clamping rule).
        let hand_edited: Settings =
            serde_json::from_str(r#"{ "subagentDeadBoundSecs": 90 }"#).unwrap();
        assert_eq!(hand_edited.subagent_dead_bound_secs, 90);
    }

    #[test]
    fn spinner_style_defaults_to_none_and_round_trips() {
        // A pre-feature file (no `spinnerStyle`) parses to `None` (the
        // frontend falls back to the `typing` default); an explicit choice
        // survives a round trip in camelCase.
        assert_eq!(Settings::default().spinner_style, None);
        let settings = Settings {
            spinner_style: Some("pendulum".to_string()),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(
            json.contains("\"spinnerStyle\""),
            "missing spinnerStyle in {json}"
        );
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.spinner_style, Some("pendulum".to_string()));
    }

    #[test]
    fn empty_state_animation_defaults_to_none_and_round_trips() {
        // A pre-feature file (no `emptyStateAnimation`) parses to `None` (the
        // frontend falls back to `"animated"`); an explicit choice survives a
        // round trip in camelCase.
        assert_eq!(Settings::default().empty_state_animation, None);
        let settings = Settings {
            empty_state_animation: Some("static".to_string()),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(
            json.contains("\"emptyStateAnimation\""),
            "missing emptyStateAnimation in {json}"
        );
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.empty_state_animation, Some("static".to_string()));
        // Absent-key input reads as the default, not as an error.
        let file: Settings = serde_json::from_str(r#"{ "theme": "dark" }"#).unwrap();
        assert_eq!(file.empty_state_animation, None);
    }

    #[test]
    fn palette_defaults_to_none_and_round_trips() {
        // (ADR 0027) A pre-feature file (no `palette`) parses to `None` (the
        // frontend falls back to the `zai` scheme); an explicit choice
        // survives a round trip in camelCase.
        assert_eq!(Settings::default().palette, None);
        let file: Settings = serde_json::from_str(r#"{ "theme": "dark" }"#).unwrap();
        assert_eq!(file.palette, None);
        let settings = Settings {
            palette: Some("dracula".to_string()),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"palette\""), "missing palette in {json}");
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.palette, Some("dracula".to_string()));
    }

    #[test]
    fn file_policy_defaults_to_allow_in_every_direction() {
        // (ADR 0030) All three policies default to `Allow` (pi's posture — the
        // UI's "Don't ask me"). This is WIDER than the pre-feature hardcoded
        // behavior (the product decision — ADR 0030 Deviation 2), so what is pinned
        // here is the widening itself — never parity with the old behavior.
        let all_allow = FilePolicy {
            reads: AccessPolicy::Allow,
            writes: AccessPolicy::Allow,
            shell: AccessPolicy::Allow,
            rules: Vec::new(),
        };
        assert_eq!(FilePolicy::default(), all_allow);
        assert_eq!(Settings::default().file_policy, all_allow);
        // A pre-feature file (no `filePolicy` key at all) parses to the same
        // (`#[serde(default)]` — no migration).
        let pre_feature: Settings = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(pre_feature.file_policy, all_allow);
        // An EMPTY `filePolicy` object parses to the same too (the
        // container-level `#[serde(default)]` fills the three fields).
        let empty_object: Settings =
            serde_json::from_value(serde_json::json!({ "filePolicy": {} })).unwrap();
        assert_eq!(empty_object.file_policy, all_allow);
        // A PARTIAL object leaves the directions the file omits at `Allow`.
        let partial: Settings =
            serde_json::from_value(serde_json::json!({ "filePolicy": { "reads": "ask" } }))
                .unwrap();
        assert_eq!(partial.file_policy.reads, AccessPolicy::Ask);
        assert_eq!(partial.file_policy.writes, AccessPolicy::Allow);
        assert_eq!(partial.file_policy.shell, AccessPolicy::Allow);
    }

    #[test]
    fn file_policy_serializes_under_the_camel_case_file_policy_key() {
        // The settings' wire key is `filePolicy` (Settings is camelCase); the
        // direction values are the lowercase `AccessPolicy` wire names (pinned
        // in `agent::policy`'s own tests).
        let settings = Settings {
            file_policy: FilePolicy {
                reads: AccessPolicy::Sandboxed,
                writes: AccessPolicy::Ask,
                shell: AccessPolicy::Allow,
                rules: Vec::new(),
            },
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(
            json.contains(r#""filePolicy":{"reads":"sandboxed","writes":"ask","shell":"allow"}"#),
            "got {json}"
        );
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, settings);
    }

    #[test]
    fn mcp_servers_round_trips_in_camel_case() {
        // (ADR 0019) The `mcpServers` field round-trips the pi entry shape
        // VERBATIM (a `Value` — the shape is pi's, not a desktop struct).
        let file = r#"{ "theme": "dark", "mcpServers": { "tama": { "url": "https://tama/mcp", "headers": { "Authorization": "Bearer k" } }, "local": { "command": "npx", "args": ["-y", "x-mcp"] } } }"#;
        let settings: Settings = serde_json::from_str(file).unwrap();
        assert_eq!(settings.mcp_servers.len(), 2);
        assert_eq!(
            settings.mcp_servers["tama"],
            serde_json::json!({ "url": "https://tama/mcp", "headers": { "Authorization": "Bearer k" } })
        );
        assert_eq!(
            settings.mcp_servers["local"],
            serde_json::json!({ "command": "npx", "args": ["-y", "x-mcp"] })
        );
        // camelCase on the wire (a populated map serializes the field).
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"mcpServers\""), "camelCase key: {json}");
        assert!(
            json.contains("https://tama/mcp"),
            "the entry round-trips: {json}"
        );
    }

    #[test]
    fn default_thinking_levels_defaults_to_empty_and_round_trips() {
        // (ADR 0015) The per-model remembered thinking-level map defaults to
        // empty and round-trips in camelCase.
        assert!(Settings::default().default_thinking_levels.is_empty());
        // A pre-feature file (WITHOUT the field) parses to an empty map
        // (`#[serde(default)]` — no migration needed).
        let settings: Settings = serde_json::from_str(r#"{ "theme": "dark" }"#).unwrap();
        assert!(settings.default_thinking_levels.is_empty());
        // A file WITH the field parses to the entry.
        let with_map: Settings =
            serde_json::from_str(r#"{ "defaultThinkingLevels": { "a/b": "xhigh" } }"#).unwrap();
        assert_eq!(with_map.default_thinking_levels["a/b"], "xhigh");
        // camelCase on the wire (a populated map serializes the field).
        let settings = Settings {
            default_thinking_levels: std::collections::HashMap::from([(
                "a/b".to_string(),
                "xhigh".to_string(),
            )]),
            ..Settings::default()
        };
        let json = serde_json::to_string_pretty(&settings).unwrap();
        assert!(
            json.contains("\"defaultThinkingLevels\""),
            "missing key in {json}"
        );
    }

    #[test]
    fn subagent_models_is_read_from_camel_case_but_never_written() {
        // The ADR 0023 camelCase test, REWRITTEN to the ADR 0066 shape (kept,
        // not deleted — the read side is still a live contract: it is what
        // makes the upgrade fold possible). `skip_serializing` splits the two
        // halves of "round-trips": the legacy key is still READ (camelCase),
        // and never WRITTEN again. The camelCase round-trip for the map that
        // does survive now lives in
        // `agent_overrides_round_trip_as_a_flat_camel_case_map`, and the
        // "never written again" half in
        // `the_legacy_subagent_models_key_never_reaches_the_file_again`.
        // A pre-feature file (WITHOUT the field) parses (no migration).
        let settings: Settings = serde_json::from_str(r#"{ "theme": "dark" }"#).unwrap();
        assert!(settings.subagent_models.is_empty());
        // A file WITH the legacy field still PARSES to the entry — read-once.
        let with_map: Settings =
            serde_json::from_str(r#"{ "subagentModels": { "scout": "tama/m-1" } }"#).unwrap();
        assert_eq!(with_map.subagent_models["scout"], "tama/m-1");
        // …and the camelCase spelling of the map that ships is the new one.
        let settings = Settings {
            agent_overrides: std::collections::HashMap::from([(
                "scout".to_string(),
                AgentOverrideFields {
                    model: Some("tama/m-1".to_string()),
                    thinking: None,
                    tools: None,
                },
            )]),
            ..Settings::default()
        };
        let json = serde_json::to_string_pretty(&settings).unwrap();
        assert!(json.contains("\"agentOverrides\""), "missing key in {json}");
        assert!(
            !json.contains("\"subagentModels\""),
            "the retired key must not reappear: {json}"
        );
    }

    // ── (ADR 0066/0067) `agentOverrides`: the flat global Agent-override map ──
    //
    // These tests read and write the DOCUMENT (a `serde_json::Value` over the
    // file `load_settings` / `write_settings` own), not only the Rust struct —
    // the renderer's `AppSettings` is typed against the document, so the
    // guarantee that matters ("the key is always there", "an unset field is
    // ABSENT") is a fact about the bytes, and that is what is pinned here.

    #[test]
    fn agent_overrides_default_to_an_empty_map_that_still_serializes() {
        // (ADR 0066) The map is plain `#[serde(default)]` and NOT
        // `skip_serializing_if = "HashMap::is_empty"` — the same contract every
        // other map field in this file keeps (`mcpServers`,
        // `defaultThinkingLevels`): an EMPTY map serializes as `{}`, so the
        // TypeScript `AppSettings` can declare the field REQUIRED and index it
        // unconditionally. An omitted key here hands the renderer `undefined`
        // for a field its type calls required. Asserted on the DOCUMENT rather
        // than the struct, because the renderer reads the document.
        let value = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(
            value.get("agentOverrides"),
            Some(&serde_json::json!({})),
            "an empty override map must serialize as `{{}}`, not vanish"
        );
        // A pre-feature file (WITHOUT the key) parses to an empty map — i.e.
        // the document still carries `{}`, so a save of a pre-feature file
        // leaves the required key present.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("settings.json"), r#"{ "theme": "dark" }"#).unwrap();
        write_settings(dir.path(), &load_settings(dir.path())).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(
            raw.get("agentOverrides"),
            Some(&serde_json::json!({})),
            "a pre-feature file gains the required key (empty map) on the next save"
        );
    }

    #[test]
    fn agent_overrides_round_trip_as_a_flat_camel_case_map() {
        // (ADR 0066) FLAT: `agentOverrides → name → fields`. The rejected
        // nested `{ global, spaces }` shape is what this assertion rules out —
        // the per-Space door re-opens it additively (ADR 0066 *Deferred*), and
        // nothing before then may ship a level the reader must step through.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{ "theme": "dark", "agentOverrides": { "scout": { "model": "tama/m-1", "thinking": "low", "tools": ["read"] } } }"#,
        )
        .unwrap();
        let settings = load_settings(dir.path());
        write_settings(dir.path(), &settings).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(raw["agentOverrides"]["scout"]["model"], "tama/m-1");
        assert_eq!(raw["agentOverrides"]["scout"]["thinking"], "low");
        assert_eq!(raw["agentOverrides"]["scout"]["tools"][0], "read");
        let map = raw["agentOverrides"].as_object().unwrap();
        assert_eq!(
            map.keys().collect::<Vec<_>>(),
            vec!["scout"],
            "the map's keys are agent NAMES — no `global` / `spaces` level"
        );
    }

    #[test]
    fn an_unset_field_inside_an_override_entry_is_absent_not_null() {
        // (ADR 0067) Field ABSENCE is the ONLY meaning of "this override does
        // not speak", so an unset field must never reach the document as
        // `null` — a `"model": null` is a third state the resolver would have
        // to reconcile. `skip_serializing_if = "Option::is_none"` on the three
        // fields inside an entry is what enforces this (and it is the ONLY
        // place in this struct where `skip_serializing*` is correct).
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{ "theme": "dark", "agentOverrides": { "scout": { "model": "tama/m-1" } } }"#,
        )
        .unwrap();
        let settings = load_settings(dir.path());
        write_settings(dir.path(), &settings).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("settings.json")).unwrap())
                .unwrap();
        let entry = raw["agentOverrides"]["scout"].as_object().unwrap();
        assert_eq!(entry.get("model"), Some(&serde_json::json!("tama/m-1")));
        assert!(
            !entry.contains_key("thinking") && !entry.contains_key("tools"),
            "an unset field is ABSENT, never `null`: {entry:?}"
        );
    }

    #[test]
    fn a_legacy_subagent_models_file_folds_into_agent_overrides_on_load() {
        // (ADR 0066) An upgrading user keeps every model they pinned: the
        // legacy `subagentModels` value joins the new map as a model-only
        // entry. The fold lives in `load_settings` — NOT in the `get_settings`
        // command — because the Worker reads this file directly
        // (`launch.rs`), and two processes must not see one file differently.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{ "theme": "dark", "subagentModels": { "scout": "tama/m-1" } }"#,
        )
        .unwrap();
        let settings = load_settings(dir.path());
        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(
            value["agentOverrides"]["scout"]["model"], "tama/m-1",
            "the legacy value folds into the new map"
        );
        // A model-only entry: no thinking, no tools (the legacy map could
        // only ever carry a model).
        let entry = value["agentOverrides"]["scout"].as_object().unwrap();
        assert!(!entry.contains_key("thinking") && !entry.contains_key("tools"));
    }

    #[test]
    fn a_non_empty_agent_overrides_map_wins_over_the_legacy_key_wholesale() {
        // The fold is guarded by "the new map is EMPTY", not merged. A file
        // carrying BOTH keys is a hand-edit, and the new key wins wholesale:
        // merging per-agent would let the legacy key resurrect a value the
        // user already cleared in the modal.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{ "subagentModels": { "scout": "legacy/m", "ghost": "legacy/g" }, "agentOverrides": { "scout": { "model": "new/m", "tools": ["read"] } } }"#,
        )
        .unwrap();
        let value = serde_json::to_value(load_settings(dir.path())).unwrap();
        assert_eq!(value["agentOverrides"]["scout"]["model"], "new/m");
        assert_eq!(value["agentOverrides"]["scout"]["tools"][0], "read");
        assert!(
            value["agentOverrides"].get("ghost").is_none(),
            "the legacy key contributes NOTHING when the new map is non-empty: {value:?}",
        );
    }

    #[test]
    fn the_legacy_subagent_models_key_never_reaches_the_file_again() {
        // (ADR 0066) Retirement is unconditional: `skip_serializing` (not
        // `skip_serializing_if = "HashMap::is_empty"`) — the unconditional
        // form also survives a writer that builds a `Settings` literal by
        // hand, which is the one path where a retired key could leak back
        // onto the wire.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{ "subagentModels": { "scout": "tama/m-1" } }"#,
        )
        .unwrap();
        let settings = load_settings(dir.path());
        // The fold CLEARS the legacy map, so even a `skip_serializing_if`
        // would not save it here — but the read must leave it empty:
        assert!(
            settings.subagent_models.is_empty(),
            "load_settings clears the legacy map"
        );
        write_settings(dir.path(), &settings).unwrap();
        let raw = fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(
            !raw.contains("\"subagentModels\""),
            "the retired key must never be written again: {raw}"
        );
        assert!(raw.contains("\"agentOverrides\""), "missing key in {raw}");
        // And the hand-built-literal path (the one `load_settings` never
        // runs) cannot emit it either — the unconditional `skip_serializing`:
        let hand_built = Settings {
            subagent_models: std::collections::HashMap::from([(
                "scout".to_string(),
                "tama/m-1".to_string(),
            )]),
            ..Settings::default()
        };
        let json = serde_json::to_string(&hand_built).unwrap();
        assert!(
            !json.contains("\"subagentModels\""),
            "a hand-built `Settings` cannot re-emit the retired key: {json}"
        );
    }

    #[test]
    fn font_settings_default_is_size_14_not_zero() {
        // Guards against a regression to a `#[derive(Default)]` (which would
        // give `size_px: 0`, a second "default" diverging from the serde
        // missing-field default of 14).
        assert_eq!(FontSettings::default().size_px, 14);
    }

    #[test]
    fn font_settings_default_is_noto_sans_ui_and_fira_code_code() {
        // The app default (a fresh settings file): Noto Sans for the UI and
        // Fira Code for code — both the `index.html` Google Fonts families
        // (the quoted CSS family names the frontend's `applySettingsFont`
        // splices into the `--font-sans` / `--font-mono` stacks).
        let font = FontSettings::default();
        assert_eq!(font.ui_family, Some("\"Noto Sans\"".to_string()));
        assert_eq!(font.code_family, Some("\"Fira Code\"".to_string()));
    }

    #[test]
    fn provider_config_api_defaults_to_openai_completions() {
        // (ADR 0024) A pre-feature `settings.json` (NO `api` field) parses
        // to `api == "openai-completions"` (the serde default — no
        // migration) + `key_url == None`.
        let config: ProviderConfig =
            serde_json::from_str(r#"{"id":"p","name":"P","baseUrl":"https://x/v1","apiKey":"k"}"#)
                .unwrap();
        assert_eq!(config.api, "openai-completions");
        assert_eq!(config.key_url, None);
    }

    #[test]
    fn provider_config_auth_mode_defaults_to_api_key() {
        // (issue #125) A pre-feature `settings.json` (NO `authMode` field)
        // parses to `auth_mode == "api_key"` (the serde default — no
        // migration), so every provider that exists before the OAuth work
        // keeps its static-key behaviour untouched.
        let config: ProviderConfig =
            serde_json::from_str(r#"{"id":"p","name":"P","baseUrl":"https://x/v1","apiKey":"k"}"#)
                .unwrap();
        assert_eq!(config.auth_mode, "api_key");
    }

    #[test]
    fn provider_config_auth_mode_round_trips() {
        // (issue #125) A populated `authMode` round-trips camelCase (the
        // permissive-string boundary — `api`'s style: validate at use, not at
        // parse, so an unknown mode parses rather than rejecting the file).
        let config = ProviderConfig {
            id: "gw".to_string(),
            name: "Gateway".to_string(),
            base_url: "https://gw.example/v1".to_string(),
            api_key: String::new(),
            api: "litellm".to_string(),
            key_url: None,
            auth_mode: "oauth".to_string(),
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("\"authMode\":\"oauth\""), "got {json}");
        let back: ProviderConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, config);
    }

    #[test]
    fn provider_config_api_and_key_url_round_trip() {
        // (ADR 0024) A populated `api` + `keyUrl` round-trips camelCase.
        let config = ProviderConfig {
            id: "anthropic".to_string(),
            name: "Anthropic".to_string(),
            base_url: "https://api.anthropic.com/v1".to_string(),
            api_key: "k".to_string(),
            api: "anthropic-messages".to_string(),
            key_url: Some("https://keys.example".to_string()),
            auth_mode: "api_key".to_string(),
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(
            json.contains("\"api\":\"anthropic-messages\""),
            "got {json}"
        );
        assert!(
            json.contains("\"keyUrl\":\"https://keys.example\""),
            "got {json}"
        );
        let back: ProviderConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, config);
    }

    #[test]
    fn settings_round_trip_with_the_new_fields() {
        let settings = Settings {
            theme: "system".to_string(),
            palette: Some("dracula".to_string()),
            pane_layout: serde_json::json!({ "chatWidth": 480 }),
            default_thinking_level: Some("high".to_string()),
            enabled_tools: vec!["read".to_string()],
            default_trust_new_spaces: true,
            default_model: Some("anthropic/claude-opus-4".to_string()),
            providers: vec![ProviderConfig {
                id: "my-gateway".to_string(),
                name: "My Gateway".to_string(),
                base_url: "http://localhost:8080/v1".to_string(),
                api_key: String::new(),
                api: "openai-completions".into(),
                key_url: None,
                auth_mode: "api_key".into(),
            }],
            font: FontSettings {
                size_px: 18,
                ui_family: Some("Inter".to_string()),
                code_family: Some("JetBrains Mono".to_string()),
            },
            mcp_servers: std::collections::HashMap::from([
                (
                    "tama".to_string(),
                    serde_json::json!({ "url": "https://tama/mcp" }),
                ),
                (
                    "local".to_string(),
                    serde_json::json!({ "command": "npx", "args": ["-y", "x-mcp"] }),
                ),
            ]),
            default_thinking_levels: std::collections::HashMap::from([(
                "a/b".to_string(),
                "xhigh".to_string(),
            )]),
            // (ADR 0066) The legacy `subagentModels` map stays in this
            // exhaustive literal (a struct-update base is not available here)
            // but must be EMPTY: a `skip_serializing` field cannot come back
            // from the document, so a POPULATED value would redden the
            // `assert_eq!(back, settings)` below for the correct reason — the
            // key is never written again. The legacy READ path is pinned
            // through `load_settings` on a JSON string instead, see
            // `a_legacy_subagent_models_file_folds_into_agent_overrides_on_load`,
            // and the never-written guarantee is asserted directly just under
            // the key list. The populated-map round-trip this literal used to
            // cover now belongs to the map that ships:
            subagent_models: HashMap::new(),
            agent_overrides: std::collections::HashMap::from([(
                "scout".to_string(),
                AgentOverrideFields {
                    model: Some("tama/m-1".to_string()),
                    thinking: Some("low".to_string()),
                    tools: Some(vec!["read".to_string()]),
                },
            )]),
            spinner_style: Some("marquee".to_string()),
            empty_state_animation: Some("static".to_string()),
            session_naming_enabled: false,
            session_naming_model: Some("tama/m-1:xhigh".to_string()),
            session_naming_reasoning: Some("minimal".to_string()),
            attention_alerts_enabled: false,
            attention_alert_delay_secs: 60,
            subagent_dead_bound_secs: 300,
            mcp_mentions_enabled: true,
            file_policy: FilePolicy {
                reads: AccessPolicy::Sandboxed,
                writes: AccessPolicy::Ask,
                shell: AccessPolicy::Allow,
                rules: Vec::new(),
            },
            web: WebSettings {
                brave_api_key: "b".to_string(),
                tavily_api_key: "t".to_string(),
                perplexity_api_key: "p".to_string(),
                searxng_url: "s".to_string(),
                default_provider: "brave".to_string(),
                proxy: "px".to_string(),
            },
        };
        let json = serde_json::to_string(&settings).unwrap();
        for key in [
            "\"defaultThinkingLevel\"",
            "\"palette\"",
            "\"enabledTools\"",
            "\"defaultTrustNewSpaces\"",
            "\"defaultModel\"",
            "\"providers\"",
            "\"mcpServers\"",
            "\"font\"",
            "\"sizePx\"",
            "\"defaultThinkingLevels\"",
            "\"agentOverrides\"",
            "\"spinnerStyle\"",
            // Kept beside its sibling on purpose: this list pins the serialized
            // DOCUMENT shape (the key set a settings.json carries), while
            // `empty_state_animation_defaults_to_none_and_round_trips` pins the
            // field's defaulting and value round-trip. Different claims — a
            // field that still parses but stops being serialized is caught ONLY
            // here, so it has to be enumerated here too.
            "\"emptyStateAnimation\"",
            "\"filePolicy\"",
            "\"web\"",
            "\"mcpMentionsEnabled\"",
            "\"sessionNamingEnabled\"",
            "\"sessionNamingModel\"",
            "\"sessionNamingReasoning\"",
            "\"attentionAlertsEnabled\"",
            "\"attentionAlertDelaySecs\"",
            "\"subagentDeadBoundSecs\"",
        ] {
            assert!(json.contains(key), "missing {key} in {json}");
        }
        // (ADR 0066) Stated positively, not inherited from
        // `the_legacy_subagent_models_key_never_reaches_the_file_again`: a
        // populated `Settings` must not carry the retired key.
        assert!(
            !json.contains("\"subagentModels\""),
            "the retired legacy key must never be serialized: {json}"
        );
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, settings);
    }

    #[test]
    fn file_policy_round_trips_through_the_settings_file() {
        // A non-default policy survives `write_settings` → `load_settings`
        // (the file exists here, so the missing-file defaults-write path is
        // not what is under test).
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings {
            file_policy: FilePolicy {
                reads: AccessPolicy::Sandboxed,
                writes: AccessPolicy::Ask,
                shell: AccessPolicy::Allow,
                rules: Vec::new(),
            },
            ..Settings::default()
        };
        write_settings(dir.path(), &settings).unwrap();
        let raw = fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(raw.contains("\"filePolicy\""), "camelCase key: {raw}");
        let back = load_settings(dir.path());
        assert_eq!(back.file_policy, settings.file_policy);
        assert_eq!(back, settings);
    }

    #[test]
    fn load_settings_normalizes_a_blank_default_thinking_level_to_none() {
        // A hand-edited file may carry `"defaultThinkingLevel": ""` (the
        // frontend never SAVES `""`, but the `Option<String>` accepts it):
        // a blank level is "no level" — the same as a missing field (`null`).
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{ "theme": "dark", "defaultThinkingLevel": "" }"#,
        )
        .unwrap();
        let settings = load_settings(dir.path());
        assert_eq!(settings.default_thinking_level, None);
        // The other fields still parse (the file is not corrupt).
        assert_eq!(settings.theme, "dark");
    }

    #[test]
    fn load_settings_normalizes_a_blank_session_naming_model_to_none() {
        // Same rule as the thinking level above — the file is hand-editable
        // and a blank override means "no override" (the session's own model)
        // — but deliberately WIDER: an ALL-WHITESPACE value is blank too,
        // because a hand-typed key carrying a stray space would otherwise be
        // looked up verbatim, miss the catalog, and silently name nothing.
        // The trim is ONLY the blankness test; a non-blank value is never
        // rewritten (the composed key's spelling belongs to the file, and
        // Task 4's resolver does its own trimming).
        for blank in ["", "   ", "\\t\\n"] {
            let dir = tempfile::tempdir().unwrap();
            fs::write(
                dir.path().join("settings.json"),
                format!(r#"{{ "theme": "dark", "sessionNamingModel": "{blank}" }}"#),
            )
            .unwrap();
            let settings = load_settings(dir.path());
            assert_eq!(settings.session_naming_model, None, "blank {blank:?}");
            // The other fields still parse (the file is not corrupt).
            assert_eq!(settings.theme, "dark");
        }
        // A non-blank value survives VERBATIM — no trim, no rewrite.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{ "sessionNamingModel": " tama/m-1 " }"#,
        )
        .unwrap();
        assert_eq!(
            load_settings(dir.path()).session_naming_model.as_deref(),
            Some(" tama/m-1 ")
        );
        // The reasoning override has NO such rule: a blank level is passed
        // through (Task 4 drops it against the model's advertised levels).
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{ "sessionNamingReasoning": "" }"#,
        )
        .unwrap();
        assert_eq!(
            load_settings(dir.path())
                .session_naming_reasoning
                .as_deref(),
            Some("")
        );
    }

    #[test]
    fn load_settings_on_a_corrupt_file_returns_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("settings.json"), "{ not json").unwrap();
        let settings = load_settings(dir.path());
        assert_eq!(settings, Settings::default());
        // The file is left untouched until the next `save_settings`.
        let raw = fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert_eq!(raw, "{ not json");
    }

    #[test]
    fn load_settings_on_a_missing_file_writes_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let settings = load_settings(dir.path());
        assert_eq!(settings, Settings::default());
        // First-run behavior: the defaults are written to disk.
        assert!(dir.path().join("settings.json").exists());
    }

    #[test]
    fn get_settings_never_errors() {
        // A corrupt file must never surface as an `Err` from the command
        // (it is covered end-to-end in `tests/ipc.rs`); the logic lives in
        // `load_settings`, which always returns the defaults in that case.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("settings.json"), "{ not json").unwrap();
        let settings = load_settings(dir.path());
        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn settings_round_trip_through_json() {
        let settings = Settings {
            theme: "light".to_string(),
            pane_layout: serde_json::json!({ "chatWidth": 480 }),
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"theme\":\"light\""));
        assert!(json.contains("\"paneLayout\""));
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.theme, "light");
        assert_eq!(back.pane_layout["chatWidth"], 480);
    }

    #[test]
    fn web_block_defaults_to_empty_when_absent() {
        assert_eq!(Settings::default().web, WebSettings::default());
        assert_eq!(WebSettings::default().brave_api_key, "");
        assert_eq!(WebSettings::default().tavily_api_key, "");
        assert_eq!(WebSettings::default().perplexity_api_key, "");
        assert_eq!(WebSettings::default().searxng_url, "");
        assert_eq!(WebSettings::default().default_provider, "");
        assert_eq!(WebSettings::default().proxy, "");

        // A pre-feature file (WITHOUT the web field) parses to WebSettings::default()
        let settings: Settings = serde_json::from_str(r#"{ "theme": "dark" }"#).unwrap();
        assert_eq!(settings.web, WebSettings::default());
    }

    #[test]
    fn web_block_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings {
            web: WebSettings {
                brave_api_key: "brave-key-123".to_string(),
                tavily_api_key: "tvly-xyz".to_string(),
                perplexity_api_key: "pplx-abc".to_string(),
                searxng_url: "https://searx.example.com".to_string(),
                default_provider: "brave".to_string(),
                proxy: "http://127.0.0.1:8080".to_string(),
            },
            ..Settings::default()
        };
        write_settings(dir.path(), &settings).unwrap();
        let raw = fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(raw.contains("\"web\""), "web key present: {raw}");
        for key in [
            "\"braveApiKey\"",
            "\"tavilyApiKey\"",
            "\"perplexityApiKey\"",
            "\"searxngUrl\"",
            "\"defaultProvider\"",
            "\"proxy\"",
        ] {
            assert!(raw.contains(key), "missing {key} in {raw}");
        }
        let back = load_settings(dir.path());
        assert_eq!(back.web, settings.web);
        assert_eq!(back, settings);
    }

    // ── Task 4: the atomic settings write + the relay's read-modify-write ──

    /// The atomic sibling writes EXACTLY the bytes `write_settings` writes —
    /// the temp-file + rename path must not change the wire format by one
    /// byte (the existing byte pins on `write_settings` stay the contract).
    #[test]
    fn write_settings_atomic_writes_the_same_bytes_as_write_settings() {
        let settings = Settings {
            theme: "light".to_string(),
            file_policy: FilePolicy {
                reads: AccessPolicy::Ask,
                writes: AccessPolicy::Sandboxed,
                shell: AccessPolicy::Allow,
                rules: vec![AccessRule {
                    path: "~/skills".to_string(),
                    direction: RuleDirection::ReadWrite,
                    decision: RuleDecision::Allow,
                }],
            },
            ..Settings::default()
        };
        let plain = tempfile::tempdir().unwrap();
        let atomic = tempfile::tempdir().unwrap();
        write_settings(plain.path(), &settings).unwrap();
        write_settings_atomic(atomic.path(), &settings).unwrap();
        let plain_bytes = fs::read(settings_path(plain.path())).unwrap();
        let atomic_bytes = fs::read(settings_path(atomic.path())).unwrap();
        assert_eq!(
            plain_bytes, atomic_bytes,
            "the atomic write must be byte-identical to `write_settings`"
        );
        // And it loads back as the same document (the rename landed on the
        // right path — not on a leftover temp name).
        assert_eq!(load_settings(atomic.path()), settings);
        assert!(settings_path(atomic.path()).exists());
    }

    /// The relay's settings-write shape: a FRESH load (a file mutated behind
    /// the helper's back is visible), the mutate applied in place, and the
    /// result persisted atomically — `write_settings_atomic`, not a stale
    /// document.
    #[test]
    fn load_mutate_write_reads_fresh_mutates_and_persists_atomically() {
        let dir = tempfile::tempdir().unwrap();
        // Seed a file carrying one user rule.
        let mut seeded = Settings::default();
        seeded.file_policy.rules.push(AccessRule {
            path: "/Users/u/older".to_string(),
            direction: RuleDirection::Write,
            decision: RuleDecision::Deny,
        });
        write_settings(dir.path(), &seeded).unwrap();

        // Mutate something ELSE behind the helper's back, through a document
        // the helper never saw: a fresh load inside the helper must carry it.
        let mut raced = load_settings(dir.path());
        raced.theme = "dracula-was-here".to_string();
        write_settings(dir.path(), &raced).unwrap();

        load_mutate_write(dir.path(), |s| {
            append_rule(
                &mut s.file_policy.rules,
                AccessRule {
                    path: "/Users/u/skills".to_string(),
                    direction: RuleDirection::ReadWrite,
                    decision: RuleDecision::Allow,
                },
            );
        })
        .unwrap();

        let after = load_settings(dir.path());
        assert_eq!(
            after.theme, "dracula-was-here",
            "the helper re-read the file — a stale document would have lost this field"
        );
        assert_eq!(
            after.file_policy.rules,
            vec![
                AccessRule {
                    path: "/Users/u/older".to_string(),
                    direction: RuleDirection::Write,
                    decision: RuleDecision::Deny,
                },
                AccessRule {
                    path: "/Users/u/skills".to_string(),
                    direction: RuleDirection::ReadWrite,
                    decision: RuleDecision::Allow,
                },
            ],
            "the pre-existing rule is untouched and the appended rule is LAST"
        );
        // No temp file litter beside the settings file (the rename consumed it).
        let leftovers: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != "settings.json")
            .collect();
        assert!(leftovers.is_empty(), "the atomic write left {leftovers:?}");
    }

    /// A persisted rule survives write → load → write → load through the REAL
    /// file (not through a serde value alone) — the guarantee the
    /// `allow-directory` append relies on.
    #[test]
    fn a_persisted_rule_survives_a_settings_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let rule = AccessRule {
            path: "/Users/u/skills".to_string(),
            direction: RuleDirection::ReadWrite,
            decision: RuleDecision::Allow,
        };
        let mut s = Settings::default();
        s.file_policy.rules.push(rule.clone());
        write_settings(dir.path(), &s).unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(loaded.file_policy.rules, vec![rule.clone()]);
        // A second write from the loaded document changes nothing.
        write_settings(dir.path(), &loaded).unwrap();
        let again = load_settings(dir.path());
        assert_eq!(again.file_policy, loaded.file_policy);
        // And the same through the ATOMIC path (the relay's entry point).
        write_settings_atomic(dir.path(), &again).unwrap();
        assert_eq!(load_settings(dir.path()).file_policy.rules, vec![rule]);
    }

    /// The atomic write must NOT tighten a deliberately configured mode to
    /// the temp file's 0600 (`NamedTempFile` creates 0600 and the rename
    /// takes the temp's mode) — DECISION (a): preserve the existing file's
    /// mode. `#[cfg(unix)]` because Windows has no mode concept, so there is
    /// nothing to pin there (the production twin is the same `#[cfg(unix)]`
    /// block inside `write_settings_atomic`).
    #[cfg(unix)]
    #[test]
    fn write_settings_atomic_preserves_the_existing_files_mode_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = settings_path(dir.path());
        let s = Settings::default();
        write_settings(dir.path(), &s).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640))
            .expect("the seeded mode is settable");
        write_settings_atomic(dir.path(), &s).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640,
            "the atomic write must NOT tighten a deliberately configured mode to the temp's 0600"
        );
    }
}
