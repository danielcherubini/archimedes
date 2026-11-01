//! The **Agent definition** listing commands: the two read-only surfaces over
//! `crate::agents::discover_agents` — the app-scope / `@`-mention listings
//! (`AgentDefinitionDto`, the minimal picker shape) and the **Agents** modal's
//! Agent-definition report (`AgentDefinitionReportDto`, ADR 0068).
//!
//! ADR 0023's Settings → Subagents section is GONE (the sidebar modal is the
//! single Agent surface now); the app-scope listing command was retired too
//! (Finding 8 — zero consumers), so the single read surface is
//! [`list_agent_definitions_for_space`] (the `@`-mention picker / modal).

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::agent::harness::launch::{override_layer, resolve_agent_launch, OverrideSource};
use crate::agent::harness::ModelCatalog;
use crate::agent::{AgentsError, LaunchConfig, SessionManager};
use crate::agents::AgentDefinition;
use crate::config::{AgentOverrideFields, Settings};

/// The camelCase wire shape. NOT the `AgentDefinition` struct itself —
/// a DTO keeps the command's contract stable and excludes the fields
/// the UI doesn't need (`path` / `system_prompt` / `tools` /
/// `thinking`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinitionDto {
    pub name: String,
    pub description: String,
    pub model: Option<String>,
    /// `"space" | "user"` (the `AgentScope` Display form).
    pub scope: String,
}

/// The mapping lives in a `From` impl (testable in isolation — the
/// command body is a thin `discover_agents(None).map(...)` wrapper).
impl From<AgentDefinition> for AgentDefinitionDto {
    fn from(d: AgentDefinition) -> Self {
        Self {
            name: d.name,
            description: d.description,
            model: d.model,
            scope: d.scope.to_string(),
        }
    }
}

/// The user-level + space-level Agent definitions (the `@`-mention
/// picker — the SAME set the harness's `agentName` resolution honors,
/// ADR 0020). `cwd: None` → user-level only (the app-scope case).
/// Never fails: discovery is best-effort (a missing root / unreadable
/// file / malformed frontmatter is skipped — `agents.rs`'s total
/// contract).
///
/// The `@`-MENTION surface: definitions whose name can never equal a
/// mention token (`crate::skills::is_mentionable_name`, the same predicate
/// `agent::mcp::config::server_infos` applies) are filtered out — the name is
/// interpolated UNESCAPED into `<agent name="…">` by `buildAgentBlock` and
/// `expandMentions` looks it up by `name.toLowerCase() === token`, so such a
/// definition can NEVER be expanded: offering it would insert a dead token.
/// This is a PICKER filter only — the app-scope read
/// `list_agent_definitions_for_space(None)` and [`crate::agents::discover_agents`]
/// (the dispatch path) both keep the full set, since an oddly-named definition
/// is still dispatchable by the model passing `agentName` verbatim.
#[tauri::command]
pub async fn list_agent_definitions_for_space(
    cwd: Option<String>,
) -> Result<Vec<AgentDefinitionDto>, AgentsError> {
    Ok(
        crate::agents::discover_agents(cwd.as_deref().map(std::path::Path::new))
            .into_iter()
            .filter(|d| crate::skills::is_mentionable_name(&d.name))
            .map(AgentDefinitionDto::from)
            .collect(),
    )
}

// ═══════════════════════════════════════════════════════════════════════════
// The **Agents** modal's Agent-definition report (ADR 0068).
// ═══════════════════════════════════════════════════════════════════════════

/// One field-triple as the resolver or a file sees it: the three fields the
/// chain can speak about, each independently absent.
///
/// `pub` because it types a `pub` DTO field — clippy's `private_interfaces`
/// fires TRANSITIVELY down that graph and CI runs `clippy --all-targets --
/// -D warnings`, so a crate-private nested type is a build failure here, not a
/// style note.
///
/// The `Option`s are `null` on the wire (no `skip_serializing_if`) — the three
/// columns are ROWS of a report, not the stored document, and "this column has
/// no value" is information the modal renders (as `Inherits parent`) rather
/// than a state ADR 0067 forbids. The store keeps the opposite rule because
/// there, absence is the ONLY meaning of "this override does not speak".
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideFields {
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub tools: Option<Vec<String>>,
    /// The declared `permission:` ruleset as this layer sees it. Only the FILE
    /// layer can ever be non-`None` — the persisted `agentOverrides` entry has
    /// NO `permission` key (ADR 0066's shape is `model`/`thinking`/`tools`, and
    /// absence is the ONLY meaning there), and the explicit `subagent` param has
    /// no permission argument. Kept as a column anyway so the modal's three
    /// column structs stay ONE shape (the wire-shape pin iterates the same four
    /// keys over `file` / `override` / `effective`).
    pub permission: Option<crate::agent::definition_permission::PermissionBlock>,
}

/// The STORED entry seen as one column of the report. The two types are not
/// twins: `AgentOverrideFields` is the persisted shape (a field is present or
/// absent — ADR 0067), this is a rendered column (a key is always present,
/// `null` when the layer did not speak).
impl From<&AgentOverrideFields> for OverrideFields {
    fn from(o: &AgentOverrideFields) -> Self {
        Self {
            model: o.model.clone(),
            thinking: o.thinking.clone(),
            tools: o.tools.clone(),
            // The persisted entry has NO `permission` key (config.rs'
            // `AgentOverrideFields` is `model`/`thinking`/`tools`), so the
            // override column is ALWAYS `None` for permission — absence is the
            // only thing the store can say about it.
            permission: None,
        }
    }
}

/// Which layer supplied each of the three fields (ADR 0068's label space:
/// `override` / `file` / `parent`, and NOTHING else). `pub` for the same
/// `private_interfaces` reason as [`OverrideFields`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFields {
    pub model: OverrideSource,
    pub thinking: OverrideSource,
    pub tools: OverrideSource,
    /// Which layer supplied `permission` — `File` exactly when the definition
    /// declared a block, `Parent` when it did not. NEVER `Override`: there is no
    /// settings.json permission layer, and no fourth `OverrideSource` variant
    /// exists (`the_source_label_space_is_exactly_three_layers_and_never_space`
    /// keeps the three-variant enum a compile-time fact).
    pub permission: OverrideSource,
}

/// One row of the **Agents** modal's Agent-definition report: what a
/// definition's file says, what the user stored over it, what will ACTUALLY
/// run, and which layer supplied each.
///
/// Wire-out only (no `Deserialize`). `AgentDefinitionDto` is NOT widened to
/// carry this — that DTO deliberately excludes `path` / `system_prompt` /
/// `tools` / `thinking` and filters unmentionable names, both pinned by tests,
/// because the `@`-mention picker is a different surface with a different
/// contract.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinitionReportDto {
    pub name: String,
    pub description: String,
    /// `"space" | "user"` (the `AgentScope` Display form).
    pub scope: String,
    /// The DEFINITION FILE's path (the modal prints it; `AgentDefinitionDto`
    /// deliberately omits this one).
    pub path: String,
    /// The frontmatter VERBATIM — before the filter, so the row can say what
    /// the file actually said even when none of it survived.
    pub file: OverrideFields,
    /// The stored override for this name as the SUPERVISOR read it, VERBATIM
    /// (not the resolver's output). The consumer is the modal's `override`
    /// column, and its job is to show what the user pinned whenever that
    /// differs from what the store-side lookup behind the picker controls
    /// shows: a stale pinned model the catalog no longer resolves (`source`
    /// then names a different layer, so the row must say both what was pinned
    /// and what runs), and a hand-edited case-fold twin — this side takes the
    /// entry the shared ASCII-fold scan reaches through the `HashMap` (so a
    /// `"Scout"` beside `scout` is chosen in nondeterministic order), while the
    /// renderer's own lookup takes the first entry in the document's key order,
    /// and those two can land on different entries. Not the value the controls
    /// are bound to (they keep reading the live settings document). Named
    /// `override_` in Rust (`override` is a keyword); the wire name is
    /// `override`.
    #[serde(rename = "override")]
    pub override_: OverrideFields,
    /// What the dispatch will launch with — produced by the resolver itself.
    pub effective: OverrideFields,
    /// Which layer supplied each of those three values.
    pub source: SourceFields,
    /// The definitions this name collision EXCLUDED (ADR 0065) — carried
    /// verbatim from `AgentDefinition::shadowed`, which is already a
    /// `Serialize`-deriving `Shadowed<AgentScope>` (camelCase, `{name, path,
    /// scope: "space"|"user"}`). REQUIRED on the wire, not `Option`: the Rust
    /// side always serializes the `Vec` (empty as `[]`), exactly like
    /// `SkillInfo::shadowed` (which `list_skills` serializes straight through —
    /// `Shadowed<T>` already crosses the wire), so TypeScript declares it
    /// required too. Rendered as TEXT on this row, never as rows of its own.
    pub shadowed: Vec<crate::skills::Shadowed<crate::agents::AgentScope>>,
    /// The definition's declared `permission:` ruleset, VERBATIM from the
    /// file (opencode's allow/ask/deny block, issue #101) — `null` when the
    /// file does not speak about permissions. NOT the effective verdict (the
    /// gate's strict-of-two merge is a runtime decision, not a static one).
    pub file_permission: Option<crate::agent::definition_permission::PermissionBlock>,
    /// The file-READ announce notes (unknown keys, unrecognised tool keys,
    /// unsupported bash-pattern rows — issue #101's announce half). REQUIRED
    /// on the wire, not `Option`: the Rust side ALWAYS serializes the `Vec`
    /// (empty as `[]`), exactly like `shadowed` (ADR 0065's report shape).
    pub frontmatter_notes: Vec<crate::agent::definition_permission::FrontmatterNote>,
}

/// The three columns the resolver reads, plus the ones it never touches.
fn file_fields(def: &AgentDefinition) -> OverrideFields {
    OverrideFields {
        model: def.model.clone(),
        thinking: def.thinking.clone(),
        tools: def.tools.clone(),
        permission: def.permission.clone(),
    }
}

/// The stored override for `def`, as one column: the entry the SHARED selector
/// picked, verbatim. `OverrideFields`' `Default` is all-`None`, so "no entry"
/// and "an entry that speaks about nothing" both render as three `null`s —
/// which is the honest column for "the user stored nothing about this agent".
fn stored_fields(layer: &crate::agent::harness::launch::OverrideLayer<'_>) -> OverrideFields {
    layer.global.map(OverrideFields::from).unwrap_or_default()
}

/// The pure core: everything the modal shows, from inputs the test owns.
///
/// SPLIT from the command because `tauri::State<'_, T>` has no public
/// constructor (only `StateManager` produces it, from a built `App`), so a test
/// in this file cannot call a `State`-taking command at all — and the whole
/// value of this command is a test that calls BOTH this and the dispatch's
/// resolver. Same reason the `From<AgentDefinition>` impl above exists.
///
/// `effective` / `source` come from `resolve_agent_launch` — the SAME function
/// `resolve_launch` delegates to — called with an EMPTY `LaunchConfig`, because
/// `agentName` and the explicit params exist only inside a live `subagent` call
/// and no modal can know them. So `source` names at most three layers and
/// `Parent` means "nothing below the explicit param spoke"; a dispatch that
/// passes `model:` still overrides what the row shows (ADR 0068).
///
/// The override comes from Task 1's shared `override_layer` selector — there is
/// deliberately NO second selector here, because two selectors is how the
/// command and the dispatch drift.
pub(crate) fn agent_definition_reports(
    settings: &Settings,
    defs: &[AgentDefinition],
    catalog: &ModelCatalog,
) -> Vec<AgentDefinitionReportDto> {
    defs.iter()
        .map(|def| {
            // The `Some(..)` is not optional — `override_layer` takes
            // `Option<&Settings>` and the command always HAS settings.
            let layer = override_layer(Some(settings), &def.name);
            let resolved = resolve_agent_launch(&LaunchConfig::default(), def, &layer, catalog);
            AgentDefinitionReportDto {
                name: def.name.clone(),
                description: def.description.clone(),
                scope: def.scope.to_string(),
                path: def.path.clone(),
                file: file_fields(def),
                // The STORED entry verbatim — a stale pin has to stay visible
                // beside the value that replaced it.
                override_: stored_fields(&layer),
                effective: OverrideFields {
                    model: resolved.launch.model,
                    thinking: resolved.launch.thinking,
                    tools: resolved.launch.tools,
                    // UNBOXED here: `LaunchConfig::permission` is boxed only for
                    // clippy's enum-size lint, and the DTO reports the plain
                    // block (serde-identical either way).
                    permission: resolved.launch.permission.map(|block| *block),
                },
                source: SourceFields {
                    model: resolved.model_source,
                    thinking: resolved.thinking_source,
                    tools: resolved.tools_source,
                    permission: resolved.permission_source,
                },
                shadowed: def.shadowed.clone(),
                // Both cloned from the definition BEFORE the resolver: this is
                // the frontmatter half of what the row REPORTS (never an
                // effective verdict — the strict-of-two merge is runtime work).
                file_permission: def.permission.clone(),
                frontmatter_notes: def.frontmatter_notes.clone(),
            }
        })
        // Discovery already sorts (case-insensitive by name, `path` as the
        // tie-break) — keep that order, the modal renders this list as given.
        .collect()
}

/// The **Agents** modal's rows: the effective `model` / `thinking` / `tools`
/// for every Agent definition the active Space can see, plus the layer that
/// supplied each (ADR 0068).
///
/// **No path argument selects the overrides — there is nothing to select on.**
/// ADR 0066 keeps exactly ONE global `agentOverrides` map, so no Space can hold
/// a different override for the same agent: `cwd` decides only WHICH
/// DEFINITIONS get listed (space-level + user-level, or user-level alone), never
/// which overrides apply. That absence is the design, and this line is the one
/// place the code says it out loud.
///
/// `cwd: None` → user-level definitions only (the app-scope read — the same
/// rule [`list_agent_definitions_for_space`] documents for its `cwd: None`
/// case, and exactly what the deleted Settings section listed). The full set
/// is used with NO mentionable-name
/// filter and `shadowed` intact: this is not a mention surface, and the
/// shadowing report is the modal's to render (ADR 0065).
///
/// **Potentially NETWORK-BOUND, unlike its catalog siblings.** `effective_catalog`
/// performs per-provider model discovery (a `GET /v1/models`), cached per
/// provider — `list_skills` and [`list_agent_definitions_for_space`] are pure
/// local disk walks. This command is called on every Space switch, so Task 5's
/// hook must serve `[]` immediately on a key change rather than hold the
/// previous Space's rows; that rule matters MORE here than it does for skills.
///
/// Never fails: discovery is total (`agents.rs`'s contract) and a bad settings
/// file loads as defaults, so the `Result` is for command-shape stability only.
/// The error type is `AgentsError` (not `String`) so this command stays on
/// ADR 0063's typed `{kind, message}` surface and the frontend's
/// `describeIpcError` path.
#[tauri::command]
pub async fn list_agent_definition_reports(
    state: State<'_, Arc<SessionManager>>,
    cwd: Option<String>,
) -> Result<Vec<AgentDefinitionReportDto>, AgentsError> {
    let settings = crate::config::load_settings(state.config_dir());
    let catalog = state.effective_catalog(None, true).await;
    Ok(agent_definition_reports(
        &settings,
        &crate::agents::discover_agents(cwd.as_deref().map(Path::new)),
        &catalog,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::AgentScope;
    use std::fs;

    fn full_definition() -> AgentDefinition {
        AgentDefinition {
            name: "scout".to_string(),
            description: "Fast recon.".to_string(),
            model: Some("tama/m-1".to_string()),
            thinking: Some("high".to_string()),
            tools: Some(vec!["read".to_string()]),
            permission: None,
            frontmatter_notes: Vec::new(),
            system_prompt: "You are a scout.".to_string(),
            scope: AgentScope::User,
            path: "/home/u/.agents/agents/scout.md".to_string(),
            shadowed: Vec::new(),
        }
    }

    #[test]
    fn agent_definition_dto_mapping() {
        let dto = AgentDefinitionDto::from(full_definition());
        assert_eq!(dto.name, "scout");
        assert_eq!(dto.description, "Fast recon.");
        assert_eq!(dto.model.as_deref(), Some("tama/m-1"));
        assert_eq!(dto.scope, "user");

        // The DTO excludes the fields the UI doesn't need.
        let json = serde_json::to_string(&dto).unwrap();
        for key in ["systemPrompt", "path", "tools", "thinking"] {
            assert!(
                !json.contains(key),
                "wire JSON must not contain `{key}`: {json}"
            );
        }
    }

    #[test]
    fn agent_definition_dto_a_none_model_is_null_on_the_wire() {
        let mut d = full_definition();
        d.model = None;
        d.scope = AgentScope::Space;
        let dto = AgentDefinitionDto::from(d);
        let json = serde_json::to_string(&dto).unwrap();
        assert!(
            json.contains("\"model\":null"),
            "expected `null` model in: {json}"
        );
        assert!(
            json.contains("\"scope\":\"space\""),
            "expected `\"space\"` scope in: {json}"
        );
    }

    /// Restores `HOME` on scope exit (even when an assertion panics
    /// mid-test): `Some(v)` → set, `None` → remove. Mirrors the
    /// `agents.rs` test helper (private to that module).
    struct RestoreHome(Option<std::ffi::OsString>);
    impl Drop for RestoreHome {
        fn drop(&mut self) {
            match self.0.take() {
                // SAFETY: the `ENV_LOCK` is still held at drop time (this
                // guard is declared after the `_lock` guard and outlives
                // it in reverse); no other thread mutates HOME concurrently.
                Some(v) => unsafe {
                    std::env::set_var("HOME", v);
                },
                // SAFETY: same as above.
                None => unsafe {
                    std::env::remove_var("HOME");
                },
            }
        }
    }

    // The command's contract for a Space: `discover_agents(Some(space))`
    // lists the user-level + space-level definitions (the `@`-mention
    // picker — ADR 0020). `HOME` is isolated the same way `agents.rs`'
    // tests do (`env_lock` + `RestoreHome`): `user_roots()` walks the
    // real `~/.agents/agents` otherwise.
    /// `#[allow(clippy::await_holding_lock)]` is INTENTIONAL: the command reads
    /// `HOME` (via `user_roots`), so the guard must stay held ACROSS the
    /// `.await` to serialize against the other HOME-reading tests — dropping
    /// it before the await would open a window where a sibling test could
    /// flip `HOME` mid-discovery.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn list_agent_definitions_for_space_a_space_level_definition_is_listed() {
        // Hold the shared lock for the WHOLE set→assert→restore span (a
        // `cargo test --lib` runs all module tests concurrently).
        let _lock = crate::test_support::env_lock();
        let original = std::env::var_os("HOME");
        let _restore = RestoreHome(original.clone());
        // A temp `HOME` with NO agent dirs (a user-level definition would
        // leak in via the real `HOME` if the pin failed).
        let home = scratch();
        // SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore
        // span (the `env_lock` guard); no other thread mutates HOME
        // concurrently.
        unsafe {
            std::env::set_var("HOME", home.path());
        }
        let dir = scratch();
        fs::create_dir_all(dir.join(".agents/agents")).unwrap();
        fs::write(
            dir.join(".agents/agents/space-agent.md"),
            "---\nname: space-agent\ndescription: A space-level agent.\n---\nBody.\n",
        )
        .unwrap();

        let out = list_agent_definitions_for_space(Some(dir.to_string_lossy().into_owned()))
            .await
            .unwrap();
        let d = out
            .iter()
            .find(|d| d.name == "space-agent")
            .expect("the space-level definition must be listed");
        assert_eq!(d.scope, "space");
    }

    /// `#[allow(clippy::await_holding_lock)]` is INTENTIONAL: the command reads
    /// `HOME` (via `user_roots`), so the guard must stay held ACROSS the
    /// `.await` to serialize against the other HOME-reading tests — dropping
    /// it before the await would open a window where a sibling test could
    /// flip `HOME` mid-discovery.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn list_agent_definitions_for_space_includes_user_level_definitions() {
        let _lock = crate::test_support::env_lock();
        let original = std::env::var_os("HOME");
        let _restore = RestoreHome(original.clone());
        let home = scratch();
        // SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore
        // span (the `env_lock` guard); no other thread mutates HOME
        // concurrently.
        unsafe {
            std::env::set_var("HOME", home.path());
        }
        fs::create_dir_all(home.join(".agents/agents")).unwrap();
        fs::write(
            home.join(".agents/agents/user-agent.md"),
            "---\nname: user-agent\ndescription: A user-level agent.\n---\nBody.\n",
        )
        .unwrap();
        let space = scratch();
        fs::create_dir_all(space.join(".agents/agents")).unwrap();
        fs::write(
            space.join(".agents/agents/space-agent.md"),
            "---\nname: space-agent\ndescription: A space-level agent.\n---\nBody.\n",
        )
        .unwrap();

        let out = list_agent_definitions_for_space(Some(space.to_string_lossy().into_owned()))
            .await
            .unwrap();
        let user = out
            .iter()
            .find(|d| d.name == "user-agent")
            .expect("the user-level definition must be listed");
        assert_eq!(user.scope, "user");
        let space_def = out
            .iter()
            .find(|d| d.name == "space-agent")
            .expect("the space-level definition must be listed");
        assert_eq!(space_def.scope, "space");
    }

    /// `#[allow(clippy::await_holding_lock)]` is INTENTIONAL: the command reads
    /// `HOME` (via `user_roots`), so the guard must stay held ACROSS the
    /// `.await` to serialize against the other HOME-reading tests — dropping
    /// it before the await would open a window where a sibling test could
    /// flip `HOME` mid-discovery.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn list_agent_definitions_for_space_none_is_user_level_only() {
        let _lock = crate::test_support::env_lock();
        let original = std::env::var_os("HOME");
        let _restore = RestoreHome(original.clone());
        let home = scratch();
        // SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore
        // span (the `env_lock` guard); no other thread mutates HOME
        // concurrently.
        unsafe {
            std::env::set_var("HOME", home.path());
        }
        fs::create_dir_all(home.join(".agents/agents")).unwrap();
        fs::write(
            home.join(".agents/agents/user-agent.md"),
            "---\nname: user-agent\ndescription: A user-level agent.\n---\nBody.\n",
        )
        .unwrap();

        let out = list_agent_definitions_for_space(None).await.unwrap();
        assert_eq!(
            out.len(),
            1,
            "expected exactly the user-level definition: {out:?}"
        );
        assert_eq!(out[0].name, "user-agent");
        assert_eq!(out[0].scope, "user");
        assert!(!out.iter().any(|d| d.name == "space-agent"));
    }

    // A3 — the `@`-mention picker boundary. A definition whose name can never
    // equal a mention token is UNNAMEABLE from the composer, so the picker
    // must not offer it (a pick would insert a dead token that never
    // expands) — but DISCOVERY must keep it, because the harness's
    // `agentName` dispatch still honors it (a name with a space is
    // dispatchable by the model passing it verbatim). This test pins BOTH
    // halves so the dispatch path is provably untouched.
    //
    // (The former part 2 asserted the same "unchanged listing" property
    // through the retired app-scope command; that command was deleted with
    // zero consumers (Finding 8), so the assertion went with it. Part 1 pins
    // the picker filter and part 2 pins the dispatch-path discovery — the
    // property itself is still pinned.)
    /// `#[allow(clippy::await_holding_lock)]` is INTENTIONAL: the command reads
    /// `HOME` (via `user_roots`), so the guard must stay held ACROSS the
    /// `.await` to serialize against the other HOME-reading tests — dropping
    /// it before the await would open a window where a sibling test could
    /// flip `HOME` mid-discovery.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn an_unmentionable_name_is_hidden_from_the_picker_but_kept_elsewhere() {
        let _lock = crate::test_support::env_lock();
        let original = std::env::var_os("HOME");
        let _restore = RestoreHome(original.clone());
        let home = scratch();
        // SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore
        // span (the `env_lock` guard); no other thread mutates HOME
        // concurrently.
        unsafe {
            std::env::set_var("HOME", home.path());
        }
        fs::create_dir_all(home.join(".agents/agents")).unwrap();
        fs::write(
            home.join(".agents/agents/scout.md"),
            "---\nname: scout\ndescription: Fast recon.\n---\nBody.\n",
        )
        .unwrap();
        // A name with a SPACE (dispatchable, but no token can ever equal it)
        // and one with a `"` (would break the `<agent name="…">` tag).
        fs::write(
            home.join(".agents/agents/weird.md"),
            "---\nname: has space\ndescription: Weird.\n---\nBody.\n",
        )
        .unwrap();
        fs::write(
            home.join(".agents/agents/evil.md"),
            "---\nname: x\" onload=\"y\ndescription: Evil.\n---\nBody.\n",
        )
        .unwrap();
        let space = scratch();
        fs::create_dir_all(space.join(".agents/agents")).unwrap();
        fs::write(
            space.join(".agents/agents/space-weird.md"),
            "---\nname: space level\ndescription: Space-level weird.\n---\nBody.\n",
        )
        .unwrap();

        let space_arg = space.to_string_lossy().into_owned();

        // 1. The MENTION surface excludes them (both the app-scope and the
        //    space-scope call).
        let names: Vec<String> = list_agent_definitions_for_space(None)
            .await
            .unwrap()
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert_eq!(names, vec!["scout".to_string()]);
        let space_names: Vec<String> = list_agent_definitions_for_space(Some(space_arg.clone()))
            .await
            .unwrap()
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert_eq!(space_names, vec!["scout".to_string()]);

        // 2. DISCOVERY is UNCHANGED too (the dispatch path): every name
        //    survives, space-level included.
        let discovered: Vec<String> =
            crate::agents::discover_agents(Some(std::path::Path::new(&space_arg)))
                .into_iter()
                .map(|d| d.name)
                .collect();
        assert_eq!(
            discovered,
            vec![
                "has space".to_string(),
                "scout".to_string(),
                "space level".to_string(),
                "x\" onload=\"y".to_string()
            ]
        );
    }

    #[test]
    fn agents_error_kind_and_message() {
        let err = AgentsError::NotFound("scout".into());
        assert_eq!(err.kind(), "not_found");
        assert_eq!(err.to_string(), "agent not found: scout");
    }

    // ══════════════════════════════════════════════════════════════════════
    // `agent_definition_reports` — the Agents modal's rows (ADR 0068).
    //
    // Every test here calls the PURE CORE, not the command: `tauri::State` has
    // no public constructor (it is produced only by `StateManager::get`, i.e.
    // only from a built `App`), so a `#[tokio::test]` in this file CANNOT reach
    // a `State`-taking command — and without the split the ADR 0068 pin below
    // would be unwriteable. The same reason the `From` impl above exists.
    //
    // The pure-core tests build `AgentDefinition` / `ModelCatalog` fixtures
    // directly and touch no filesystem; only the tests that actually call
    // `discover_agents` take the `env_lock` + `RestoreHome` + `scratch()`
    // world (HOME must be isolated because `user_roots()` reads the real
    // `~/.agents/agents`).
    // ══════════════════════════════════════════════════════════════════════

    /// A catalog model advertising NO thinking levels (the same shape as
    /// `launch.rs`'s `fake_model`). An empty `thinking_levels` set SOFT-PASSES
    /// `Model::supports_thinking_level`, so this fixture can never demonstrate
    /// a thinking-level DEMOTION — hence the sibling below.
    fn catalog_model(id: &str) -> crate::agent::harness::catalog::Model {
        crate::agent::harness::catalog::Model {
            id: id.to_string(),
            provider: "fake".to_string(),
            base_url: "http://fake".to_string(),
            api_key: "k".to_string(),
            context_window: 128_000,
            cost_per_mtok_in: 0.0,
            cost_per_mtok_out: 0.0,
            supports_tools: true,
            supports_thinking: false,
            thinking_levels: Vec::new(),
            api: Some("openai-completions".to_string()),
        }
    }

    /// A catalog model that ADVERTISES `low` / `high` — the fixture the
    /// demotion test needs, since `catalog_model` advertises none and the
    /// empty set soft-passes.
    ///
    /// Why a local copy instead of reusing `launch.rs`'s `levelled_model`:
    /// that helper is a private `fn` inside `launch.rs`'s own
    /// `#[cfg(test)] mod tests`, so it is unreachable from this module, and
    /// promoting it across modules would mean a `cfg(test)`-only cross-module
    /// export for one field of one struct. `Model` is a plain all-`pub` struct,
    /// so a local fixture is what every other test module in this crate does
    /// (`compact.rs`, `dispatch.rs`, `worker/*`, `session/naming.rs`, …).
    fn levelled_model(id: &str) -> crate::agent::harness::catalog::Model {
        crate::agent::harness::catalog::Model {
            thinking_levels: vec!["low".to_string(), "high".to_string()],
            supports_thinking: true,
            ..catalog_model(id)
        }
    }

    /// The catalog most of these tests use: `fake/m1` (no levels) and
    /// `fake/m3` (advertises `low`/`high`). `fake/gone` is deliberately
    /// ABSENT — a value in that shape is the stale-override case.
    fn catalog() -> crate::agent::harness::ModelCatalog {
        crate::agent::harness::ModelCatalog {
            models: vec![catalog_model("m1"), levelled_model("m3")],
            default_model: None,
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        }
    }

    /// A definition fixture. The defaults are "a file that speaks about
    /// nothing", so each test overrides ONLY the fields it argues about.
    fn definition(name: &str, scope: AgentScope) -> AgentDefinition {
        AgentDefinition {
            name: name.to_string(),
            description: "Fast recon.".to_string(),
            model: None,
            thinking: None,
            tools: None,
            permission: None,
            frontmatter_notes: Vec::new(),
            system_prompt: "You are a scout.".to_string(),
            scope,
            path: format!("/defs/{name}.md"),
            shadowed: Vec::new(),
        }
    }

    /// Settings carrying `agentOverrides` entries (ADR 0066's global map).
    fn settings_with(entries: &[(&str, AgentOverrideFields)]) -> Settings {
        Settings {
            agent_overrides: entries
                .iter()
                .map(|(name, fields)| (name.to_string(), fields.clone()))
                .collect(),
            ..Settings::default()
        }
    }

    /// An override entry speaking about one field.
    fn model_override(model: &str) -> AgentOverrideFields {
        AgentOverrideFields {
            model: Some(model.to_string()),
            ..Default::default()
        }
    }

    /// Exactly one row, or a failure naming what came back.
    fn one_row(rows: &[AgentDefinitionReportDto]) -> &AgentDefinitionReportDto {
        assert_eq!(rows.len(), 1, "expected exactly one row: {rows:?}");
        &rows[0]
    }

    /// The rows carry the DEFINITION's identity: `scope` (the `"space" |
    /// "user"` Display form), the definition FILE's `path` (the field
    /// `AgentDefinitionDto` deliberately omits), and the description — in
    /// discovery's own deterministic order (sorted case-insensitively by name,
    /// `path` as the tie-break).
    #[test]
    fn agent_definition_reports_lists_a_space_level_and_a_user_level_definition_with_their_identity(
    ) {
        let defs = vec![
            definition("alpha", AgentScope::Space),
            definition("zeta", AgentScope::User),
        ];
        let rows = agent_definition_reports(&Settings::default(), &defs, &catalog());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "alpha");
        assert_eq!(rows[0].scope, "space");
        assert_eq!(rows[0].path, "/defs/alpha.md");
        assert_eq!(rows[1].name, "zeta");
        assert_eq!(rows[1].scope, "user");
        assert_eq!(rows[1].path, "/defs/zeta.md");
        assert_eq!(rows[1].description, "Fast recon.");
    }

    /// (ADR 0068) THE pin that matters most: the DISPATCH and THIS command
    /// produce the same `effective` values and the same `source` layers for the
    /// same inputs. A layer added to the resolver's dispatch entry point and
    /// forgotten in the modal (or the reverse) reddens this.
    ///
    /// `resolve_launch` RE-DISCOVERS the definitions from disk
    /// (`discover_agents(Some(space_cwd))`) rather than receiving them, so the
    /// modal side is fed the very definition the dispatch's own discovery
    /// found — the two sides can never be handed different inputs, and the
    /// `path` assertion below is what proves it.
    #[test]
    fn agent_definition_reports_and_the_dispatch_resolve_the_same_row() {
        let _lock = crate::test_support::env_lock();
        let original = std::env::var_os("HOME");
        let _restore = RestoreHome(original.clone());
        // An EMPTY scratch HOME: the Space is the only root that contributes a
        // definition, so a leak from the real `~/.agents/agents` cannot make a
        // row appear that this test did not write.
        let home = scratch();
        // SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore span;
        // no other thread mutates HOME concurrently.
        unsafe {
            std::env::set_var("HOME", home.path());
        }

        // (settings.json body, definition frontmatter, expected `effective`,
        //  expected `source`) — ONE CASE PER LAYER POSITION, so every rung of
        //  the chain is compared against the dispatch, not just the top one.
        let cases: Vec<(&str, &str, OverrideFields, SourceFields)> = vec![
            // The OVERRIDE layer wins on every field it speaks about.
            (
                r#"{ "agentOverrides": { "scout": { "model": "fake/m3", "thinking": "high", "tools": ["read"] } } }"#,
                "---\nname: scout\ndescription: Fast recon.\nmodel: fake/m1\nthinking: low\ntools: [bash]\n---\nBody.\n",
                OverrideFields {
                    model: Some("fake/m3".into()),
                    thinking: Some("high".into()),
                    tools: Some(vec!["read".into()]),
                    // The stored entry CANNOT speak about permissions (no such
                    // key exists in `agentOverrides`), so the override column is
                    // `None` here even though the entry won every other field.
                    permission: None,
                },
                SourceFields {
                    model: OverrideSource::Override,
                    thinking: OverrideSource::Override,
                    tools: OverrideSource::Override,
                    permission: OverrideSource::Parent,
                },
            ),
            // The FILE layer wins (no entry in the map) — and note `thinking`:
            // a frontmatter level NEVER moves into `LaunchConfig::thinking`
            // (`launch.rs` keeps it in `frontmatter_thinking`, the LAST rung of
            // the dispatch's own chain), so the modal reports `effective: null`
            // + `source: parent` while the `file` column still shows `low`.
            // The dispatch resolves it the same way — which is the point.
            (
                r#"{ "agentOverrides": {} }"#,
                "---\nname: scout\ndescription: Fast recon.\nmodel: fake/m1\nthinking: low\ntools: [bash]\n---\nBody.\n",
                OverrideFields {
                    model: Some("fake/m1".into()),
                    thinking: None,
                    tools: Some(vec!["bash".into()]),
                    permission: None,
                },
                SourceFields {
                    model: OverrideSource::File,
                    thinking: OverrideSource::Parent,
                    tools: OverrideSource::File,
                    permission: OverrideSource::Parent,
                },
            ),
            // NOTHING below the explicit param speaks: `parent` on all three.
            (
                r#"{ "agentOverrides": {} }"#,
                "---\nname: scout\ndescription: Fast recon.\n---\nBody.\n",
                OverrideFields {
                    model: None,
                    thinking: None,
                    tools: None,
                    permission: None,
                },
                SourceFields {
                    model: OverrideSource::Parent,
                    thinking: OverrideSource::Parent,
                    tools: OverrideSource::Parent,
                    permission: OverrideSource::Parent,
                },
            ),
            // A STALE override degrades (ADR 0023's soft degrade) and the layer
            // BELOW it is reported — the modal must not claim the pinned model
            // runs when the catalog can no longer resolve it.
            (
                r#"{ "agentOverrides": { "scout": { "model": "fake/gone" } } }"#,
                "---\nname: scout\ndescription: Fast recon.\nmodel: fake/m1\n---\nBody.\n",
                OverrideFields {
                    model: Some("fake/m1".into()),
                    thinking: None,
                    tools: None,
                    permission: None,
                },
                SourceFields {
                    model: OverrideSource::File,
                    thinking: OverrideSource::Parent,
                    tools: OverrideSource::Parent,
                    permission: OverrideSource::Parent,
                },
            ),
        ];

        for (settings_body, definition_body, want_effective, want_source) in cases {
            let space = scratch();
            fs::create_dir_all(space.join(".agents/agents")).unwrap();
            fs::write(space.join(".agents/agents/scout.md"), definition_body).unwrap();
            let config_dir = scratch();
            fs::write(config_dir.join("settings.json"), settings_body).unwrap();
            let cat = catalog();

            // SIDE 1 — the dispatch. `resolve_launch` is what a real `subagent`
            // call runs (it reads `settings.json` and discovers for itself).
            let (dispatch, name_resolution) = crate::agent::harness::launch::resolve_launch(
                &LaunchConfig::default(),
                "scout",
                &cat,
                Some(&config_dir),
                &space,
            );
            // (issue #47) The parity cases are all MATCHED cases — the fixture
            // writes `scout.md` into the scratch Space for every one of them,
            // so if any of them ever resolves to `Unmatched` the three
            // comparisons below are comparing a config-less launch against the
            // modal's row and proving nothing.
            assert_eq!(
                name_resolution,
                crate::agent::subagent::AgentNameResolution::Matched,
                "both sides were handed a Space that defines `scout`: {settings_body}"
            );

            // SIDE 2 — the modal's command, fed the definitions the DISPATCH's
            // own discovery just found, over the same settings file.
            let defs = crate::agents::discover_agents(Some(&space));
            let rows =
                agent_definition_reports(&crate::config::load_settings(&config_dir), &defs, &cat);
            let discovered = defs
                .iter()
                .find(|d| d.name == "scout")
                .expect("the scratch Space holds scout.md");
            let row = one_row(&rows);
            assert_eq!(
                row.path, discovered.path,
                "both sides were handed the SAME definition file: {settings_body}"
            );

            assert_eq!(
                row.effective, want_effective,
                "the modal's `effective` for {settings_body}"
            );
            assert_eq!(
                row.source, want_source,
                "the modal's `source` for {settings_body}"
            );
            // And the modal's `effective` IS what the dispatch would launch
            // with — the one comparison ADR 0068 exists to make.
            assert_eq!(
                row.effective.model, dispatch.model,
                "`model` disagrees between the dispatch and the modal ({settings_body})"
            );
            assert_eq!(
                row.effective.thinking, dispatch.thinking,
                "`thinking` disagrees between the dispatch and the modal ({settings_body})"
            );
            assert_eq!(
                row.effective.tools, dispatch.tools,
                "`tools` disagree between the dispatch and the modal ({settings_body})"
            );
        }
    }

    /// The modal is NOT a mention surface: a name that can never equal an
    /// `@`-mention token IS listed here (the model can still dispatch it by
    /// passing `agentName` verbatim). This is the half of the contract that
    /// `an_unmentionable_name_is_hidden_from_the_picker_but_kept_elsewhere`
    /// pins for the picker — the new command must NOT inherit that filter.
    #[test]
    fn agent_definition_reports_lists_an_unmentionable_name_the_picker_hides() {
        let def = definition("has space", AgentScope::User);
        assert!(
            !crate::skills::is_mentionable_name(&def.name),
            "the fixture must be a name the `@`-mention picker filters out"
        );
        let rows =
            agent_definition_reports(&Settings::default(), std::slice::from_ref(&def), &catalog());
        let row = one_row(&rows);
        assert_eq!(row.name, "has space");
    }

    /// (ADR 0065 + 0068) THE shadowing report rides the WINNING row — the
    /// collision the deleted Settings section structurally COULD NOT see (it
    /// read user-level roots only). This is the feature's proof, not a bonus.
    #[test]
    fn agent_definition_reports_carries_the_shadowing_report_on_the_winning_row() {
        let _lock = crate::test_support::env_lock();
        let original = std::env::var_os("HOME");
        let _restore = RestoreHome(original.clone());

        let home = scratch();
        fs::create_dir_all(home.join(".agents/agents")).unwrap();
        let user_file = home.join(".agents/agents/scout.md");
        fs::write(
            &user_file,
            "---\nname: scout\ndescription: The USER-level scout.\nmodel: fake/m1\n---\nThe user-level body.\n",
        )
        .unwrap();
        // SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore span;
        // no other thread mutates HOME concurrently.
        unsafe {
            std::env::set_var("HOME", home.path());
        }

        let space = scratch();
        fs::create_dir_all(space.join(".agents/agents")).unwrap();
        fs::write(
            space.join(".agents/agents/scout.md"),
            "---\nname: scout\ndescription: The SPACE-level scout.\nmodel: fake/m3\n---\nThe space-level body.\n",
        )
        .unwrap();

        let rows = agent_definition_reports(
            &Settings::default(),
            &crate::agents::discover_agents(Some(&space)),
            &catalog(),
        );
        let row = one_row(&rows);
        assert_eq!(row.name, "scout");
        assert_eq!(
            row.scope, "space",
            "the Space definition wins the name, so the WINNER's row is what carries the report"
        );
        assert_eq!(
            row.effective.model.as_deref(),
            Some("fake/m3"),
            "and the winner's frontmatter is what resolves"
        );
        assert_eq!(
            row.shadowed.len(),
            1,
            "the user-level loser is reported on the winner: {row:?}"
        );
        let loser = &row.shadowed[0];
        assert_eq!(loser.name, "scout");
        assert_eq!(loser.scope, AgentScope::User);
        // The LOSER's own canonical path — not the winner's (the modal prints
        // it so the user can tell the two files apart).
        assert_eq!(
            loser.path,
            fs::canonicalize(&user_file).unwrap().to_string_lossy(),
            "the report names the loser's file"
        );
        assert_ne!(loser.path, row.path);
        // The `AgentScope` Display form on the wire (Task 5 renders it).
        let json = serde_json::to_string(loser).unwrap();
        assert!(
            json.contains("\"scope\":\"user\""),
            "expected `\"scope\":\"user\"` in: {json}"
        );
    }

    /// No collision ⇒ `shadowed` is `[]` on the wire — never `null`, never an
    /// absent key (the `SkillInfo::shadowed` precedent `list_skills` already
    /// ships). Task 4 declares the TypeScript field REQUIRED on this fact.
    #[test]
    fn a_definition_with_no_collision_serializes_shadowed_as_an_empty_array() {
        let def = definition("scout", AgentScope::User);
        let rows =
            agent_definition_reports(&Settings::default(), std::slice::from_ref(&def), &catalog());
        let json = serde_json::to_string(&rows[0]).unwrap();
        assert!(
            json.contains("\"shadowed\":[]"),
            "expected `\"shadowed\":[]` in: {json}"
        );
        assert!(
            !json.contains("\"shadowed\":null"),
            "`shadowed` must never be `null`: {json}"
        );
    }

    /// The app-scope read (`cwd: None` → `discover_agents(None)`) — exactly
    /// what the deleted Settings section listed: USER-level rows only, and the
    /// one surviving row's `source` triple names the layer each field really
    /// came from (`file` for its frontmatter `model`, `parent` for the two
    /// fields nothing spoke about).
    #[test]
    fn the_app_scope_read_is_user_level_rows_only() {
        let _lock = crate::test_support::env_lock();
        let original = std::env::var_os("HOME");
        let _restore = RestoreHome(original.clone());

        let home = scratch();
        fs::create_dir_all(home.join(".agents/agents")).unwrap();
        fs::write(
            home.join(".agents/agents/user-agent.md"),
            "---\nname: user-agent\ndescription: A user-level agent.\nmodel: fake/m1\n---\nBody.\n",
        )
        .unwrap();
        // SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore span;
        // no other thread mutates HOME concurrently.
        unsafe {
            std::env::set_var("HOME", home.path());
        }
        // A Space with its own definition — `discover_agents(None)` never
        // scans it, so its row must be absent.
        let space = scratch();
        fs::create_dir_all(space.join(".agents/agents")).unwrap();
        fs::write(
            space.join(".agents/agents/space-agent.md"),
            "---\nname: space-agent\ndescription: A space-level agent.\n---\nBody.\n",
        )
        .unwrap();

        let rows = agent_definition_reports(
            &Settings::default(),
            &crate::agents::discover_agents(None),
            &catalog(),
        );
        assert_eq!(rows.len(), 1, "user-level only: {rows:?}");
        assert_eq!(rows[0].name, "user-agent");
        assert_eq!(rows[0].scope, "user");
        // The `source` triple for THIS row, named value by value rather than
        // "some variant of a three-variant enum" (a `matches!` over every
        // variant can never fail — and a fourth variant is already a COMPILE
        // error in
        // `the_source_label_space_is_exactly_three_layers_and_never_space`).
        // The fixture speaks about ONE field: `model: fake/m1` in the file, no
        // override, no `thinking`, no `tools`. MUTATION-CHECKED: relabelling
        // the frontmatter `model` rung from `File` to `Parent` reddens the
        // first assertion below, where the deleted loop stayed green.
        assert_eq!(
            rows[0].source.model,
            OverrideSource::File,
            "the file's `model: fake/m1` is the only layer that speaks"
        );
        assert_eq!(
            rows[0].source.thinking,
            OverrideSource::Parent,
            "the file says nothing about thinking and no override exists"
        );
        assert_eq!(
            rows[0].source.tools,
            OverrideSource::Parent,
            "the file says nothing about tools and no override exists"
        );
    }

    /// A stale pinned model: `source` names the layer that ACTUALLY won, while
    /// `override` still shows the stale value — the one place the user learns
    /// "you pinned `fake/gone` and that is NOT what runs" (ADR 0023's soft
    /// degrade). `file` / `override` / `effective` are three different columns
    /// and none is redundant.
    #[test]
    fn a_stale_pinned_model_reports_the_layer_that_won_and_still_shows_the_stale_value() {
        let def = definition("scout", AgentScope::User);
        let rows = agent_definition_reports(
            &settings_with(&[("scout", model_override("fake/gone"))]),
            std::slice::from_ref(&def),
            &catalog(),
        );
        let row = one_row(&rows);
        assert_eq!(
            row.override_.model.as_deref(),
            Some("fake/gone"),
            "the stored entry is shown VERBATIM (it is NOT the resolver's output)"
        );
        assert_eq!(row.effective.model, None);
        assert_eq!(
            row.source.model,
            OverrideSource::Parent,
            "nothing spoke usefully, so the child inherits — NOT `override`"
        );
    }

    /// A stored model the catalog CAN resolve wins, and a stale file value
    /// under it is reported as `override` — the same pin seen from the side
    /// where the override is the winner.
    #[test]
    fn an_override_model_wins_and_reports_the_layer_that_supplied_it() {
        let mut def = definition("scout", AgentScope::User);
        def.model = Some("fake/gone".to_string());
        let rows = agent_definition_reports(
            &settings_with(&[("scout", model_override("fake/m1"))]),
            std::slice::from_ref(&def),
            &catalog(),
        );
        let row = one_row(&rows);
        assert_eq!(row.file.model.as_deref(), Some("fake/gone"));
        assert_eq!(row.effective.model.as_deref(), Some("fake/m1"));
        assert_eq!(row.source.model, OverrideSource::Override);
    }

    /// (ADR 0066 item 5) An override `thinking` level the winning model does
    /// NOT advertise is neither written nor reported — it must NOT appear as
    /// `effective.thinking` with `source: "override"` (that would be the ADR
    /// 0068 lie: the dispatch drops the level, so the modal may not promise
    /// it). Needs a levels-advertising fixture (`fake/m3`) — `catalog_model`
    /// advertises none and an empty set soft-passes.
    #[test]
    fn an_override_thinking_the_winning_model_lacks_is_demoted() {
        let rows = agent_definition_reports(
            &settings_with(&[(
                "scout",
                AgentOverrideFields {
                    model: Some("fake/m3".into()),
                    thinking: Some("xhigh".into()),
                    tools: None,
                },
            )]),
            std::slice::from_ref(&definition("scout", AgentScope::User)),
            &catalog(),
        );
        let row = one_row(&rows);
        assert_eq!(
            row.effective.model.as_deref(),
            Some("fake/m3"),
            "the override model DID win — only its level is demoted"
        );
        assert_eq!(
            row.override_.thinking.as_deref(),
            Some("xhigh"),
            "the stored value is still shown, so the row can say both things at once"
        );
        assert_eq!(
            row.effective.thinking, None,
            "the demoted level is not effective"
        );
        assert_ne!(
            row.source.thinking,
            OverrideSource::Override,
            "a demoted level is never REPORTED as the override's either"
        );
    }

    /// An advertised override level DOES win (`fake/m3` advertises `high`).
    #[test]
    fn an_override_thinking_the_winning_model_advertises_is_effective() {
        let rows = agent_definition_reports(
            &settings_with(&[(
                "scout",
                AgentOverrideFields {
                    model: Some("fake/m3".into()),
                    thinking: Some("high".into()),
                    tools: None,
                },
            )]),
            std::slice::from_ref(&definition("scout", AgentScope::User)),
            &catalog(),
        );
        let row = one_row(&rows);
        assert_eq!(row.effective.thinking.as_deref(), Some("high"));
        assert_eq!(row.source.thinking, OverrideSource::Override);
    }

    /// `file` is the FRONTMATTER VERBATIM while `effective` is the FILTERED
    /// value: unknown names dropped and `subagent` / `list_agents` stripped so
    /// no layer grants a child a delegation route. Without the verbatim column
    /// the user could not see what the file actually said.
    #[test]
    fn the_file_column_is_verbatim_and_the_effective_column_is_filtered() {
        let mut def = definition("scout", AgentScope::User);
        def.tools = Some(vec![
            "read".to_string(),
            "subagent".to_string(),
            "list_agents".to_string(),
            "no_such_tool".to_string(),
        ]);
        let rows =
            agent_definition_reports(&Settings::default(), std::slice::from_ref(&def), &catalog());
        let row = one_row(&rows);
        assert_eq!(
            row.file.tools,
            Some(vec![
                "read".to_string(),
                "subagent".to_string(),
                "list_agents".to_string(),
                "no_such_tool".to_string()
            ]),
            "the `file` column is the frontmatter untouched"
        );
        assert_eq!(row.effective.tools, Some(vec!["read".to_string()]));
        assert_eq!(row.source.tools, OverrideSource::File);
    }

    /// (ADR 0067) An EMPTY override `tools` list SPEAKS NOT — it falls through
    /// to the file rather than handing the child zero tools. `override` still
    /// shows the stored `[]` (what the file holds) while `effective` shows the
    /// file's list.
    #[test]
    fn an_empty_override_tools_list_speaks_not() {
        let mut def = definition("scout", AgentScope::User);
        def.tools = Some(vec!["bash".to_string()]);
        let rows = agent_definition_reports(
            &settings_with(&[(
                "scout",
                AgentOverrideFields {
                    model: None,
                    thinking: None,
                    tools: Some(Vec::new()),
                },
            )]),
            std::slice::from_ref(&def),
            &catalog(),
        );
        let row = one_row(&rows);
        assert_eq!(
            row.override_.tools,
            Some(Vec::new()),
            "the stored entry is shown as stored"
        );
        assert_eq!(row.effective.tools, Some(vec!["bash".to_string()]));
        assert_eq!(
            row.source.tools,
            OverrideSource::File,
            "an empty override list is ABSENT, so the file's list is what runs"
        );
    }

    /// ADR 0068's label space is `override` / `file` / `parent` and NOTHING
    /// else — pinned by an EXHAUSTIVE match, so a fourth layer (ADR 0066's
    /// per-Space door) is a COMPILE ERROR here rather than a stale comment.
    /// That is the honest way to make "three layers" a fact.
    #[test]
    fn the_source_label_space_is_exactly_three_layers_and_never_space() {
        // The exhaustive match IS the pin: add a variant to `OverrideSource`
        // and this function stops compiling.
        let label = |s: OverrideSource| match s {
            OverrideSource::Override => "override",
            OverrideSource::File => "file",
            OverrideSource::Parent => "parent",
        };
        for s in [
            OverrideSource::Override,
            OverrideSource::File,
            OverrideSource::Parent,
        ] {
            assert_ne!(label(s), "space", "no layer is named after a Space");
            // The wire spellings Task 4's union mirrors.
            let json = serde_json::to_string(&s).unwrap();
            let word = label(s);
            assert_eq!(json, format!("\"{word}\""));
        }

        // And nothing a real row carries escapes the space: a Space-scoped
        // definition still reports one of the three layers.
        //
        // BELT-AND-BRACES, stated honestly: the exhaustive `label` match above
        // is the pin, and a fourth `OverrideSource` variant is a COMPILE failure
        // before any line below runs. These two substring-level checks therefore
        // catch only what a rewrite of that match could hide — a wire spelling
        // that drifted toward a Space word — so they are a cheap regression net,
        // not the thing making "three layers" a fact.
        let rows = agent_definition_reports(
            &settings_with(&[("scout", model_override("fake/m1"))]),
            std::slice::from_ref(&definition("scout", AgentScope::Space)),
            &catalog(),
        );
        let json = serde_json::to_string(&rows[0].source).unwrap();
        assert!(
            !json.contains("space"),
            "`source` never names a Space: {json}"
        );
        assert!(
            rows[0].scope == "space",
            "…while `scope` still legitimately does: {rows:?}"
        );
    }

    /// The camelCase wire contract Task 4's TypeScript is written against.
    /// Note `override_` → `override` (a Rust field cannot be named `override`)
    /// and the always-present nullable fields inside the three column structs.
    #[test]
    fn the_dto_wire_shape_is_the_camel_case_contract_the_modal_reads() {
        let rows = agent_definition_reports(
            &Settings::default(),
            std::slice::from_ref(&definition("scout", AgentScope::User)),
            &catalog(),
        );
        let json: serde_json::Value = serde_json::to_value(&rows[0]).unwrap();
        let row = json.as_object().unwrap();
        for key in [
            "name",
            "description",
            "scope",
            "path",
            "file",
            "override",
            "effective",
            "source",
            "shadowed",
            "filePermission",
            "frontmatterNotes",
        ] {
            assert!(row.contains_key(key), "missing `{key}` in {json}");
        }
        // `override_` speaks as `override` — and NOT as `override_`.
        assert!(
            !row.contains_key("override_"),
            "the trailing underscore is a Rust spelling, not a wire name: {json}"
        );
        // Every column struct carries all four fields, `null` when absent —
        // Task 4 types them `string | null` (and `permission` the block-or-null),
        // so an absent key would be a lie.
        for column in ["file", "override", "effective"] {
            let obj = row[column].as_object().unwrap();
            for key in ["model", "thinking", "tools", "permission"] {
                assert!(
                    obj.contains_key(key),
                    "`{column}.{key}` must be present (null), not absent: {json}"
                );
                assert!(
                    obj[key].is_null(),
                    "`{column}.{key}` should be null: {json}"
                );
            }
        }
        let source = row["source"].as_object().unwrap();
        for key in ["model", "thinking", "tools"] {
            assert_eq!(source[key], serde_json::json!("parent"), "`{key}`: {json}");
        }
        // A file that does not speak about permissions reports `parent` too —
        // there is NO settings.json permission layer, so `permission` is `File`
        // exactly when the block exists and `Parent` otherwise (never `Override`).
        assert_eq!(
            source["permission"],
            serde_json::json!("parent"),
            "`source.permission`: {json}"
        );
        // `frontmatterNotes` is REQUIRED on the wire (the `shadowed` precedent):
        // a file that speaks about nothing still serializes the empty `Vec` as
        // `[]`, never `null` and never an absent key.
        assert_eq!(
            row["frontmatterNotes"],
            serde_json::json!([]),
            "an empty notes vec is `[]` on the wire: {json}"
        );
    }

    /// (issue #101, task05a) THE rot-proof carry test B1's hand-off #2 required:
    /// a definition carrying a declared `permission:` block AND frontmatter
    /// announce notes must land BOTH on the DTO row, and the test asserts on the
    /// SERIALISED ELEMENT (the exact tagged JSON object), not a bare substring —
    /// so a renamed field or a re-tagged `FrontmatterNote` reddens it instead of
    /// passing on an accidental substring match. It FAILS if `frontmatter_notes`
    /// ever stops reaching the DTO: the exact silent-no-op class #101 exists to
    /// fix, re-appearing one wave later.
    #[test]
    fn a_definition_with_permission_and_notes_carries_both_to_the_dto() {
        use crate::agent::definition_permission::{
            Action, FrontmatterNote, PermissionBlock, Rules, ToolKey,
        };
        let block = PermissionBlock {
            tools: vec![(ToolKey::Bash, Rules::whole_tool(Action::Deny))],
        };
        let notes = vec![FrontmatterNote::UnknownKey("mode".to_string())];
        let mut def = definition("scout", AgentScope::User);
        def.permission = Some(block.clone());
        def.frontmatter_notes = notes.clone();
        let rows =
            agent_definition_reports(&Settings::default(), std::slice::from_ref(&def), &catalog());
        let row = one_row(&rows);

        // The declared block is carried VERBATIM (a REPORT — not a verdict).
        assert_eq!(
            row.file_permission,
            Some(block.clone()),
            "the DTO carries the file's declared `permission:` block"
        );
        // …and so are the announce notes, verbatim and in order.
        assert_eq!(
            row.frontmatter_notes, notes,
            "the DTO carries the file-READ announce notes"
        );

        // THE rot-proof half: assert on the SERIALISED ELEMENTS, so the wire
        // SPELLING is pinned too (B1's externally-tagged note object and the
        // snake_case `whole_tool` inside a camelCase parent). A field rename or a
        // serde change makes THIS fail, where `json.contains("mode")` would not.
        let json: serde_json::Value = serde_json::to_value(&rows[0]).unwrap();
        assert_eq!(
            json["frontmatterNotes"],
            serde_json::json!([{"unknownKey": "mode"}]),
            "the notes cross the wire as one tagged object per note: {json}"
        );
        assert_eq!(
            json["filePermission"],
            serde_json::json!({
                "tools": [["bash", { "patterns": [{ "pattern": "*", "action": "deny" }], "whole_tool": true }]]
            }),
            "the block crosses the wire in B1's pinned spelling (`whole_tool` \
             snake_case, `action` lowercase, the ordered tool pairs in file order): {json}"
        );
        // The `file` column shows the same declared block (the row's "what the
        // file said" column), and `source.permission` names the FILE for it.
        assert_eq!(
            json["file"]["permission"], json["filePermission"],
            "the `file` column and `filePermission` are the same declared block: {json}"
        );
        assert_eq!(json["source"]["permission"], serde_json::json!("file"));
        // An EMPTY override has no permission key at all, so that column is null.
        assert!(
            json["override"]["permission"].is_null(),
            "the stored entry has no `permission` key — absence is its only meaning: {json}"
        );
    }

    /// TWO keys that ASCII-fold equal (`"Scout"` beside `scout`) make the
    /// shared selector's `.find` choose in nondeterministic HashMap order.
    /// **This is PRE-EXISTING, NOT sorted, and NOT "fixed" here** — ADR 0066
    /// says the map key case folds and the stored key is never rewritten, and
    /// the UI is the thing that prevents the pair (Task 5's editor drops every
    /// case-fold twin on write). What this test pins is the ONE property that
    /// must hold whichever twin wins: the entry is chosen WHOLESALE, so a
    /// row's `model` / `thinking` never come from two different twins (a
    /// field-by-field merge would be a third identity for the same name).
    #[test]
    fn case_fold_twin_keys_win_wholesale_never_merged() {
        let scout = AgentOverrideFields {
            model: Some("fake/m1".into()),
            thinking: Some("high".into()),
            tools: None,
        };
        let capital = AgentOverrideFields {
            model: Some("fake/m3".into()),
            thinking: Some("low".into()),
            tools: None,
        };
        let rows = agent_definition_reports(
            &settings_with(&[("Scout", capital.clone()), ("scout", scout.clone())]),
            std::slice::from_ref(&definition("scout", AgentScope::User)),
            &catalog(),
        );
        let row = one_row(&rows);
        // Compare in the DTO's own column type (`OverrideFields`, not the
        // stored `AgentOverrideFields`).
        let scout = OverrideFields::from(&scout);
        let capital = OverrideFields::from(&capital);
        let from_scout = row.override_ == scout;
        let from_capital = row.override_ == capital;
        assert!(
            from_scout || from_capital,
            "exactly ONE twin is reported, whole: {:?}",
            row.override_
        );
        assert_eq!(
            row.effective.model, row.override_.model,
            "`effective` follows the SAME twin the `override` column names (both are \
             resolvable here, so a mismatch means the two lookups disagreed)"
        );
        assert_eq!(
            row.effective.thinking, row.override_.thinking,
            "`effective.thinking` follows the SAME twin (a mixed pair means the \
             entry was merged field-by-field)"
        );
    }

    /// #96 task 07: `scratch()` must OWN what it creates. It returned a bare
    /// `PathBuf` and nothing in this module ever removed it — 16 call sites,
    /// 22 dirs per green run, 1584 on disk. Both halves of this assertion are
    /// real wins here: the drop half is the 22-dir GREEN leak being closed, and
    /// the sibling below is the panic path that today cost 22 more.
    #[test]
    fn the_scratch_fixture_removes_its_dir_when_its_owner_is_dropped() {
        let dir = scratch();
        let captured = dir.to_path_buf();
        assert!(captured.is_dir(), "the fixture created its scratch dir");
        drop(dir);
        assert!(
            !captured.exists(),
            "the fixture's scratch goes with its owner: {captured:?}"
        );
    }

    /// The panic path: an assertion that FAILS while the fixture still owns its
    /// scratch must not leave it behind. The guard is MOVED INTO the panicking
    /// scope — that is the value the unwind drops (the `test_support` /
    /// `agent/mcp/oauth.rs` precedent); created outside the closure this would
    /// assert only that `catch_unwind` returned. What this does NOT pin is #96's
    /// headline case — a test failing with its guard as a plain local, so the
    /// HARNESS's own unwind would have to remove the dir — because Rust makes no
    /// portable guarantee there and status-doc D10 gives that case to task 09's
    /// census.
    #[test]
    fn a_panicking_assertion_still_removes_the_scratch_dir() {
        let captured = {
            let dir = scratch();
            let path = dir.to_path_buf();
            assert!(path.is_dir(), "the fixture created its scratch dir");
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                let _held = dir;
                assert_eq!(
                    1, 2,
                    "an assertion fails while the fixture owns its scratch"
                );
            }));
            assert!(r.is_err(), "the assertion failed as arranged");
            path
        };
        assert!(
            !captured.exists(),
            "the unwind ran the removal: {captured:?}"
        );
    }

    /// A unique scratch dir, OWNED (#96 task 07): the dir and everything in it is
    /// removed when the guard drops. `scratch()` used to hand back a bare
    /// `PathBuf` and NOTHING in this module ever removed it — 16 call sites,
    /// 22 executions per run, 1584 of them on disk. NOT `Clone`: `to_path_buf()`
    /// is the escape hatch for a call site that needs an owned `PathBuf`.
    fn scratch() -> crate::test_support::ScratchDir {
        crate::test_support::ScratchDir::in_env_temp("archimedes-cmd-agents-", "scratch")
    }
}
