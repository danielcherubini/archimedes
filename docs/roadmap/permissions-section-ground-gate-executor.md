# Grounding report — Enforcement at the gate and in the executor

Research area for the permissions-section plan (spec: `docs/roadmap/permissions-section.md`).
Facts only, quoted verbatim, from the tree at HEAD. No recommendations.

Symbols named without `file:line` citations, per the dispatch. All quotes are byte-exact
from the files named in the dispatch (`gate.rs`, `loop.rs`, `access.rs`, `types.rs`,
`sandbox.rs`, `exec/tests/policy.rs`, `loop/tests/policy_gate.rs`, `loop/tests/param_rejection.rs`,
plus the supporting `boundary.rs`, `fs_backend.rs`, `policy.rs`, `fs_tools.rs`, `bash.rs`,
`exec.rs`, `loop/tools.rs`, `loop/turn.rs`, `exec/tests/support.rs` and two ADRs).

---

## 1. `gate.rs`'s protected-dir check + `deny_tool_result`

The protected-dir block runs **inside `AgentLoop::deny_tool_result`**, before the escape
(boundary) wording is consulted, and routes a hit to the deny-list refusal. Quoted verbatim
(`deny_tool_result` in full, `harness/loop/gate.rs`):

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

The gate itself (where a `Deny` verdict reaches `deny_tool_result`) is in `harness/loop/turn.rs`:

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

**`deny_tool_result`'s signature and behaviour in two sentences:** `pub(super) fn
deny_tool_result(&self, tc: &ToolCall) -> ToolResult` — it is the gate's tool-result
rejection for a `Deny`, a single text block with `is_error: true` and no `details`, never a
prompt. For a `Write`-direction tool with a `path` argument it first asks
`protected_refusal_text(&self.protected, &tc.name, path)` (the deny-list, checked BEFORE the
boundary) and uses that message when it returns `Some`; otherwise it falls back to
`escape_text` (the boundary "escapes the session sandbox" wording, or the executor-prefixed
`FsError` for `bash`'s generic Sandboxed refusal).

The function's own doc comment, verbatim:

```rust
    /// The tool-result error for a policy DENY (never a prompt). Worded like
    /// the executor's own rejection — `FsError`'s display, prefixed with the
    /// tool name exactly as the executors prefix it — so a read the GATE
    /// denied looks identical to the model to one the executor would have
    /// rejected: the model's recovery behavior must not depend on which
    /// layer said no. A write into a user-level agent-definition dir gets the
    /// deny-list wording instead (the true reason — refused there in EVERY
    /// policy, so "escapes the sandbox" would send the model off looking for
    /// a boundary that is not the problem).
```

---

## 2. The per-session freeze vs per-turn vs per-call

### What is frozen per session — `AgentLoop::new` (from `harness/loop.rs`)

The struct fields (`read_boundary` and `protected`, with docs):

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

The construction site (inside `AgentLoop::new`):

```rust
        // (ADR 0030) The boundary is computed ONCE here, not per tool call
        // (it is frozen for the session, and `read_roots` walks the tree +
        // canonicalizes). Reading `$HOME` is legitimate HERE — the Worker
        // process already does it for MCP and for skill discovery.
        let read_boundary = crate::agent::boundary::read_roots(&space_cwd);
        let protected = crate::agent::boundary::protected_dirs();
```

and inside the `Self { … }` initialization:

```rust
            read_boundary,
            protected,
            // Refreshed per turn by `handle_prompt` (Deviation 4); the
            // construction value only covers a tool call made BEFORE the
            // first prompt, of which there are none.
            file_policy: FilePolicy::default(),
```

### Where `ToolCtx` carries them — each tool call (from `harness/loop/tools.rs`)

The loop builds a fresh `ToolCtx` per dispatched call, cloning the frozen session values and
the per-turn policy:

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
                        file_policy: self.file_policy,
                        web: self.web.clone(),
                        render_requester: self.render_requester.clone(),
                    },
                    &tc.name,
                    &tc.arguments,
                )
```

### The per-turn re-read — `loop.rs`, top of `handle_prompt`

```rust
    pub async fn handle_prompt(&mut self, prompt: &PromptTurn) {
        // (ADR 0030 Deviation 4) The policy and web config are
        // re-read from `settings.json` ONCE per turn — the same in-process read
        // `launch.rs` does per dispatch, so a user who flips a select in
        // Settings affects an ALREADY-RUNNING session at its next prompt
        // (no restart, no relaunch). ONE read per turn (not per tool call):
        // every tool call in a turn must agree, or a half-asked batch would
        // be a policy the user never chose. `config_dir: None` → the
        // all-`Allow` default (no settings layer) + env-only web config.
        let settings = self.config_dir.as_deref().map(crate::config::load_settings);
        self.file_policy = settings.as_ref().map(|s| s.file_policy).unwrap_or_default();
        self.web = crate::agent::web::config::WebConfig::from_web_settings(
            settings.as_ref().map(|s| &s.web),
        );
```

### What is frozen vs re-read, exactly

| Value | Cadence | Where |
|---|---|---|
| `read_boundary` (read roots) | Frozen once at `AgentLoop::new`; cloned into every `ToolCtx.boundary` | `loop.rs` new + `loop/tools.rs` |
| `protected` (the deny-list) | Frozen once at `AgentLoop::new` (`boundary::protected_dirs()`); cloned into every `ToolCtx.protected` | `loop.rs` new + `loop/tools.rs` |
| `file_policy` (`reads`/`writes`/`shell` from `settings.json`) | Re-read **once per turn** at the top of every `handle_prompt` (Deviation 4); cloned into every `ToolCtx.file_policy` of that turn | `loop.rs` `handle_prompt` + `loop/tools.rs` |
| `web` config | Re-read once per turn alongside `file_policy` | `loop.rs` `handle_prompt` |

Nothing relevant is re-read per **call**: `protected` and `read_boundary` are struct fields
frozen at construction, and `file_policy` is refreshed only at the top of `handle_prompt`, so
every tool call within a turn shares the same policy object that the gate already used.
`ToolCtx` carries no settings-reading of its own — every field is injected by the loop (or by
a test builder).

Note: the gate reads `self.protected` / `self.file_policy` as fields (see section 1), while the
executor reads the *clones* on `ToolCtx`. There is no atomicity between them within a turn; in
practice both point at the same per-turn values because the loop sets `self.file_policy` and
then clones it per call (a mid-turn hand-edit is observed at the next prompt only — Deviation 4).

---

## 3. `access.rs` — `protected_refusal` and `protected_refusal_text`

`pub(crate) fn protected_refusal(ctx: &ToolCtx, tool: &str, resolved: &Path) -> Option<String>`,
with its doc comment (which contains the "Independent of `roots`" sentence):

```rust
/// The write DENY-LIST check (ADR 0030 Deviation 3): a resolved path under
/// one of `ctx.protected` (the user-level agent-definition dirs) is refused
/// in EVERY policy — including `writes: Allow` — because a model that can
/// rewrite `~/.agents/skills/*/SKILL.md` rewrites its own instructions for
/// every future session. Independent of `roots` (it is a deny, not a
/// boundary). `Some(message)` is the refusal, worded like an `FsError`.
pub(crate) fn protected_refusal(ctx: &ToolCtx, tool: &str, resolved: &Path) -> Option<String> {
    protected_refusal_text(&ctx.protected, tool, resolved)
}
```

`pub(crate) fn protected_refusal_text(protected: &[PathBuf], tool: &str, resolved: &Path) -> Option<String>`
— the shared text function, with its doc comments (the "Independent of `roots`" rationale and
the canonical-compare design are in the two paragraphs above the fn, quoted in section 3.1;
the body verbatim):

```rust
pub(crate) fn protected_refusal_text(
    protected: &[PathBuf],
    tool: &str,
    resolved: &Path,
) -> Option<String> {
    let resolved = crate::agent::fs_backend::canonicalize_lenient(resolved);
    // BOTH sides lenient (issue #92): the entry may name a dir that does not
    // exist yet, and a strict `canonicalize()` on it fails — which under
    // `is_ok_and` matched NOTHING, silently no-opping the deny-list for
    // exactly the entry `protected_dirs()` now keeps. `hit` stays the
    // CALLER's entry so the message names the directory as registered.
    let hit = protected
        .iter()
        .find(|dir| resolved.starts_with(crate::agent::fs_backend::canonicalize_lenient(dir)))?;
    Some(format!(
        "{tool}: {} is a protected agent-definition directory ({}) — writing there is refused in every policy. {PROTECTED_WRITE_ROUTE}",
        resolved.display(),
        hit.display()
    ))
}
```

### 3.1 The "Independent of `roots`" design doc (verbatim)

From `access.rs`'s `protected_refusal` doc, and from `access.rs`'s big comment on the
gate/executor drift (the paragraph that states the deny-list is independent of the policy and
the roots):

```rust
/// The write DENY-LIST check (ADR 0030 Deviation 3): a resolved path under
/// one of `ctx.protected` (the user-level agent-definition dirs) is refused
/// in EVERY policy — including `writes: Allow` — because a model that can
/// rewrite `~/.agents/skills/*/SKILL.md` rewrites its own instructions for
/// every future session. Independent of `roots` (it is a deny, not a
/// boundary). `Some(message)` is the refusal, worded like an `FsError`.
```

And the `# The COMPARED path is canonicalized the same way` section, which states which layer
refuses what:

```rust
/// What that mismatch costs is worth stating exactly, because the obvious story
/// is wrong. The DENY-LIST is not one of the things the policy moves: both
/// executors call [`protected_refusal`] unconditionally, straight after
/// `validate` and with no test of `ctx.file_policy.writes`, so a protected write
/// is refused by the EXECUTOR in every mode — `writes: Allow` included. What the
/// widening moves is the BOUNDARY check and nothing else: `write_backend` builds
/// its `roots` from `ctx.file_policy.writes`, so under `Allow` the roots go
/// unrestricted and `validate` stops refusing, while the deny-list (independent
/// of `roots`) keeps refusing. And under `Allow` the gate's copy of this
/// function is not even reached — the verdict is `Allow`, so `dispatch_tool`
/// runs and `deny_tool_result`, which only answers a `Deny`, never fires.
```

### 3.2 `PROTECTED_WRITE_ROUTE` (the appended route, shared by both layers)

```rust
pub(crate) const PROTECTED_WRITE_ROUTE: &str = "This is by design: these directories are the agent's own instructions. Write the file under your session directory instead and ask the user to move it into place (the `ask` tool).";
```

Its doc: `pub(crate) const PROTECTED_WRITE_ROUTE: &str` — "The reason + the route the
protected-write refusal appends after the refusal sentence … Deliberately the ONLY route the
refusal names — `sudo_exec` and the shell can both reach these dirs and both are documented
as intended (ADR 0030: a guard-rail, not a security boundary)".

---

## 4. `tools/types.rs` — `ToolCtx`, verbatim (all fields)

```rust
/// The execution context for a tool call: the session's `cwd` (the base of
/// the path-param tools' sandbox), the boundary / policy the executor
/// enforces (ADR 0030), and the cancellation token wired to the tool's
/// AbortSignal.
#[derive(Clone)]
pub struct ToolCtx {
    /// The session's `cwd` — the sandbox boundary.
    pub cwd: PathBuf,
    /// Cancelled when the tool's AbortSignal fires (kills the `bash` child).
    pub cancel: CancellationToken,
    /// The skill roots the `list_skills` / `read_skill` tools resolve
    /// against. `None` (the harness's value) → `discover_skills(Some(cwd))`,
    /// the SAME call the prompt builder makes, so both seams start from the
    /// SAME discovered set. They then filter it DIFFERENTLY, on purpose
    /// (ADR 0036): the ADVERTISED catalog — the `<skills>` prompt section and
    /// `list_skills` — is the `model_visible` subset, while `read_skill`
    /// RESOLVES against the FULL set so it can tell a model-hidden name from
    /// an unknown one and REFUSE it.
    ///
    /// WHAT the seam guarantees is therefore a claim about ONE INSTANT: read at
    /// the same moment, the two catalogs are the same SET — same roots, same
    /// `model_visible()` predicate (`read_skill` resolving the wider set is the
    /// deliberate exception, and it refuses per hit). They are NOT promised to
    /// agree ACROSS time: the `<skills>` section is FROZEN at the transcript's
    /// seq-0 prompt while BOTH skill tools re-discover on EVERY call, so a
    /// session born before a flag flip — or before a skill appeared on disk —
    /// already speaks the tools' live set while its own prompt still carries the
    /// old one. ADR 0036's frozen-vs-live bullet owns that divergence and states
    /// it as accepted; do not restate it here as agreement.
    ///
    /// `Some` pins EXPLICIT roots — the test seam (a
    /// test must never read the real `~/.agents/skills`), mirroring
    /// `skills::discover_in_roots`.
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
    /// The web tools' configuration for this turn (Task 1). Read once per turn
    /// from `settings.json` + the environment — NOT re-read per call, so a
    /// key added mid-turn lands next turn. `WebConfig::default()` in tests
    /// (HERMETIC: never read `$HOME` here — the same rule as `boundary`).
    pub web: crate::agent::web::config::WebConfig,
    /// Render requester for escalated headless webview fetches (Task 7).
    pub render_requester: Option<std::sync::Arc<dyn crate::agent::web::RenderRequester>>,
}
```

Note for the planner: `file_policy` is a whole `FilePolicy` value carried per call; `protected`
is a `Vec<PathBuf>` deny-list. Both are `pub`, so a rules layer could be added to `FilePolicy`
and would ride `ToolCtx.file_policy` automatically.

---

## 5. `sandbox.rs`'s use of `protected_dirs()` — the consumer the spec does not mention

`sandbox.rs` consults protected dirs in exactly **four** places, inside three functions. It
does not use the `exec` deny-list function at all — it works with raw path lists and Landlock
rules (it subtracts the protected dirs from the write allow-list, since Landlock cannot express
"anywhere except these dirs").

### 5.a Module doc (the policy statement)

```rust
//! * read + write: the nullness/entropy nodes under `/dev` (`/dev/null` and
//!   friends — `git --version` fails without `/dev/null` read-write), and
//!   [`crate::agent::boundary::write_roots`] (the canonical session `cwd`) +
//!   `/tmp` + `/var/tmp`, MINUS the protected agent-definition dirs (below).
//!
//! # The protected dirs ARE subtracted (Landlock cannot subtract, so we
//! enumerate)
//! A `PATH_BENEATH` rule grants its rights on the fd's path AND on
//! everything beneath it, and the ruleset is the UNION of the rules: there
//! is no narrower rule that takes a right back from an ancestor. So a write
//! root that merely CONTAINS a protected dir cannot be ruled read-write.
//! Instead ([`rule_write_root`]): the root itself is ruled read+execute and
//! every SIBLING along the path down to the protected dir is ruled
//! read-write, so the tree stays writable everywhere except the protected
//! subtree. The cost, in exchange for the protection: when the session
//! `cwd` is an ancestor of a protected dir (e.g. a session rooted at
//! `$HOME`), files cannot be CREATED directly in `cwd` itself (only in its
//! subdirectories) — Landlock simply cannot express both. And a `cwd` that
//! is inside a protected dir gets NO write rights at all: that is the case
//! the write tools' deny-list exists for, and it must hold at the tightest
//! tier too.
```

### 5.b `Sandbox::create` — the production consumer

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
        Ok(sandbox)
```

`Sandbox::create`'s doc: "Build the ruleset for a session rooted at `cwd`. The write boundary
is [`crate::agent::boundary::write_roots`] MINUS
[`crate::agent::boundary::protected_dirs`], so a `cwd` that cannot be canonicalized is a
fail-closed error (the same rule the `FsBackend` follows) and a `cwd` inside an
agent-definition dir is read-only."

```rust
    /// Make one write root writable EXCEPT inside the protected dirs.
    ///
    /// Landlock rules are additive (`PATH_BENEATH` covers the fd's path and
    /// everything under it, and the ruleset is the union of the rules), so
    /// there is no way to grant write on a directory and take it back for a
    /// subtree. Three cases:
    /// * the root IS, or sits INSIDE, a protected dir → read+execute only.
    ///   This is the exploit the write tools' deny-list exists to stop (a
    ///   session whose `cwd` is `~/.agents/skills` rewriting a `SKILL.md`),
    ///   so it holds at the tightest tier too.
    /// * no protected dir beneath it → the full read-write mask.
    /// * a protected subtree sits under it → read+execute on the chain of
    ///   directories down to it, read-write on every sibling along that
    ///   chain. The tree stays writable everywhere but the protected
    ///   subtree; the price is that files cannot be CREATED directly in an
    ///   ancestor on that chain (Landlock cannot express both).
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

### 5.c `rule_root_around_protected` — the recursive carve-out (two protected consultations)

```rust
    /// The recursive half of [`Sandbox::rule_write_root`]: `dir` contains a
    /// protected dir beneath it, so `dir` itself gets no write rights and
    /// its children are ruled individually.
    fn rule_root_around_protected(
        &mut self,
        dir: &Path,
        protected: &[PathBuf],
        required: bool,
    ) -> Result<(), String> {
        // Read + execute on the ancestor: write rights here would reach
        // inside the protected subtree (`MAKE_*`/`REMOVE_*` apply to entries
        // of any directory the right is granted on, beneath it).
        self.add_path(dir, READ_EXECUTE, required)?;
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            // Unreadable: nothing more can be carved out, and `dir` keeps
            // only read+execute, so this fails closed.
            Err(e) => {
                crate::agent::debuglog::log(&format!(
                    "sandbox: cannot list {} ({}) — it stays read-only",
                    dir.display(),
                    e
                ));
                return Ok(());
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // A symlinked child is NOT ruled: the rule would follow it and
            // grant write on whatever it points at, which may be anywhere.
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if protected.iter().any(|p| path == *p || path.starts_with(p)) {
                // The protected subtree itself: never writable.
                self.add_path(&path, READ_EXECUTE, false)?;
            } else if protected.iter().any(|p| path != *p && p.starts_with(&path)) {
                self.rule_root_around_protected(&path, protected, required)?;
            } else {
                self.add_path(&path, READ_WRITE, false)?;
            }
        }
        Ok(())
    }
```

### 5.d Bottom line for the planner

**`Sandbox::create` reads `boundary::protected_dirs()` freshly on every confined-shell spawn
and subtracts those dirs from the Landlock write allow-list** — so `bash` under
`shell: Sandboxed` cannot write into the four agent-definition dirs even though the rules layer
in the spec "never applies to `bash`". The spec says rules never apply to `bash`; what that
means for this existing Landlock subtraction — which today re-derives its deny set from
`protected_dirs()` rather than from any policy — is the planner's decision to make, and the
facts are: the bash path (`bash.rs`) is gated only by `decision_for(…, is_shell=true)`
(Shell direction, no path), and its confinement is the Landlock ruleset above, whose protected
subtraction is unconditional on policy.

Related test docs in sandbox.rs (for the inventory in §7):
- `a_session_cwd_inside_a_protected_dir_cannot_write_there` ("THE exploit the write tools'
  deny-list exists to stop, at the TIGHTEST tier: a session whose `cwd` IS a protected
  agent-definition dir must NOT be able to rewrite a `SKILL.md` there. The old code ruled
  `write_roots(cwd)` read-write unconditionally, so the deny-list was reachable around through
  `bash`.").
- `a_write_root_containing_a_protected_dir_stays_writable_around_it` ("A write root that
  merely CONTAINS a protected dir: the protected dir stays read-only while its siblings stay
  writable (Landlock cannot subtract, so the ancestors of the protected dir are ruled
  read-execute and the siblings read-write).").

---

## 6. The executor side — who refuses a protected write today

### The executor is the layer that actually refuses the write

The `write` and `edit` executors (`tools/exec/fs_tools.rs`) do: (1) build the write backend,
(2) `validate` the path against it (the boundary — widened to `["/"]` under `Ask`/`Allow`),
(3) consult `protected_refusal` UNCONDITIONALLY, straight after `validate`, with no test of
`ctx.file_policy.writes`. Quoted:

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

(identical shape in `exec_edit`, with `protected_refusal(ctx, "edit", &resolved)`).

So **today the executor is the primary refuser of a protected write**: it refuses in every
policy (`Sandboxed`, `Ask`, `Allow`), because `protected_refusal` is called unconditionally
after `validate`. The gate's `deny_tool_result` only ever fires for a `Deny` verdict — and a
protected write under `writes: Allow` produces `Decision::Allow` (the boundary check admits
it), so the gate's deny-list copy is not even reached there (stated verbatim in `access.rs`,
§3.1). The gate's copy exists only to *choose the wording* when the gate itself denies (a
`Sandboxed` boundary escape that also lands in a protected dir).

### The read side never consults the deny-list

`read` (`exec_read`), `find`, `grep`, `ls` go through `read_backend(ctx)` only (which is
built on `executor_roots(&ctx.cwd, &ctx.boundary, ctx.file_policy.reads)`); there is no
`protected_refusal` on the read path. The deny-list is a WRITE floor only.

### How `executor_roots()` feeds the actual confinement

`access.rs`:

```rust
pub(crate) fn read_backend(ctx: &ToolCtx) -> FsBackend {
    FsBackend {
        roots: crate::agent::boundary::executor_roots(
            &ctx.cwd,
            &ctx.boundary,
            ctx.file_policy.reads,
        ),
    }
}

pub(crate) fn write_backend(ctx: &ToolCtx) -> FsBackend {
    FsBackend {
        roots: crate::agent::boundary::executor_roots(
            &ctx.cwd,
            std::slice::from_ref(&ctx.cwd),
            ctx.file_policy.writes,
        ),
    }
}
```

and `boundary.rs`'s `executor_roots` (with the doc that names the two-row behavior):

```rust
/// The executor's root set for one direction, derived from the policy.
/// `Sandboxed` → the direction's boundary (the gate already denied
/// beyond-boundary accesses; the executor is the fail-closed backstop).
/// `Ask`/`Allow` → `[cwd, unrestricted_floor()]`: the gate is the only
/// decision point, and an approved `Ask` must be able to land. `roots[0]` is
/// the relative-path join base in both cases.
pub fn executor_roots(cwd: &Path, boundary: &[PathBuf], policy: AccessPolicy) -> Vec<PathBuf> {
    match policy {
        AccessPolicy::Sandboxed => boundary.to_vec(),
        // The widening: the gate has already decided, so the executor must
        // not re-decide. The floor roots are roots like any other — the
        // canonicalization and the symlink / `..` slow paths still run, they
        // just never reject on containment. On unix the floor is one `/`; on
        // Windows it is the mounted drive roots, because a lone `/` there is
        // only the current drive (see [`unrestricted_floor`]). ONLY this arm
        // widens — the `Sandboxed` arm hands back the caller's real boundary
        // untouched, so the ADR 0030 containment strictness is unchanged.
        AccessPolicy::Ask | AccessPolicy::Allow => {
            let base = canon(cwd).unwrap_or_else(|| cwd.to_path_buf());
            let mut roots = vec![base];
            roots.extend(unrestricted_floor());
            roots
        }
    }
}
```

`boundary::write_roots(cwd)` (the gate's "beyond" for writes and the `Sandboxed` write floor):
"the canonical `cwd` ONLY. Space-level agent dirs are repo content and stay writable; the
user-level dirs are handled by [`protected_dirs`]." `boundary::read_roots(cwd)`: "`cwd`
FIRST, then the discovery roots (user + space level, skills + agents)."

### Precisely: which layer refuses what today

| Access | Layer that refuses | Mechanism |
|---|---|---|
| Protected write, `writes: Allow` | **Executor** (`write`/`edit`) | `validate` admits (roots `["/"]`), then unconditional `protected_refusal` → `ToolResult::fail` with the protected wording. Gate verdict is `Allow` → gate never fires. |
| Protected write, `writes: Sandboxed` | **Both** — executor refuses first (borderline: which runs first depends on which layer sees the call; the gate denies before dispatch, so the **gate** produces the tool-result error and the executor never runs) | Gate: `policy_verdict` → `Deny` → `deny_tool_result` picks the protected wording; Executor (would also refuse if reached). |
| Protected write, `writes: Ask` (approved) | **Executor** | After approval, dispatch runs, executor's unconditional `protected_refusal` refuses. |
| Protected dir via `bash`, `shell: Allow` | **Nobody** (documented guard-rail gap) | `bash` ignores the deny-list by design ("a guard-rail, not a security boundary" — ADR 0030). |
| Protected dir via `bash`, `shell: Sandboxed` | **Sandbox** (Linux Landlock) | `Sandbox::create` subtracts `protected_dirs()` from the write allow-list (§5) — this is a process-level refusal, not a tool-result error. |
| Read of a protected dir | **Nobody refuses** (reads are allowed; the boundary includes agent dirs per `read_roots`) | The deny-list is a WRITE floor. |
| Beyond-boundary read/write under `Sandboxed` | Gate (`Deny`) and executor (`validate` backstop) | Both use `FsBackend::validate` over the same roots (§8). |

The `is_error`-vs-wording evidence that distinguishes the gate refusal from a boundary one is
pinned by tests; see §7. The gate's strawberry: `a_recreated_protected_dir_is_refused_by_the_gate_without_a_new_session`'s doc states the discriminator — "with an empty deny-list the write is still refused, as a BOUNDARY escape … the refusal comes back `write: path escapes the session sandbox: …` instead of the deny-list sentence, so the `protected agent-definition directory` assertion fails."

---

## 7. Test inventory

### 7.a `exec/tests/policy.rs` — all 10 tests (the executor side)

| Name | Prose (verbatim doc name / key clause) |
|---|---|
| `read_beyond_the_boundary_succeeds_when_reads_allow` | "The point of the whole feature: with `reads: Allow` the gate is the only decision point, so a read BEYOND the boundary lands." |
| `read_reaches_a_second_boundary_root_when_sandboxed` | "(ADR 0030) A read boundary with MULTIPLE roots: a file in the second boundary root … is readable, while a file in neither root is not." |
| `write_beyond_the_boundary_succeeds_when_writes_allow` | "`writes: Allow` widens the WRITE direction the same way (an approved `Ask` must be able to land, or the prompt lies)." |
| `write_into_a_protected_dir_is_refused_under_every_policy` | "The DENY-LIST is unconditional: a write whose resolved path is under a `protected` dir is refused under EVERY policy … this is never a prompt and never widened." |
| `write_a_new_file_under_a_protected_dir_is_refused` | "The deny-list is a PREFIX check on the RESOLVED path, so a new file created under a protected dir is refused too (the dir need not hold the file yet)." |
| `a_raw_protected_entry_still_refuses_a_canonical_path_under_it` | "The deny-list compares CANONICALLY, so a RAW (never-canonicalized) protected entry still refuses a write whose `resolved` path reaches it through a symlink." |
| `a_raw_argument_still_refuses_against_canonical_protected_entries` (`#[cfg(unix)] #[test]`) | "The MIRROR … the ENTRIES are canonical (what production hands over, via `boundary::protected_dirs`) and the COMPARED path is RAW. That is exactly what the GATE does — `loop.rs::deny_tool_result` passes the model's `path` argument verbatim — so this seam must canonicalize its ARGUMENT side too." |
| `a_recreated_protected_dir_is_refused_without_a_new_session` | "(issue #92) THE SCENARIO THE ISSUE WAS FILED FOR: a protected dir is missing when the Session starts, the user recreates it mid-session, and the Session that never restarted must still refuse to write into it." |
| `a_write_into_a_still_missing_protected_dir_is_refused` | "(issue #92) THE FALSIFIER for the second half of the fix — the test that makes `access.rs`'s entry-side leniency load-bearing." |
| `bash_ignores_the_file_boundary` | "`bash` IGNORES the boundary (its `Sandboxed` tier is Landlock, Task 5): a sandboxed read cannot reach a file that `bash` can happily cat, so the boundary must not pretend to bound the shell." |

### 7.b `loop/tests/policy_gate.rs` — all 9 tests (the gate side)

| Name | Prose (verbatim doc name / key clause) |
|---|---|
| `ask_beyond_the_boundary_prompts_naming_the_path_then_runs` | "(ADR 0030) `reads: Ask` + an out-of-boundary `read` on an UNTRUSTED Space: a `permission-request` naming THE PATH (not a JSON blob), and after the user allows, the read really lands." |
| `sandboxed_beyond_the_boundary_errors_with_no_prompt` | "(ADR 0030) `reads: Sandboxed` + an out-of-boundary `read`: a tool-result error worded like the executor's own rejection, and NO `permission-request` (a Deny never reaches the UI — Trust included …)". |
| `the_default_policy_reads_and_writes_beyond_the_boundary_in_silence` | "(ADR 0030, Deviation 2 — the intended widening) the DEFAULT policy (all `Allow`, and the no-`config_dir` case that behaves the same): an out-of-boundary `read` AND an out-of-boundary `write` both dispatch silently — no prompt, no error — and the write LANDS." |
| `a_settings_edit_between_prompts_changes_the_next_turns_gating` | "(ADR 0030 Deviation 4 — "affects an already-running session") the policy is re-read from `settings.json` at the top of EVERY prompt: a settings edit BETWEEN two prompts changes the SECOND prompt's gating, with no restart and no relaunch." |
| `a_sandboxed_shell_dispatches_confined_with_no_prompt` | "(ADR 0030 Task 5) `shell: Sandboxed` means CONFINE: the gate never prompts, the command runs INSIDE the Landlock ruleset, and a kernel that cannot confine FAILS CLOSED with a visible error instead of running unsandboxed." |
| `a_gate_denial_of_a_protected_dir_uses_the_protected_wording` | "(ADR 0030 Deviation 3) a write into a user-level agent-definition dir is refused by the GATE in the deny-list's own words (the same text the executor produces), even though `writes: Sandboxed` would otherwise read as an escape — the deny-list is the true reason there." |
| `a_recreated_protected_dir_is_refused_by_the_gate_without_a_new_session` | "(issue #92) The GATE seam, driven through the REAL `AgentLoop::new` snapshot: a protected dir that was missing when the Session started and was recreated mid-session must be refused by the gate WITHOUT a restart." |
| `a_trusted_space_suppresses_the_prompt_the_policy_would_raise` | "(ADR 0030) A TRUSTED Space suppresses an `Ask` at the GATE: the verdict itself is `Allow` (so no `PendingPermissions` entry is ever registered), and the out-of-boundary `read` runs." |
| `the_skill_tools_stay_outside_the_policy_gate` | "(ADR 0030) A tool the policy does NOT judge stays ungated: `read_skill` takes a skill NAME and carries its own per-skill containment (ADR 0029), so a `Sandboxed` read policy must not touch it — and it must not gain a prompt either." |

### 7.c `loop/tests/param_rejection.rs` — all 5 tests (protected-dir-related context)

| Name | Prose (verbatim doc name / key clause) |
|---|---|
| `a_rejected_call_returns_is_error_and_never_touches_the_filesystem` | "(issue #93) An unknown TOP-LEVEL tool parameter REJECTS the call: the tool is never dispatched and the result is a synthetic `is_error: true` message naming the offending key and the closest advertised one." |
| `a_rejected_subagent_call_never_creates_a_child` | "A rejected `subagent` call never creates a child." (futures-`.filter` test) |
| `a_rejected_call_never_reaches_the_permission_gate` | "A rejected call never reaches the permission gate: no prompt for a call that will not run." — and the only `protected` mention in this file: `// protected_dirs() reads $HOME; an empty scratch home keeps the verdict Ask rather than Deny (the precedent is the_default_policy_reads_and_writes_beyond_the_boundary_in_silence).` |
| `a_cancelled_turn_reports_cancelled_and_not_a_rejection` | "Cancellation beats rejection (same rule, the sequential tools)." |
| `a_cancelled_subagent_call_reports_cancelled_and_not_a_rejection` | "… pins the same rule for the `subagent` arm deterministically." |

### 7.d `exec/tests/support.rs` — the `ToolCtx` builder and protected injection

`pub(crate) fn ctx(cwd: &Path) -> ToolCtx` — the hermetic builder. Key facts for the planner:

```rust
pub(crate) fn ctx(cwd: &Path) -> ToolCtx {
    ToolCtx {
        cwd: cwd.to_path_buf(),
        cancel: CancellationToken::new(),
        skill_roots: None,
        boundary: vec![cwd.to_path_buf()],
        file_policy: crate::agent::policy::FilePolicy {
            reads: crate::agent::policy::AccessPolicy::Sandboxed,
            writes: crate::agent::policy::AccessPolicy::Sandboxed,
            shell: crate::agent::policy::AccessPolicy::Allow,
        },
        protected: Vec::new(),
        web: Default::default(),
        render_requester: None,
    }
}
```

Doc: "HERMETIC BY DESIGN: `boundary` is the single `cwd` and `protected` is EMPTY — this must
NEVER derive them from the `$HOME`-reading boundary helpers … The policy pins `Sandboxed` for
reads and writes: these are CONTAINMENT tests, so they pin the tier that enforces the boundary
(`shell: Allow` — no test here gates `bash`)."

A test injects a `protected` list by struct-updating the builder:
`ToolCtx { protected: vec![protected.clone()], file_policy: …, ..ctx(&cwd) }` (this exact
pattern appears in `write_into_a_protected_dir_is_refused_under_every_policy`,
`write_a_new_file_under_a_protected_dir_is_refused`,
`a_raw_protected_entry_still_refuses_a_canonical_path_under_it`, and — without a policy
override but with a full snapshot — in the two `$HOME`-pinned snapshot tests, which pass the
real `boundary::protected_dirs()` result as `protected`). `ctx_policy(cwd, policy)` overrides
only `file_policy`.

Also in this file: `temp_cwd(tag)` (the sole `exec-*` ScratchDir minter),
`can_confine()` (Landlock availability branch for the confined tests), `text_of(r)` (first
text block).

---

## 8. How the two layers are kept in agreement today

The rule is "one canonicalizer / one resolver serves both layers"; it is expressed in three
places verbatim:

**The gate's own doc comments** (`harness/loop/gate.rs`, on `policy_verdict` and `beyond_error`):

```rust
    /// "Beyond the boundary" is answered by the SAME canonicalize-then-check
    /// the ADR 0029 attack matrix proved (`FsBackend::validate` over the
    /// direction's boundary roots) — deliberately NOT a second canonicalizer
    /// here: a gate and an executor that resolve `..` / symlinks differently
    /// is the classic sandbox escape, so they share one resolver and can not
    /// drift. `Ok` = in bounds; ANY `Err` (escape, or a root set that cannot
    /// be judged) = `beyond`, so an unjudgeable path is never silently
    /// allowed.
```

And on `beyond_error`:

```rust
    /// Answered by the SAME canonicalize-then-check the ADR 0029 attack
    /// matrix proved (`FsBackend::validate`), so gate and executor cannot
    /// resolve `..` / a symlink differently — a gate that resolves differently
    /// than the thing it gates is the classic escape, hence ONE resolver
    /// shared by both layers rather than a second canonicalizer here.
```

**The lenient primitive's doc** (`fs_backend.rs`, `canonicalize_lenient`):

```rust
/// Canonicalize `path`, or — when it does not exist yet — canonicalize its
/// deepest existing ancestor and re-append the components that lead to the
/// missing target.
///
/// THE ONE implementation of the peel rules (the shape [`FsBackend::resolve`]
/// has always used): anything else that has to canonicalize a
/// not-yet-existing path MUST go through here, because a second canonicalizer
/// that peeled differently would disagree with the executor about where a path
/// lands — the classic gate-vs-executor split-brain.
```

**ADR 0030's doc sentence** (`docs/decisions/0030-file-access-policy.md`, in the boundary
paragraph):

> Containment itself is not reimplemented — it is ADR 0029's canonicalize-then-check
> (`FsBackend::validate`), shared by gate and executor so the two cannot resolve `..` or a
> symlink differently, which is the classic escape.

And ADR 0081's decision text (the deny-list-specific application): "`tools::exec::access::protected_refusal_text` canonicalizes the **ENTRY** through that same lenient primitive" — i.e. `protected_refusal_text` uses `fs_backend::canonicalize_lenient` on both sides, never its own canonicalizer.

For the rules layer the spec wants to add: the current shared seam is `FsBackend::validate`
(gate's `beyond_error` and the executors both call it with the *same* roots for a given
direction) plus `canonicalize_lenient` (both deny-list consumers and `FsBackend::resolve`
share it). The deny-list wording is additionally kept single-source by
`PROTECTED_WRITE_ROUTE` (§3.2) and by the gate calling `protected_refusal_text` directly
(§1).

---

## 9. Exact scoped commands (run from `src-tauri/`)

All commands run from `/home/daniel/Coding/AI/archimedes-desktop/src-tauri/`.

The executor-side policy tests:

```sh
cargo test --lib tools::exec::tests::policy
```

(module path: `src/agent/tools/exec/tests/policy.rs` → `agent::tools::exec::tests::policy`.)

The gate-side tests:

```sh
cargo test --lib harness::loop::tests::policy_gate
cargo test --lib harness::loop::tests::param_rejection
```

(module path: `src/agent/harness/loop/tests/{policy_gate,param_rejection}.rs` →
`agent::harness::loop::tests::policy_gate` / `agent::harness::loop::tests::param_rejection`.)

Exactly one test, when a fixture is confusing:

```sh
cargo test --lib tools::exec::tests::policy::write_into_a_protected_dir_is_refused_under_every_policy
cargo test --lib harness::loop::tests::policy_gate::a_gate_denial_of_a_protected_dir_uses_the_protected_wording
```

The sandbox consumer deps (the two protected-dirs tests in `sandbox.rs` are `#[cfg(test)]`
inside `src/agent/tools/sandbox.rs`):

```sh
cargo test --lib tools::sandbox::a_session_cwd_inside_a_protected_dir_cannot_write_there
cargo test --lib tools::sandbox::a_write_root_containing_a_protected_dir_stays_writable_around_it
```

**The `fake_worker` caveat (verified):** `src/agent/harness/loop/tests/subagents.rs`
(`FakeWorkerFactory::spawn`) spawns `concat!(env!("CARGO_MANIFEST_DIR"), "/target/debug/fake_worker")`.
The `fake_worker` binary is only built as a bin target of the `archimedes` package
(`src/bin/fake_worker.rs`). `cargo test --lib` builds and runs only the lib test harness, so
it does **not** rebuild `fake_worker` — the `subagents` tests (and any end-to-end loop test
that spawns a worker) will exec a **stale or missing** `target/debug/fake_worker` binary.
None of the four listed modules above (`policy`, `policy_gate`, `param_rejection`) spawn
`fake_worker` (they use `build_loop_with_db` with an in-process provider; only
`loop/tests/subagents.rs` uses `FakeWorkerFactory`), but the policy-gate fixture itself is
built on `build_loop_with_db`, and when "a fixture looks like it is lying", build all targets
first so the fixture binary is current:

```sh
cargo build --all-targets
```

then re-run the scoped test. This is exactly the repo constraint the spec records:
"`cargo test --lib` does not rebuild `fake_worker`" (`docs/roadmap/permissions-section.md`,
Verification).

Repo constraint to keep in mind while running these: `archimedes` is ONE compilation unit
(single `[package]`, lib `archimedes_lib` + bins), so every `cargo test --lib` invocation
recompiles the whole lib; `#[cfg(windows)]` behaviour type-checks locally and only runs on CI.

---

## Sources (files read)

- `src-tauri/src/agent/harness/loop/gate.rs` — `deny_tool_result`, protected block, `policy_verdict`/`beyond_error` docs
- `src-tauri/src/agent/harness/loop.rs` — `AgentLoop` struct docs, `AgentLoop::new` (`read_boundary`/`protected`), `handle_prompt` re-read (Deviation 4)
- `src-tauri/src/agent/harness/loop/tools.rs` — per-call `ToolCtx` construction
- `src-tauri/src/agent/harness/loop/turn.rs` — verdict dispatch (`Decision::Deny` → `deny_tool_result`)
- `src-tauri/src/agent/tools/exec/access.rs` — `read_backend`/`write_backend`, `protected_refusal`, `protected_refusal_text`, `PROTECTED_WRITE_ROUTE`
- `src-tauri/src/agent/tools/types.rs` — `ToolCtx`
- `src-tauri/src/agent/tools/exec/fs_tools.rs` — `exec_write`/`exec_edit` refusal order
- `src-tauri/src/agent/tools/exec/bash.rs` — `confined`/Landlock use of `Sandbox::create`
- `src-tauri/src/agent/tools/exec.rs` — `execute_tool` dispatch, module docs
- `src-tauri/src/agent/tools/sandbox.rs` — module doc, `Sandbox::create`, `rule_write_root`, `rule_root_around_protected`, the two protected tests
- `src-tauri/src/agent/tools/exec/tests/policy.rs`, `src-tauri/src/agent/tools/exec/tests/support.rs`
- `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`, `src-tauri/src/agent/harness/loop/tests/param_rejection.rs`
- `src-tauri/src/agent/boundary.rs` — `read_roots`, `write_roots`, `protected_dirs`, `executor_roots`, `unrestricted_floor`
- `src-tauri/src/agent/fs_backend.rs` — `validate`, `resolve`, `canonicalize_lenient`, `peel_to_existing`
- `src-tauri/src/agent/policy.rs` — `FilePolicy`, `AccessPolicy`, `decision_for`, `Decision`
- `docs/decisions/0030-file-access-policy.md` — Amendment 2/3/4, the shared-`validate` sentence
- `docs/decisions/0029-skill-tools-read-by-name.md` — the canonicalize-then-check origin
- `docs/decisions/0081-a-lenient-deny-list-entry-needs-a-lenient-compare-one-half-alone-is-a-silent-no-op.md` — the leniency rule both deny-list consumers share
- `docs/roadmap/permissions-section.md` — the spec being grounded