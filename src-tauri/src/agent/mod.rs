//! The native agent harness: the in-process `AgentLoop` session core —
//! drive the session lifecycle, the interactive channel, the subagent
//! manager.

pub mod boundary;
pub mod childproc;
pub mod crashlog;
pub mod debuglog;
pub mod definition_permission;
pub mod errors;
pub mod events;
mod fs_backend;
pub mod harness;
pub mod hostenv;
pub mod ids;
pub mod interactive;
pub mod mcp;
mod normalize;
mod permission;
pub mod persist;
pub mod policy;
pub mod provider_auth;
mod session;
pub mod subagent;
pub mod todo;
pub mod tools;
pub mod types;
pub mod web;
pub mod worker;

pub use crate::types::SessionInfo;
pub use definition_permission::{
    Action, FrontmatterNote, PermissionBlock, Rule, Rules, ToolKey, UnsupportedReason,
};
pub use errors::{AgentsError, FilesError, McpError, SessionError, SettingsError, SpacesError};
pub use events::{EventSink, RpcEvent};
pub use fs_backend::{FsBackend, FsError};
pub use ids::{GateKey, RequestId, SessionId};
pub use interactive::{
    interactive_key, CachedPassword, PendingInteractive, PendingSudo, RealSudoRunner, SudoRun,
    SudoRunner,
};
pub use normalize::{is_bookkeeping_message_id, normalize_capabilities};
pub use permission::{permission_key, PendingPermissions, PermissionOutcome};
pub use persist::TranscriptPersister;
pub use session::{
    user_message_payload, ClosedReason, EffectiveCatalog, ImagePayload, ProviderFactory,
    SessionManager, SessionManagerBuilder, StalledInfo, StopReason, MAX_IMAGE_BYTES,
};
pub use subagent::{
    AgentNameResolution, LaunchConfig, SubagentMetrics, SubagentOutcome, SubagentSessionManager,
};
pub use todo::{TodoItem, TodoStatus, TodoStore};
pub use tools::{ContentBlock, ImageRef, ToolCtx, ToolResult};
