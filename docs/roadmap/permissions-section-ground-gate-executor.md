# Re-grounding report — T03: enforce precedence rows 1–4 at the gate and executor (default rule set frozen per session)

Branch `feature/permissions-section` at `4395bed` (Waves 1–2 landed: T01 `c90f5dd`, T02 `140c4a2`). This report REPLACES the prior report at `a17ba4b` and grounds the T03 area only: `agent/harness/loop.rs`, `loop/gate.rs`, `tools/exec/access.rs`, `tools/exec/tests/policy.rs`, `tools/types.rs`, `tools/sandbox.rs`, `loop/tests/{policy_gate.rs,param_rejection.rs}`. All quotations are verbatim from the current tree; symbols are named, positions are by symbol (the tree has no file:line convention).

---

## 0. The spec contract T03 implements (from `docs/roadmap/permissions-section.md`)

The precedence table for a **path-param tool**:

| # | Condition | Outcome | Trust-immune |
|---|---|---|---|
| 1 | A rule matches, `decision: deny` | tool-result error | **Yes** |
| 2 | A rule matches, `decision: allow` | proceed silently | n/a |
| 3 | No rule matches **and** the target is under an agent-definition dir | **ASK** | No (it is an ask) |
| 4 | No rule matches | fall through to the posture select | as today |

**Step 3 is the only behavioural change in this spec**: today's hardcoded deny becomes an ask. Rows 1, 2 and 4 are additive — rules change nothing until the user adds one, and the posture stays open.

Scope: rules apply to `read` / `write` / `edit` / `grep` / `glob`. **They never apply to `bash`.** The shell keeps its own posture select and its Landlock confinement under `Sandboxed`. (Note: the gate's `POLICIED_TOOLS` names `bash`, `read`, `find`, `grep`, `ls`, `write`, `edit` — there is no `glob` tool; `find` is the glob/search tool in this tree. The spec's "`glob`" maps to the policed `find`.)

Matching is `rule_for`: filter (genuine component prefix) → rank (longest canonical prefix) → tie-break (last rule wins, list order = `default_rules()` FIRST, user rules SECOND — the concatenation contract).

---

## 1. `gate.rs` NOW — the full protected-check + `deny_tool_result` flow after T02

### 1.1 `POLICIED_TOOLS` and `PolicyDirection` (gate.rs)

```rust
pub(super) const POLICIED_TOOLS: &[(&str, PolicyDirection)] = &[
    ("bash", PolicyDirection::Shell),
    ("read", PolicyDirection::Read),
    ("find", PolicyDirection::Read),
    ("grep", PolicyDirection::Read),
    ("ls", PolicyDirection::Read),
    ("write", PolicyDirection::Write),
    ("edit", PolicyDirection::Write),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PolicyDirection {
    /// Judged against the read boundary; policy `reads`.
    Read,
    /// Judged against the session `cwd`; policy `writes`.
    Write,
    /// No path: always `beyond`; policy `shell`.
    Shell,
}

pub(super) fn policed_direction(tool: &str) -> Option<PolicyDirection> {
    POLICIED_TOOLS
        .iter()
        .find(|(name, _)| *name == tool)
        .map(|(_, dir)| *dir)
}
```

### 1.2 `policy_verdict` — where `rule_for` must be consulted

```rust
pub(super) fn policy_verdict(&self, tc: &ToolCall) -> Option<Decision> {
    let dir = policed_direction(&tc.name)?;
    let (policy, beyond) = match dir {
        PolicyDirection::Shell => {
            // No path to judge: a command can reach ANYWHERE, so it is
            // always beyond the boundary (see `decision_for`).
            (self.file_policy.shell, true)
        }
        PolicyDirection::Read | PolicyDirection::Write => {
            let Some(raw) = tc.arguments.get("path").and_then(|v| v.as_str()) else {
                // `read` / `write` / `edit` REQUIRE a path (the executor
                // rejects the call without one) and the directory tools
                // default it to the `cwd` — either way there is nothing
                // to gate.
                return Some(Decision::Allow);
            };
            let policy = self.direction_policy(dir);
            let beyond = self.beyond_error(dir, Path::new(raw)).is_some();
            (policy, beyond)
        }
    };
    let trusted = self
        .trust
        .as_ref()
        .map(|t| t.is_trusted(&self.space_cwd))
        .unwrap_or(false);
    Some(decision_for(
        policy,
        beyond,
        trusted,
        dir == PolicyDirection::Shell,
    ))
}
```

`policy_verdict` currently computes `(policy, beyond)` then hands straight to `decision_for` — **`rule_for` is never called anywhere in gate.rs** (verified: the only callers of `rule_for` / `default_rules` in the whole crate are `boundary.rs`'s `protected_dirs()` derivation and `policy.rs`'s own tests; `grep` for `rule_for`/`default_rules` outside `policy.rs`/`boundary.rs` returns nothing). T03's insertion point is here: after `beyond` is known for a `Read`/`Write` call, before `decision_for` — consult `rule_for` and implement rows 1–3, falling through to `decision_for` for row 4.

Per-row status today (which rows have ANY code path):

- **Row 1 (rule deny → tool-result error)**: NO `rule_for`-driven code path. The closest existing machinery is the deny-list: the executor refuses unconditionally via `protected_refusal`/`protected_refusal_text` (see §4) and the gate's `deny_tool_result` words the *gate-side* refusal for `Write` via `protected_refusal_text(&self.protected, &tc.name, path)`. But neither is rule-driven — `self.protected` is the frozen `boundary::protected_dirs()` path list, not `rule_for`'s `Vec<AccessRule>`. A user-added `deny` rule for a NON-protected dir has zero effect today.
- **Row 2 (rule allow → proceed silently)**: NO code path. Under the default `Allow` posture almost everything is already silent, but not because a rule says so.
- **Row 3 (no rule + under agent dir → ASK)**: **PURE SPEC.** Nothing in the current tree can emit a prompt for a protected dir: under `writes: Allow` the verdict is `Allow`, `dispatch_tool` runs, and the **executor** refuses (no prompt); under `Sandboxed` the gate's `deny_tool_result` refuses (no prompt). There is no path from a protected write to `gate_tool`. This is the seam T02's comment names (see §6).
- **Row 4 (no rule → posture select)**: **HAS a code path today** — `decision_for` is exactly the posture select and runs for every policed call. This row is "as today" and needs no new wiring beyond making sure `rule_for` returning `None` falls through to it.

### 1.3 `deny_tool_result` — the protected-check flow as it stands

```rust
pub(super) fn deny_tool_result(&self, tc: &ToolCall) -> ToolResult {
    let dir = policed_direction(&tc.name);
    let text = match tc.arguments.get("path").and_then(|v| v.as_str()) {
        Some(raw) => {
            let path = Path::new(raw);
            // The deny-list is a WRITE-floor question (`protected_dirs`
            // are dirs a WRITE may not enter), and it is checked BEFORE
            // the boundary: the refusal is true in every policy, so its
            // wording must win over "escapes the sandbox", which would
            // send the model hunting for a boundary that is not the
            // problem.
            let protected = (dir == Some(PolicyDirection::Write))
                .then(|| protected_refusal_text(&self.protected, &tc.name, path))
                .flatten();
            match protected {
                Some(msg) => msg,
                None => self.escape_text(dir, &tc.name, path, raw),
            }
        }
        // `bash` has no path: the policy simply refused the command.
        None => format!("{}: refused by the file-access policy (Sandboxed)", tc.name),
    };
    ToolResult {
        content: vec![ContentBlock::Text { text }],
        details: None,
        is_error: true,
    }
}
```

The other gate helpers on which T03 builds: `direction_policy` (maps `Read`→`self.file_policy.reads`, `Write`→`self.file_policy.writes`, `Shell`→`self.file_policy.shell`), `direction_boundary` (`Read|Shell` → `self.read_boundary.clone()`, `Write` → `vec![self.space_cwd.clone()]`), `beyond_error` (the single `FsBackend::validate`-based canonicalize-then-check shared with the executor), and `escape_text` (wraps `FsError::PathEscape { path }` as `"{tool}: {body}"`).

---

## 2. The guard ASK plumbing — what row-3 must reuse

### 2.1 `Decision` — verbatim (policy.rs)

```rust
/// What the GATE does with one tool call (the return of
/// [`decision_for`]) — the four outcomes of the ADR 0030 policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Run the tool as-is.
    Allow,
    /// Prompt via the existing `gate_tool`.
    Ask,
    /// Reject with a tool-result error; never a prompt.
    Deny,
    /// Run, but inside the OS sandbox (Task 5). Produced ONLY for `bash`.
    Confine,
}
```

**`Ask` already exists as a concept and maps to the boundary prompt today.** Row 3's ask is the *same* `Decision::Ask` → the *same* `gate_tool` corridor — what changes is only (a) which `Decision` `policy_verdict` returns for a protected write, and (b) which option list the prompt emits (boundary vs guard).

### 2.2 The gate call path — `turn.rs` `run_tool_batch`

```rust
match self.policy_verdict(tc) {
    Some(Decision::Ask) => {
        if self.gate_tool(tc, turn).await {
            self.dispatch_tool(tc, turn).await
        } else {
            ToolResult {
                content: vec![ContentBlock::Text {
                    text: "permission denied".to_string(),
                }],
                details: None,
                is_error: true,
            }
        }
    }
    Some(Decision::Deny) => self.deny_tool_result(tc),
    _ => self.dispatch_tool(tc, turn).await,
}
```

### 2.3 `gate_tool` — the prompt producer (verbatim, the post-T02 form)

```rust
pub(super) async fn gate_tool(&self, tc: &ToolCall, turn: &CancellationToken) -> bool {
    let outcome = native_permission_gate(
        &self.session_id,
        &tc.id,
        &permission_title(&tc.name, &tc.arguments),
        &self.sink,
        &self.pending_permissions,
        self.trust.as_deref(),
        &self.space_cwd,
        turn,
    )
    .await;
    matches!(
        outcome,
        PermissionOutcome::Selected { option_id, .. }
            if option_id == "allow" || option_id == "trust-space"
    )
}
```

The chain: `gate_tool` → `native_permission_gate(session_id, request_id=tc.id, title=permission_title(&tc.name, &tc.arguments), sink, pending_permissions, trust, cwd=space_cwd, cancel=turn)` → (untrusted only) registers a `PendingPermissions` oneshot keyed `"{session_id}/{request_id}"`, emits a `permission-request` sink event with `options = permission_options(true)`, awaits the oneshot against the turn token, returns `PermissionOutcome`.

`permission_title` (permission.rs — the prompt's title): builds `"{tool} {path}"` for `read|write|edit`, `"{tool} {pattern} in {dir}"` for `find|grep`, `"ls {dir}"`, `"bash {command}"`, else `"{tool} {args}"` — "the user is approving ONE access, so the title names the thing being reached for".

`PermissionOutcome` (permission.rs, verbatim):

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOutcome {
    Selected {
        option_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
    Cancelled,
}
```

`permission_options(boundary: bool) -> Vec<serde_json::Value>` (permission.rs): `boundary: true` → the old three (`allow` "Allow" / `reject` "Block" / `trust-space` "Don't ask again for this Space"); `boundary: false` → the guard's three (`allow` "Allow once" / `allow-directory` "Always allow this directory" carrying `"path": ""` — the PLAHOLDER, "the real nearest-existing-ancestor path is computed at the guard's call site (Task 3), whose prompt signature carries the target path that `native_permission_gate`'s does not" / `reject` "Block"), with `trust-space` DELIBERATELY ABSENT. **`native_permission_gate` today emits only `permission_options(true)`** — its own comment: "this gate emits the BOUNDARY set, the only kind it produces until Task 3 adds the guard's caller".

### 2.4 What a row-3 ask must REUSE

- The `Decision::Ask` → `gate_tool` corridor (§2.2) — unchanged.
- `native_permission_gate` — unchanged, BUT it takes no path argument and hardcodes `permission_options(true)`. T03 facts: the guard prompt must (a) emit `permission_options(false)`, (b) replace the `""` placeholder `path` with the real nearest-existing-ancestor path of the target (the `value` that rides to the Supervisor for T04). That means either a new/parameterized prompt fn or a second caller path — the seam comment (§6) says the contract is: when the guard ask reaches `gate_tool`, "the prompt offers `allow` / `allow-directory` / `reject` (see `permission_options(false)`), and `allow-directory` must become an allow id HERE".
- The approve predicate must gain `allow-directory` (currently only `allow` / `trust-space` — §6, pin `a_guard_allow_directory_runs_the_tool`).
- `permission_title` can be reused verbatim for the guard title (it already renders the target path).
- The nearest-existing-ancestor computation: the target's deepest existing ancestor — the same peel `canonicalize_lenient` performs (`fs_backend.rs`, `pub(crate)`) — is the value row 3 must carry. Facts only: the canonicalizer is `crate::agent::fs_backend::canonicalize_lenient(path) -> PathBuf`, already used by `rule_for`, `protected_dirs`, and `protected_refusal_text`.

---

## 3. The freeze matrix as it stands — what T03 must freeze

### 3.1 `AgentLoop::new` frozen values (loop.rs)

```rust
// (ADR 0030) The boundary is computed ONCE here, not per tool call
// (it is frozen for the session, and `read_roots` walks the tree +
// canonicalizes). Reading `$HOME` is legitimate HERE — the Worker
// process already does it for MCP and for skill discovery.
let read_boundary = crate::agent::boundary::read_roots(&space_cwd);
let protected = crate::agent::boundary::protected_dirs();
```

assigned to fields:

```rust
/// (ADR 0030) The session's READ boundary — `cwd` + the discovery roots
/// (user + space level), computed ONCE at construction (the boundary is
/// frozen for the session's life: a skill dir created mid-session must
/// not silently widen it). Handed to every `ToolCtx`.
read_boundary: Vec<PathBuf>,
/// (ADR 0030) The write DENY-LIST (`boundary::protected_dirs()` — the
/// user-level agent-definition dirs), frozen with the boundary.
protected: Vec<PathBuf>,
```

Both computed in `new` (via `boundary::read_roots` / `boundary::protected_dirs`, which read `$HOME`), frozen for the session's life, handed to every `ToolCtx`.

### 3.2 The per-turn `file_policy` re-read (loop.rs `handle_prompt`)

```rust
// (ADR 0030 Deviation 4) The policy and web config are
// re-read from `settings.json` ONCE per turn — the same in-process read
// `launch.rs` does per dispatch, so a user who flips a select in
// Settings affects an ALREADY-RUNNING session at its next prompt
// (no restart, no relaunch). ONE read per turn (not per tool call):
// every tool call in a turn must agree, or a half-asked batch would
// be a policy the user never chose. `config_dir: None` → the
// all-`Allow` default (no settings layer) + env-only web config.
let settings = self.config_dir.as_deref().map(crate::config::load_settings);
self.file_policy = settings
    .as_ref()
    .map(|s| s.file_policy.clone())
    .unwrap_or_default();
```

`self.file_policy.rules` (the USER rules half) therefore refreshes per turn, exactly like `reads`/`writes`/`shell`. The field doc: "The file-access policy IN FORCE for the current turn — refreshed from `settings.json` at the top of every `handle_prompt` (Deviation 4: one read per turn, so every tool call in a turn agrees and a mid-turn hand-edit is observed at the NEXT prompt …" — "Handed to every `ToolCtx` so the executor enforces the SAME tier the gate decided, and read by the gate itself."

### 3.3 The per-call `ToolCtx` clone (loop/tools.rs `dispatch_tool`)

```rust
execute_tool(
    &ToolCtx {
        cwd: self.space_cwd.clone(),
        cancel: turn.clone(),
        // `None` = the real discovery roots (the same
        // `discover_skills` the prompt builder used).
        skill_roots: None,
        // (ADR 0030) The frozen boundary + deny-list.
        boundary: self.read_boundary.clone(),
        protected: self.protected.clone(),
        // (ADR 0030 Task 3) The policy the gate decided with
        // — the SAME per-turn value, so the executor cannot
        // re-decide differently from the gate (it enforces
        // the `Sandboxed` floor and confines `bash`).
        file_policy: self.file_policy.clone(),
        web: self.web.clone(),
        render_requester: self.render_requester.clone(),
    },
    &tc.name,
    &tc.arguments,
)
```

### 3.4 What T03 must freeze — the decision, stated as facts

The task brief says "**default rule set frozen per session**". The mechanics:

- `rule_for(rules: &[AccessRule], direction: RuleDirection, path: &Path, home: Option<&Path>) -> Option<&AccessRule>` takes the rule LIST and `home` as arguments — it reads no env itself.
- `default_rules() -> Vec<AccessRule>` calls `skills::user_roots()` and `agents::user_roots()`, which call `skills::home_dir()` (`HOME` → `USERPROFILE` → `std::env::home_dir()`) and canonicalize — NOT free, and `$HOME`-dependent.
- The USER rules half (`self.file_policy.rules`) is per-turn by Deviation 4; only the DEFAULT half can be frozen in `new` without contradicting the per-turn re-read. The load-bearing ordering contract (`default_rules()` FIRST, user rules SECOND — the exact-tie, last-wins mechanism) means the two halves must be concatenated in that order at evaluation time.

So the honest decision space T03 must choose between (facts, both viable):
- **(A) Freeze `default_rules()` once in `AgentLoop::new`** (mirroring `read_boundary`/`protected`), keep a field like `default_rules: Vec<AccessRule>`, and at each verdict concatenate `self.default_rules ++ self.file_policy.rules` into the `rule_for` call. Matches "default rule set frozen per session" literally; user-rule edits still land next turn.
- **(B) Derive `default_rules()` per verdict** — no freeze, simplest code, but it re-reads `$HOME` and re-canonicalizes four paths on every policed call, and contradicts "frozen per session" if a discovery dir changes mid-session (the same reasoning that froze `read_boundary`).

Either way **`ToolCtx` must carry the rule set AND the home** for the executor side (§4): `rule_for` needs `home` for `~` expansion, and `ToolCtx` currently has no home field and no rules field.

### 3.5 `ToolCtx` current fields — verbatim (tools/types.rs)

```rust
pub struct ToolCtx {
    /// The session's `cwd` — the sandbox boundary.
    pub cwd: PathBuf,
    /// Cancelled when the tool's AbortSignal fires (kills the `bash` child).
    pub cancel: CancellationToken,
    /// The skill roots the `list_skills` / `read_skill` tools resolve
    /// against. …
    pub skill_roots: Option<Vec<(PathBuf, crate::skills::SkillScope)>>,
    /// (ADR 0030) The read boundary (frozen at session start; `vec![cwd]` in
    /// tests — hermeticity: NEVER call `boundary::read_roots` here, it reads
    /// `$HOME`).
    pub boundary: Vec<PathBuf>,
    /// (ADR 0030) The policy in force for this call.
    pub file_policy: crate::agent::policy::FilePolicy,
    /// (ADR 0030) The write deny-list (`boundary::protected_dirs()`, frozen
    /// at session start; `vec![]` in tests).
    pub protected: Vec<PathBuf>,
    /// The web tools' configuration for this turn (Task 1). …
    pub web: crate::agent::web::config::WebConfig,
    /// Render requester for escalated headless webview fetches (Task 7).
    pub render_requester: Option<std::sync::Arc<dyn crate::agent::web::RenderRequester>>,
}
```

`derive(Clone)` — no `Copy`. Absent: any `home` and any `rules` field. T03 must add at least one of them (facts; the plan agent decides the shape). Note the test-building convention: every test `ToolCtx` in `exec/tests/support.rs::ctx`, `sandbox.rs::confined_ctx`, and `policy.rs`'s tier tests constructs the struct literally, so a new field ripples to all of them (they can use `..ctx(&cwd)` / struct-update syntax in most spots; `confined_ctx` builds all fields literally).

Also relevant: `AgentLoop` does NOT store the home. `dirs::home_dir()` is read in `new` only to construct `McpManager`, then discarded. If T03 freezes or evaluates rules in the loop it needs its own home source — `crate::skills::home_dir()` (the `pub(crate)` chain `HOME` → `USERPROFILE` → `std::env::home_dir()`, skills.rs) is the crate's canonical home for the discovery dirs, and is exactly what `default_rules()`/`protected_dirs()` go through.

---

## 4. The executor side — `access.rs` as it stands (T01 left the wording)

### 4.1 `protected_refusal` / `protected_refusal_text` (access.rs)

```rust
pub(crate) fn protected_refusal(ctx: &ToolCtx, tool: &str, resolved: &Path) -> Option<String> {
    protected_refusal_text(&ctx.protected, tool, resolved)
}
```

`protected_refusal_text(protected: &[PathBuf], tool: &str, resolved: &Path) -> Option<String>` — the full doc is long; the load-bearing facts:
- Both sides compared through `canonicalize_lenient` (issue #92: entries may name dirs that don't exist yet; the compared path may be a raw gate argument). `hit` stays the CALLER's entry so the message names the dir as registered.
- The refusal sentence (verbatim): `"{tool}: {} is a protected agent-definition directory ({}) — writing there is refused in every policy. {PROTECTED_WRITE_ROUTE}"` where `{}`s are the canonicalized resolved path and the matched entry.
- `PROTECTED_WRITE_ROUTE` (verbatim): `"This is by design: these directories are the agent's own instructions. Write the file under your session directory instead and ask the user to move it into place (the `ask` tool)."` — asserted (not `contains`-ing `sudo`/`bash`/`shell`) by the executor test `write_into_a_protected_dir_is_refused_under_every_policy`.

### 4.2 The `write`/`edit` call sites (exec/fs_tools.rs)

`exec_write`:

```rust
let backend = write_backend(ctx);
let resolved = match backend.validate(Path::new(&path)) {
    Ok(p) => p,
    Err(e) => return ToolResult::fail(format!("write: {e}"), None),
};
// The deny-list (ADR 0030): unconditional, independent of `roots`.
if let Some(msg) = protected_refusal(ctx, "write", &resolved) {
    return ToolResult::fail(msg, None);
}
```

`exec_edit`: identical shape with `"edit"`: `let backend = write_backend(ctx);` → `validate` → `// The deny-list (ADR 0030): an edit is a write.` → `if let Some(msg) = protected_refusal(ctx, "edit", &resolved) { return ToolResult::fail(msg, None); }`.

There is **no** `protected_refusal` in `exec_read` — the deny-list is a WRITE-floor question only.

### 4.3 `executor_roots` (boundary.rs) — the write backend roots

```rust
pub fn executor_roots(cwd: &Path, boundary: &[PathBuf], policy: AccessPolicy) -> Vec<PathBuf> {
    match policy {
        AccessPolicy::Sandboxed => boundary.to_vec(),
        AccessPolicy::Ask | AccessPolicy::Allow => {
            let base = canon(cwd).unwrap_or_else(|| cwd.to_path_buf());
            let mut roots = vec![base];
            roots.extend(unrestricted_floor());
            roots
        }
    }
}
```

`read_backend(ctx)`: roots = `executor_roots(&ctx.cwd, &ctx.boundary, ctx.file_policy.reads)`. `write_backend(ctx)`: roots = `executor_roots(&ctx.cwd, std::slice::from_ref(&ctx.cwd), ctx.file_policy.writes)` — i.e. the write boundary is the cwd ONLY (user-level agent dirs are refused by `ctx.protected` regardless).

### 4.4 What changes if a rule ALLOWs a protected dir (today's unconditional refusal — the proof)

The proof of unconditionality is access.rs's own doc, verbatim:

> The DENY-LIST is not one of the things the policy moves: both executors call [`protected_refusal`] unconditionally, straight after `validate` and with no test of `ctx.file_policy.writes`, so a protected write is refused by the EXECUTOR in every mode — `writes: Allow` included.

And in `protected_refusal_text`'s doc:

> under `Allow` the gate's copy of this function is not even reached — the verdict is `Allow`, so `dispatch_tool` runs and `deny_tool_result`, which only answers a `Deny`, never fires.

So today a write into a protected dir under `writes: Allow`: gate verdict `Allow` → `dispatch_tool` → `write_backend` roots = `[cwd, /]` → `validate` passes → `protected_refusal` fires → refusal. **The executor-side refusal is policy-independent and `rule_for`-independent.** A T03 `allow` rule for a protected dir therefore requires the executor to CONSULT rules (rows 1–2) BEFORE or INSTEAD of the unconditional `protected_refusal` — otherwise rule row 2 can never take effect against the four default dirs (this is exactly what the spec's ADR 0083 narrowing addresses: the refusal "for the four agent dirs from an absolute to a rule-relative one — the dirs stay protected as long as the default rules hold, since the rule layer is append-only"). Facts only: the executor refusal is unconditional today, the `writes: Allow` path is the only one that reaches it from the gate, and `edit` (a write) is refused identically.

### 4.5 What changes if a rule DENies a NON-protected dir

Today the executor has no rule awareness at all: a deny for a dir outside the four defaults matches nothing in the executor, and (under `Allow` posture) the gate verdict is `Allow` too, so the write or read succeeds. Row 1 (tool-result error) for a non-protected dir therefore needs the executor to consult `rule_for` and refuse with a useful message — the spec: "`protected_refusal_text` keeps its wording for the `deny` case (row 1), because a denied write must still explain *why* rather than say 'escapes the sandbox'". The row-1 wording decision (reuse `protected_refusal_text`-style sentence vs a new rule-deny wording) is T03's; the existing refusal text is the floor wording the spec says to keep.

### 4.6 Note on the gate/executor one-resolver rule

The module doc of policy.rs is the contract: "per ADR 0029/0030's one-canonicalizer rule the gate and the executor must both go through [`rule_for`], never a second matcher." So T03 must not reimplement rule matching in either layer — both consult `rule_for` with the same concatenated rule list and the same `home`.

---

## 5. `sandbox.rs` — the third consumer (rules never apply to `bash`)

### 5.1 Current `protected_dirs()` usage in `Sandbox::create`

```rust
// The write boundary (minus the protected dirs) + the temp dirs.
let write_roots = crate::agent::boundary::write_roots(cwd);
if write_roots.is_empty() {
    return Err(format!(
        "the session boundary {} cannot be canonicalized",
        cwd.display()
    ));
}
let protected: Vec<PathBuf> = crate::agent::boundary::protected_dirs();
for dir in write_roots {
    sandbox.rule_write_root(&dir, &protected, true)?;
}
for tmp in TEMP_DIRS {
    sandbox.rule_write_root(&PathBuf::from(tmp), &protected, false)?;
}
```

`Sandbox::create(cwd: &Path)` — note the signature takes only `cwd`, NOT a `ToolCtx`. It is called from `exec_bash` (exec/bash.rs:156) as `crate::agent::tools::sandbox::Sandbox::create(&ctx.cwd)` — the ONLY production call site. The sandbox therefore cannot see `ctx.file_policy` or any rules T03 adds to `ToolCtx` without a signature change (facts: the call passes `&ctx.cwd` only; bash.rs's `confined` flag is `ctx.file_policy.shell == Sandboxed`, decided before `Sandbox::create`).

### 5.2 The subtraction code — `rule_write_root` (verbatim)

```rust
fn rule_write_root(
    &mut self,
    root: &Path,
    protected: &[PathBuf],
    required: bool,
) -> Result<(), String> {
    if protected.iter().any(|p| root == p || root.starts_with(p)) {
        return self.add_path(root, READ_EXECUTE, required);
    }
    // Compare CANONICAL paths: `protected_dirs` is canonicalized, and a
    // write root that reaches a protected dir through a symlink is just
    // as protected (the child reaches the same inode).
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if protected.iter().any(|p| canonical.starts_with(p)) {
        return self.add_path(root, READ_EXECUTE, required);
    }
    // (2) Nothing to carve out (the common case): full read-write.
    if !protected.iter().any(|p| p.starts_with(&canonical)) {
        return self.add_path(root, READ_WRITE, required);
    }
    // A protected dir lives somewhere under `root`: walk the chain and
    // rule every sibling read-write.
    self.rule_root_around_protected(&canonical, protected, required)
}
```

### 5.3 The fact T03 must decide: what happens if `protected_dirs()` becomes rule-derived AND the user ADDS an allow rule for a protected dir

`protected_dirs()` today is the derived view of `default_rules()`'s `Deny` rules (boundary.rs):

```rust
pub fn protected_dirs() -> Vec<PathBuf> {
    default_rules()
        .iter()
        .filter(|r| r.decision == RuleDecision::Deny)
        .map(|r| {
            let raw = std::path::Path::new(r.path.as_str());
            crate::agent::fs_backend::canonicalize_lenient(raw)
        })
        .collect()
}
```

If T03 (or any change) makes `protected_dirs()` rule-derived — e.g. filtering `default_rules() ++ user rules` for `Deny`, or feeding it a widened rule set — then an appended user `allow` rule for a protected dir makes that dir leave `protected_dirs()`. Consequences today, mechanically:

- `AgentLoop::new`'s `protected` field and `ToolCtx.protected` would silently no longer contain that dir → the gate's `deny_tool_result` wording and the executor's `protected_refusal` stop covering it. That is presumably INTENDED (the allow rule is what makes the dir writable) — but it is a **consequence in the sandbox too**, and the sandbox is the part the spec excludes: **rules never apply to `bash`**.
- Landlock is ADD-ONLY: a `PATH_BENEATH` rule grants on the fd's path AND everything beneath it, and the ruleset is the UNION of the rules — "there is no narrower rule that takes a right back from an ancestor" (module doc, verbatim). The subtraction is the ONLY way the four dirs stay unwritable inside the write roots; if `protected` (the list `Sandbox::create` subtracts) stops containing a dir, `rule_write_root`'s three cases no longer carve it out, and **the write list for a confined `bash` silently widens to include that dir** — every sibling along the chain or the whole root gets `READ_WRITE` ("The tree stays writable everywhere but the protected subtree").
- The spec's principle (§0): "They never apply to `bash`… if the user cannot write a path, neither can the shell" — but with an allow rule the USER CAN write the path (via the write tool), so the sandbox widening is arguably consistent with the user's choice. The _facts_ for T03's decision: (a) `Sandbox::create` only receives `&ctx.cwd` today and reads `boundary::protected_dirs()` itself (it cannot be told "the gate allowed this dir" without a signature change); (b) if the deny-list halves and the sandbox's subtraction list come from different sources (frozen `protected` vs rule-derived `protected_dirs`), they drift silently — the ADR 0029 one-resolver lesson applied to the path list; (c) keeping the sandbox subtracting the FULL default deny list (including dirs a user rule allowed) would keep `bash` stricter than the tools, which is the "guard-rail" posture but contradicts the principle that a confined command's reach not be artificially narrowed relative to the tools. The decision (freeze the default four in `Sandbox::create` regardless of user rules, vs derive from the same rule list the tools use) is T03's; this report gives the mechanics, not the choice.

---

## 6. T02's seam comment in `gate.rs` — the pin T03 MUST land (verbatim)

From `gate_tool`'s doc comment (added by 140c4a2):

```rust
/// THE GUARD-PROMPT SEAM: the guard ask (Task 3) reaches `gate_tool`
/// ONLY if the precedent wiring sends protected writes to `Ask` — that
/// verdict is Task 3's. When it does, the prompt offers `allow` /
/// `allow-directory` / `reject` (see `permission_options(false)`), and
/// `allow-directory` must become an allow id HERE — Task 3's contract
/// names the loud pin `a_guard_allow_directory_runs_the_tool` (the
/// `value` rides to the Supervisor, which persists it — Task 4). Both
/// extensions are recorded in Task 2's plan; this gate stays
/// boundary-only until they land.
```

So the named loud pin is **`a_guard_allow_directory_runs_the_tool`**, and it must wire:
1. `policy_verdict` returning `Decision::Ask` for a protected write with no matching rule (row 3) — the "precedent wiring".
2. The approve predicate extension: `gate_tool`'s `matches!` must accept `option_id == "allow-directory"` as an allow (alongside `allow` / `trust-space`), so an `allow-directory` click does not silently deny.
3. The prompt must emit the guard option list (`permission_options(false)`) with the real resolved `path` in `allow-directory`'s `path` slot (the `value` the Supervisor persists — T04).

The subtask file `permissions-section-task02-wire-shape-guard-prompt.md` states it as a commit-time requirement: "T03's plan MUST extend the predicate and land the pin".

---

## 7. Test inventory — `policy_gate.rs` after T02, `param_rejection.rs`'s protected-home setup, and `exec/tests/policy.rs`

### 7.1 `policy_gate.rs` (the `AgentLoop`-level gate tests)

The `answer_permission` helper's NEW signature (verbatim) — it now takes `session: &str` (prefix-matches the pending key) and resolves `Selected` with `value: None`:

```rust
/// Await the loop's pending-permission entry and answer it (the mock
/// handle-free waiter — the `tests/harness_loop.rs` pattern, the
/// `pending` map being a `pub` field). Spawned BEFORE the prompt so a
/// gate that must NOT prompt can never hang the test.
async fn answer_permission(pending: PendingPermissions, session: &str, option: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let mut map = pending.lock().await;
        if let Some(key) = map
            .keys()
            .find(|k| k.starts_with(&format!("{session}/")))
            .cloned()
        {
            let sender = map.remove(&key).expect("the entry is in the map");
            let _ = sender.send(PermissionOutcome::Selected {
                option_id: option.to_string(),
                value: None,
            });
            return;
        }
        drop(map);
        if tokio::time::Instant::now() >= deadline {
            return; // the test asserts no prompt arrived
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
```

T03's `allow-directory` tests will need this helper to send `value: Some(path)` — that is exactly the injection shape the `allow-directory` value must arrive as (facts).

Other helpers T03 reuses:
- `policy_settings(reads, writes, shell) -> String` — builds `{ "filePolicy": { "reads": …, "writes": …, "shell": … } }` (NO `rules` key — T03 must extend it or write rules JSON side-by-side).
- `build_policy_loop(provider, events, sink, settings: Option<&str>) -> (ScratchDir, AgentLoop, Option<Tmp>)` — creates a temp `config_dir` with the `settings.json`, pins nothing itself; the CALLER pins `$HOME` first (`Tmp::new` + `env_lock` + `RestoreHome`, the pattern every test opens with) so `AgentLoop::new`'s `read_roots`/`protected_dirs` see an empty scratch home. Returns the guard FIRST tuple element (#96), then the loop, then the config dir (`Option<Tmp>` must OUTLIVE the loop — the loop re-reads the file every turn).
- `read_call(id, path) -> ToolCall`, `bounded_prompt(&mut AgentLoop, text)` (30 s timeout — "a gate that regressed into prompting on a turn nobody answers would otherwise hang the suite"), `permission_requests(&[(String, Value)]) -> Vec<Value>`, `tool_ends(&mut UnboundedReceiver<RpcEvent>) -> HashMap<String, (Value, bool)>`.

The current test inventory (all pass at 4395bed): `ask_beyond_the_boundary_prompts_naming_the_path_then_runs`, `sandboxed_beyond_the_boundary_errors_with_no_prompt`, `the_default_policy_reads_and_writes_beyond_the_boundary_in_silence`, `a_settings_edit_between_prompts_changes_the_next_turns_gating`, `a_sandboxed_shell_dispatches_confined_with_no_prompt`, `a_gate_denial_of_a_protected_dir_uses_the_protected_wording` (the RAW-vs-CANONICAL symlink fixture at the GATE seam), `a_recreated_protected_dir_is_refused_by_the_gate_without_a_new_session`, `a_trusted_space_suppresses_the_prompt_the_policy_would_raise` (reads `loop_.policy_verdict(&tc)` directly — the direct-verdict injection pattern T03 will use for rule verdict pins), `the_skill_tools_stay_outside_the_policy_gate`.

The two protected-dir gate tests are the ones row-3 CONVERTS: they currently assert a protected write is a **Deny with no prompt** under `writes: sandboxed` — under T03, with rules present, the no-rule + agent-dir case becomes an **Ask**; these tests' expectations (and their settings) are T03 churn (facts — the plan decides whether they flip to the guard-ask shape or get replaced by rule-aware pins). Note the fine print in `a_gate_denial_of_a_protected_dir_uses_the_protected_wording`: the FLOOR (the four dirs) is what the wording pins; T03's row-1 wording for a DEFAULT deny preserves this sentence.

### 7.2 `param_rejection.rs` — the protected-home setup T03 reuses

The relevant test is `a_rejected_call_never_reaches_the_permission_gate` — its setup (verbatim essentials):

```rust
// `protected_dirs()` reads `$HOME`; an empty scratch home keeps the
// verdict `Ask` rather than `Deny` (the precedent is
// `the_default_policy_reads_and_writes_beyond_the_boundary_in_silence`).
let home = Tmp::new("reject-home");
let _lock = crate::test_support::env_lock();
let original = std::env::var_os("HOME");
let _restore = RestoreHome(original.clone());
// SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore span;
// no other thread mutates HOME concurrently.
unsafe { std::env::set_var("HOME", home.path()) };
```

plus a local `policy_settings` (re-implemented "because `policy_settings` is private to `policy_gate.rs`, which this module must not edit") and a `build_loop_with_db` with `Some(cfg.path())` then `loop_.sink = Arc::new(RecordingSink { … })` swap. This module also has the `run_tool_batch`-direct injection pattern (`a_cancelled_subagent_call_reports_cancelled_and_not_a_rejection`) — a T03 unit-level alternative to end-to-end turns.

### 7.3 `exec/tests/policy.rs` — the executor side

Context helpers (exec/tests/support.rs, verbatim facts): `temp_cwd(tag) -> ScratchDir`; `ctx(cwd) -> ToolCtx` is HERMETIC — `boundary: vec![cwd]`, `protected: Vec::new()`, policy `Sandboxed`/`Sandboxed`/`Allow`, `rules: Vec::new()` — "this must NEVER derive them from the `$HOME`-reading boundary helpers"; `ctx_policy(cwd, policy)` overrides `file_policy` via struct-update; `can_confine()`; `text_of`.

Current tests: `read_beyond_the_boundary_succeeds_when_reads_allow`, `read_reaches_a_second_boundary_root_when_sandboxed`, `write_beyond_the_boundary_succeeds_when_writes_allow`, **`write_into_a_protected_dir_is_refused_under_every_policy`** (loops `Writes ∈ {Sandboxed, Ask, Allow}`, pins the `PROTECTED_WRITE_ROUTE` ending, asserts `edit` refused too), `write_a_new_file_under_a_protected_dir_is_refused`, `a_raw_protected_entry_still_refuses_a_canonical_path_under_it` (unix symlink fixture), `a_raw_argument_still_refuses_against_canonical_protected_entries` (`#[cfg(unix)]`, direct `protected_refusal_text` call — the direct-call injection pattern), `a_recreated_protected_dir_is_refused_without_a_new_session` + `a_write_into_a_still_missing_protected_dir_is_refused` (session-snapshot #92 pins), `bash_ignores_the_file_boundary`.

The `write_into_a_protected_dir_is_refused_under_every_policy` test is the executor-side analogue of the row-3 conversion: under T03 (rules present), an `allow` rule for a protected dir must land where this test currently refuses for all three postures. The `#92` snapshot tests build `protected` from `boundary::protected_dirs()` and hand it to `ToolCtx { protected, … }` — the same places a frozen rule list would ride.

---

## 8. Scoped commands (verified)

- **The working filter forms are the SUBSTRING forms, NOT `harness::loop::`** — the crate name/keyword `loop` breaks the filter (a `loop` keyword cannot name a test filter). Working forms:
  - `cargo test --lib policy_gate` (module `harness::loop::tests::policy_gate`)
  - `cargo test --lib param_rejection`
  - `cargo test --lib exec::tests::policy` (or `cargo test --lib policy` would also match `policy_gate` + `policy.rs` + `policy.rs` unit tests — the narrow form is `exec::tests::policy`).
  - The `policy.rs` UNIT tests in `agent/policy.rs` and `agent/boundary.rs` match `cargo test --lib policy` / `cargo test --lib boundary`.
- **Integration rings:** `cargo test --no-run` (or `cargo test --no-run --tests`) to compile the `tests/` tree — `tests/harness_loop.rs` (`tool_call_gates_executes_loops_and_settles`) and `tests/worker_e2e.rs` construct `PermissionOutcome::Selected` and only compile under the full `cargo test`, never `--lib` (T02's plan verbatim: "the two files `cargo test --lib` never compiles").
- **`cargo build --all-targets` (or `cargo check --all-targets` for a compile-only pass) BEFORE trusting fixtures** — a green `--lib` run does not compile the `tests/` dir nor the `fake_worker` bin; a `Selected { option_id, .. }`/`value` change that breaks `tests/` or `bin/fake_worker.rs` only surfaces there.
- Clippy (`cargo clippy --all-targets -- -D warnings`) and fmt are the wave gates per the T02 plan; `cargo build --all-targets` is the compile gate.

---

## 9. Risks / facts the plan must not paper over

1. **Row 3 changes the meaning of two green tests.** `a_gate_denial_of_a_protected_dir_uses_the_protected_wording` and `a_recreated_protected_dir_is_refused_by_the_gate_without_a_new_session` pin "protected write = Deny, no prompt" under `writes: sandboxed`. Under T03's rules-present semantics the no-rule+agent-dir case is an Ask (but note: with `writes: sandboxed` and NO rules added, row 4's posture select still yields `Deny` — these tests use the DEFAULT rule set only, so the interplay is: default deny rules are the "under agent dir" floor; `rule_for` returns the DEFAULT `Deny` rule for those dirs, i.e. **row 1 actually fires for the four dirs today**, and row 3 ("no rule matches AND under an agent dir") only applies to agent dirs the default rules DON'T already deny — of which there are none in the current derivation; the distinction between "the default rules ARE the floor" and "the spec's row 3" is exactly what T03 must decide: does a `Deny` from `default_rules()` fire row 1 (tool-result error, as today) while an UNDER-AN-AGENT-DIR path with NO rule (a hypothetical new agent dir not in the four) fires row 3 (ask) — or do the four defaults move to row 3?). The executor-side `write_into_a_protected_dir_is_refused_under_every_policy` pins the same unconditional floor for all three postures.
2. **`ToolCtx` gains fields; every literal `ToolCtx { … }` in the tree must be updated** — exec/tests/support.rs::ctx, sandbox.rs::confined_ctx, policy.rs tier tests, and the loop's tools.rs construction (which is the production source).
3. **`AgentLoop` has no stored home.** Freezing or evaluating rules in the loop needs a home source; `skills::home_dir()` is the crate's canonical chain (`HOME` → `USERPROFILE` → `std::env::home_dir`), and it is `pub(crate)`.
4. **The Landlock drift (§5.3):** if `protected_dirs()` becomes rule-derived and the sandbox subtracts whatever `protected_dirs()` returns, an appended allow rule silently widens the confined `bash` write set. The spec says rules never apply to `bash`; the sandbox's subtraction list is the enforcement of the four dirs for `bash` — keeping it on the FULL default deny list (not the rule-derived list) is the only way `bash` stays stricter than the tools under an allow rule. Facts only; the choice is T03's.
5. **The `allow-directory` `value` must be the real resolved ancestor path**, computed at the guard's call site (permission.rs's own doc: the `""` in `permission_options(false)` "is a PLACEHOLDER — the real nearest-existing-ancestor path is computed at the guard's call site (Task 3)"). The pin `a_guard_allow_directory_runs_the_tool` cannot pass with `value: None`.
6. **`find` vs `glob`:** the spec's rule scope names `glob`; the gate's `POLICIED_TOOLS` has `find` (the glob/search tool) and no `glob`. The rule direction for `find` is `Read` (it is in the Read group), consistent with the spec's intent.
7. **Concatenation ordering is load-bearing** (`default_rules()` first, user after — the exact-tie last-wins contract, pinned both ways in policy.rs's `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny`). Any T03 freeze/concatenation must preserve it or the `allow-directory` append silently no-ops against the default deny (T04's whole mechanism).

## 10. Sources

All in-tree at `4395bed` on `feature/permissions-section`:
- `src-tauri/src/agent/harness/loop/gate.rs` — `POLICIED_TOOLS`, `PolicyDirection`, `policed_direction`, `policy_verdict`, `direction_policy`, `direction_boundary`, `beyond_error`, `deny_tool_result`, `escape_text`, `gate_tool` + the seam comment (§1, §2, §6).
- `src-tauri/src/agent/harness/loop/turn.rs` — `run_tool_batch`'s Ask/Deny arms (§2.2).
- `src-tauri/src/agent/harness/loop.rs` — `AgentLoop::new` (`read_boundary`/`protected`), `handle_prompt` per-turn re-read, field docs (§3.1–3.2).
- `src-tauri/src/agent/harness/loop/tools.rs` — `dispatch_tool`'s `ToolCtx` literal (§3.3).
- `src-tauri/src/agent/tools/types.rs` — `ToolCtx` (§3.5).
- `src-tauri/src/agent/policy.rs` — `Decision`, `AccessPolicy`, `AccessRule`, `RuleDirection`/`RuleDecision`, `FilePolicy`, `decision_for`, `rule_for`, `default_rules` (§0–§2, §4.6).
- `src-tauri/src/agent/tools/exec/access.rs` — `read_backend`/`write_backend`, `protected_refusal`, `protected_refusal_text`, `PROTECTED_WRITE_ROUTE` (§4.1, §4.4).
- `src-tauri/src/agent/tools/exec/fs_tools.rs` — `exec_write`/`exec_edit` call sites (§4.2).
- `src-tauri/src/agent/boundary.rs` — `protected_dirs()` derivation, `executor_roots`, `write_roots` (§5.3, §4.3).
- `src-tauri/src/agent/tools/sandbox.rs` — `Sandbox::create`, `rule_write_root`, module doc on Landlock add-only subtraction (§5).
- `src-tauri/src/agent/tools/exec/bash.rs` — `exec_bash`'s `Sandbox::create(&ctx.cwd)` call (§5.1).
- `src-tauri/src/agent/permission.rs` — `PermissionOutcome`, `native_permission_gate`, `permission_options`, `permission_title` (§2).
- `src-tauri/src/agent/harness/loop/tests/{policy_gate.rs,param_rejection.rs,support.rs}` and `src-tauri/src/agent/tools/exec/tests/{policy.rs,support.rs}` (§7).
- `docs/roadmap/permissions-section.md` (spec, §0) and `docs/roadmap/permissions-section-task02-wire-shape-guard-prompt.md` (T02's hand-off markers, §6).
- `skills.rs::home_dir` / `agents.rs::user_roots` (§3.4, §9.3).