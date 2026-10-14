---
status: committed
done-when: clicking a link in a transcript opens it in the OS default handler on Linux, macOS and Windows, and the Client's own page never navigates — verified by hand on each platform (no CI can assert what xdg-open launched).
---

# External open Plan

**Goal:** every link, path and file chip the Client shows opens through ONE seam in the operating system's default handler, and the Client's own webview can never navigate away.

**Architecture:** one Rust policy module (`src-tauri/src/open.rs`) owns classification (URL vs path), the scheme denylist and the path join; a thin `external_open` command exposes it to the renderer, and the MCP OAuth opener calls it directly. The renderer intercepts clicks on its own anchors and calls the command; a local `Plugin::on_navigation` refuses any navigation to a foreign origin, so a component that forgets the handler cannot eat the app. See ADR 0051 (`docs/decisions/0051-external-open-is-one-rust-seam-that-bypasses-the-acl.md`) for why the seam deliberately bypasses the Tauri ACL.

**Tech Stack:** Rust (Tauri 2.12.2, `tauri-plugin-opener` 2.5.5), React 19 + TypeScript, `react-markdown` 10.1 + `remark-gfm` 4, vitest/jsdom.

---

## Read this before starting

**Validation** — use CI's exact spellings (`.github/workflows/ci.yml:58,65`): frontend from the repo root — `pnpm test`, `pnpm build`; Rust from `src-tauri/` — `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check`. Every task ends green on the side it touched. Do not float the Rust toolchain or `@tauri-apps/cli`.

**Facts this plan depends on, all verified in this repo/tree — do not re-derive, do not "fix":**

- `tauri::Url` is re-exported (`tauri-2.12.2/src/lib.rs:91: pub use url::Url;`). **No new Cargo dependency is added by this plan.**
- `Url::parse("C:/dir/f")` SUCCEEDS and gives scheme `c` — a single ASCII letter is a legal RFC-3986 scheme. A Windows drive root must therefore be detected **before** `Url::parse` is tried. This is the single most likely bug in Task 1.
- Tauri's default `on_navigation` hook returns `true` (`tauri-2.12.2/src/plugin.rs:287`), and a plugin's hook IS consulted for windows declared in `tauri.conf.json` (`tauri-2.12.2/src/manager/webview.rs:625`). There is no plugin hook for `on_new_window`, and its default already denies — so do not add one. The IPC protocol is NOT gated by the guard: Linux/macOS IPC is a `fetch()` to `ipc://localhost` and wry only runs the navigation handler for a navigation action (`wry-0.57.0/src/webkitgtk/mod.rs:554-558`), so there is no `ipc` rule to add.
- `tauri_plugin_opener::open_url` / `open_path` (the crate's free functions, `src/open.rs`) do **not** consult the ACL scope — only the IPC commands in `src/commands.rs` do. So the policy needs no capability entry.
- **`src-tauri/capabilities/default.json` is NOT touched by this plan** (ADR 0051). Its `opener:default` entry becoming unused is the recorded consequence, not an oversight.
- `crate::skills::home_dir()` is `pub(crate) fn home_dir() -> Option<PathBuf>` (`src-tauri/src/skills.rs:213`) — reachable from `crate::open`.
- `react-markdown@10`'s default `urlTransform` returns `""` for any protocol outside `http|https|irc|ircs|mailto|xmpp` (`node_modules/react-markdown/lib/index.js:124` + `421-443`). The override in Task 5 is what makes the wide scheme policy reachable at all.
- Bare `https://…`, `www.…` (→ `http://www…`) and `mailto:` in prose are **already anchors** — `remark-gfm` autolink literals. Verified through this app's renderer. There is no prose linkifier in this plan.
- Inline code spans and Shiki-highlighted fences stay **inert**. Do not try to place anchors inside `dangerouslySetInnerHTML` (`MessageBubble.tsx:329`): Shiki splits a URL across sibling `<span>`s.
- `FileChip` has FIVE call sites and four of them render inside a toggle `<button>`: `ToolCallCardHeader.tsx:99` (inside the `<button>` opened at `:82`, `onClick={onToggle}` at `:84`) and `ChangesGroupCard.tsx:211`/`:229`/`:234` (inside the `<button>` opened at `:168`, which closes at `:244`). Only `ToolCallCard.tsx:115` (the expanded body's `tool-call-file-row`) is outside a button. **Only that one becomes clickable.**
- A **Subagent session**'s transcript sheet is mounted by `SubagentDetailHost` at `App.tsx:357` — a SIBLING of the workspace view, not a child of `ChatStream`. That is why the cwd provider lives in `App` (Task 5) and not in `ChatStream`. A child's Worker runs with `cwd = parent_cwd` (`src-tauri/src/agent/worker/manager.rs:474`), so the active Space's cwd is the right value for both.

**Terminology** (`CONTEXT.md`): **External open** = handing a URL or path to the OS default handler. A **Session**'s `cwd` IS its **Space**'s folder.

---

### Task 1: `crate::open` — the policy, and the OAuth opener moves onto it

**Context:**
Four places in the Client try to open something outside itself and each fails differently (a markdown anchor navigates the app's own webview; a `target="_blank"` link is denied by wry; an `openPath` call the capability never granted; a hand-rolled per-OS `open`/`cmd /c start`/`xdg-open`). This task creates the ONE policy every one of them will call. It has no IPC and no UI — pure Rust, fully unit-tested. ADR 0051 records why this seam deliberately bypasses the Tauri ACL and why the scheme policy is a **denylist** rather than an allow-list: the OS is the thing that knows what a scheme means, so `slack://`, `ssh://` and `file://` reach it, and the click is the user's consent.

**Files:**
- Create: `src-tauri/src/open.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod open;` to the module list at lines 1-10)
- Modify: `src-tauri/src/agent/mcp/manager.rs` (`production_open_browser`, lines 363-375)
- Test: unit tests in `src-tauri/src/open.rs` (`#[cfg(test)] mod tests`, the module-local style used across this crate — see `src-tauri/src/commands/mod.rs:29`)

**What to implement:**

In `src-tauri/src/open.rs`:

```rust
use std::path::{Path, PathBuf};
use tauri::Url;

/// Schemes refused outright. Everything NOT listed reaches the OS, because the OS
/// owns what a scheme means (ADR 0051). Compared LOWERCASE.
const DENIED_SCHEMES: [&str; 5] = ["javascript", "data", "vbscript", "blob", "filesystem"];

/// Opaque (no `//authority`) schemes that are still URLs. Without this list a
/// file named `notes:2024.md` parses as scheme `notes` and would go to the OS as
/// a URL instead of opening as a path.
const OPAQUE_SCHEMES: [&str; 5] = ["mailto", "tel", "sms", "urn", "xmpp"];

// Both derives are LOAD-BEARING: the tests assert with `assert_eq!`.
#[derive(Debug, PartialEq)]
pub enum Target { Url(String), Path(PathBuf) }

#[derive(Debug, PartialEq)]
pub enum Refusal {
    /// empty / whitespace-only href
    Empty,
    /// a `DENIED_SCHEMES` scheme, with the scheme name
    DeniedScheme(String),
    /// a `file:` URL this platform cannot turn into a path (incl. a non-localhost host)
    BadFileUrl(String),
    /// a relative path with no cwd to resolve it against
    RelativeWithoutCwd,
}

impl Refusal {
    /// The stable wire code the renderer logs (`denied-scheme:javascript`).
    pub fn code(&self) -> String { /* match each variant; kebab-case, detail appended */ }
}

/// Pure: no IO, no `home_dir` env read beyond `crate::skills::home_dir()`.
pub fn classify(href: &str, cwd: Option<&Path>) -> Result<Target, Refusal>;
/// `classify`, then the plugin's Rust free functions (which bypass the ACL scope).
pub fn open(href: &str, cwd: Option<&Path>) -> Result<(), String>;
```

`classify`, in THIS order (the order is load-bearing):

1. **Normalise:** remove every `\t`, `\n` and `\r` from the whole string, then trim. Markdown can spell `javascript:` as `java&#10;script:`; closing that here is the only place it gets closed.
2. Empty after normalising → `Refusal::Empty`.
3. **Windows drive root / UNC / bare-`www.` / tilde BEFORE any URL parsing** (see the `C:/` fact above):
   - drive root: `len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')`
   - UNC: starts with `\\`
   - tilde: `s == "~"` or `s.starts_with("~/")` → expand with `crate::skills::home_dir()`; if `home_dir()` is `None`, treat the remainder as relative (step 6's join, so it is refused with no cwd).
   → go to step 6 (the path route).
   - `www.` prefix → `return Ok(Target::Url(format!("http://{s}")))`. **This case is real, not hypothetical:** GFM's `www.` → `http://www.…` prefixing applies only to *autolink literals*, so an explicit `[w](www.example.com/x)` reaches us schemeless and would otherwise be joined onto the cwd as a path.
4. Otherwise `Url::parse(s)`.
5. On `Ok(url)`: let `scheme = url.scheme()` (already lowercase).
   - `DENIED_SCHEMES.contains(&scheme)` → `Refusal::DeniedScheme(scheme.to_string())`.
   - `scheme == "file"` → **check the host yourself first**, because `Url::to_file_path()` is platform-dependent about hosts (on Windows it turns `file://otherhost/x` into the UNC path `\\otherhost\x` instead of erroring): `match url.host_str() { None | Some("") | Some("localhost") => ok, _ => return Err(Refusal::BadFileUrl(s)) }`. Then `url.to_file_path()` → `Ok(Target::Path(p))` / `Err(_) => Err(Refusal::BadFileUrl(s))`. `to_file_path` already percent-decodes and already drops the `#fragment`, so `file:///tmp/a%20b.md#L3` → `/tmp/a b.md`.
   - **scheme-shaped-but-meant-as-a-path guard:** `if !url.has_authority() && !OPAQUE_SCHEMES.contains(&scheme)` → fall through to the path route (step 6). This exists because `notes:2024.md` PARSES as scheme `notes`, and a file named `notes:2024.md` is far likelier than a registered `notes:` handler. `mailto:a@b` and `tel:+1` stay URLs through that list.
   - otherwise → `Target::Url(s.to_string())` — pass the **normalised original string** to the OS, never `url.as_str()` (do not let the URL parser re-encode what the user meant).
6. On `Err(_)` from `Url::parse` (and on the fall-through above) → the path route:
   - strip everything from the FIRST `#` or `?` (so `README.md#install` and `main.rs#L42` are openable; the Client has no editor, so a line number cannot be honoured), then trim again; if now empty → `Refusal::Empty`.
   - absolute (starts with `/`, or is a drive root, or is UNC) → `Target::Path(PathBuf::from(s))`.
   - starts with `~/` → home-expanded join.
   - else relative → `cwd.map(|c| Target::Path(c.join(s)))`, `None` → `Refusal::RelativeWithoutCwd`. Use `PathBuf::join`, never string concatenation (a Windows path join is not a `/`).
   - The path is NOT canonicalised and NOT checked against the _Boundary_: a path outside the **Space** opens too, because the _Boundary_ confines the **Agent** and never the user's click. Do not add an existence check — `open_path` already errors on a missing path.
7. `open`: `classify`, then `Target::Url(u) => tauri_plugin_opener::open_url(&u, None::<&str>)`, `Target::Path(p) => tauri_plugin_opener::open_path(&p, None::<&str>)`, mapping an `Err` to `format!("os-error:{e}")`; a `Refusal` maps to `r.code()`.

`production_open_browser` in `manager.rs` becomes exactly `let _ = crate::open::open(url, None);` (`None` needs no annotation here — the parameter is `Option<&Path>`; if a lint asks, `None::<&Path>`). — delete the `cfg!(target_os)` block. It is fire-and-forget and its failure is non-fatal (the URL is already in the result the caller returns), so keep the `let _ =`. **Do not** change its signature, its callers (`manager.rs:260`, `:353`) or the `open_browser` seam in `agent/mcp/oauth.rs`.

**What NOT to change:** `src-tauri/capabilities/default.json`; `Cargo.toml` (no new dep); the plugin registration in `lib.rs:242`.

**Steps:**
- [ ] Write the failing tests in `src-tauri/src/open.rs` FIRST (`#[cfg(test)] mod tests` — module-local, the style at `src-tauri/src/commands/mod.rs:29`), as a table over `classify`: `https://example.com/x` → `Url`; `slack://chan/x`, `ssh://host`, `ftp://h/f` → `Url`; `javascript:alert(1)` → `DeniedScheme("javascript")`; `"java\nscript:alert(1)"` → `DeniedScheme("javascript")`; `data:text/html,x` / `vbscript:x` / `blob:https://a/b` / `filesystem:http://a/b` → `DeniedScheme`; `C:/dir/f` and `C:\dir\f` → `Path(PathBuf::from("C:/dir/f"))` / `Path(PathBuf::from("C:\\dir\\f"))` (assert the literal `PathBuf` — `classify` never canonicalises, so these hold on Linux CI too); `/abs/x` → `Path`; `\\\\server\\share` (UNC) → `Path`; relative with `cwd=Some("/home/u/proj")` → `Path("/home/u/proj/src/main.rs")`; relative with `cwd=None` → `RelativeWithoutCwd`; `README.md#L42` and `README.md?x=1` (both with `cwd=Some("/home/u/proj")`) → the same path, fragment/query gone; `www.example.com/x` → `Url("http://www.example.com/x")`; `notes:2024.md` with a cwd → `Path("<cwd>/notes:2024.md")` (NOT `Url`); `mailto:a@b.c` and `tel:+15551234` → `Url`; `""` and `"   "` → `Empty`; `file://otherhost/x` → `BadFileUrl`.
- [ ] Add the platform-split `file:` rows SEPARATELY, because `Url::to_file_path()` is `#[cfg(windows)]`-split and its Windows branch requires a drive-letter first segment (`/tmp/…` → `Err`): gate `file:///tmp/a%20b.md#L3` → `Path("/tmp/a b.md")` behind `#[cfg(unix)]`, and add `file:///C:/dir/f` → `Path("C:\\dir\\f")` behind `#[cfg(windows)]`. An ungated `/tmp` row reddens `cargo test` for a Windows contributor.
- [ ] Add the tilde row as its OWN `#[test]`, NOT in the table: `crate::skills::home_dir()` reads `HOME`, and `cargo test` runs tests as threads of ONE process. This crate explicitly refuses to mutate `HOME` in the lib test binary (`src-tauri/src/commands/files.rs:1098-1118` explains the race with `tools::sandbox`'s git-config lookup, `crashlog`, `mcp::oauth`, `commands::mcp`), and its convention is `crate::test_support::env_lock()` + a drop-restoring guard around `unsafe { std::env::set_var(..) }` — copy the `RestoreHome`-style guard from `src-tauri/src/commands/agents.rs:132-177` and `src-tauri/src/test_support.rs:5-16`.
- [ ] Run `cd src-tauri && cargo test open::` — did it fail to compile / fail on the assertions because `open.rs` is empty or absent? If it passed, stop and find out why.
- [ ] Implement `open.rs` + add `pub mod open;` to `src-tauri/src/lib.rs`.
- [ ] Run `cd src-tauri && cargo test open::` — all green? Fix and re-run before continuing.
- [ ] Replace `production_open_browser`'s body in `src-tauri/src/agent/mcp/manager.rs`.
- [ ] Run `cd src-tauri && cargo test` — the MCP OAuth tests still pass (they inject their own `open_browser` seam, so they never reach the platform opener; if one now fails, you changed the seam, not the body).
- [ ] Run `cd src-tauri && cargo clippy --all-targets -- -D warnings` and `cargo fmt --all`.
- [ ] Commit: `feat(open): add crate::open — the External-open policy; route the MCP OAuth opener through it`

**Acceptance criteria:**
- [ ] `classify` is pure and covers every row of the decision table; the `C:/` case is caught before `Url::parse`.
- [ ] `java\nscript:` is refused, not passed to the OS.
- [ ] The repo contains exactly one per-OS opener implementation, and it is in `open.rs`'s dependency (`tauri-plugin-opener`), not in `archimedes` code.
- [ ] `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check` green.

---

### Task 2: the `external_open` command and the `externalOpen` wrapper

**Context:**
Task 1's policy is Rust-only. The renderer needs it, so this task adds the thin IPC wrapper and its TypeScript twin. The wire contract is the fragile part: a renamed arg key passes every Rust test and every JS test and fails only in the running app — the repo already pins this class of drift in `src/lib/tauri.test.ts`, and this task follows that pattern exactly.

**Files:**
- Create: `src-tauri/src/commands/open.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod open;` to the list at lines 1-10)
- Modify: `src-tauri/src/lib.rs` (`commands::open::external_open` in `tauri::generate_handler![…]`, lines 248-286)
- Modify: `src/lib/tauri.ts`
- Test: `src/lib/tauri.test.ts`

**What to implement:**

`src-tauri/src/commands/open.rs`:

```rust
#[tauri::command]
pub async fn external_open(href: String, cwd: Option<String>) -> Result<(), String> {
    crate::open::open(&href, cwd.as_deref().map(std::path::Path::new))
}
```

(`as_deref()` alone yields `Option<&str>`; `open` takes `Option<&Path>`. Do NOT "fix" this by re-typing `open`/`classify` to `Option<&str>` — the `PathBuf::join` in the path route is the whole reason the policy is in Rust.)

That is the whole command — no scope check here (deliberate, ADR 0051), no logging beyond what `open` returns.

`src/lib/tauri.ts` — next to the other command wrappers:

```ts
/** External open (ADR 0051): hand `href` to the OS default handler. A relative
 * href is a path resolved against `cwd` (the active Session's `cwd`, i.e. its
 * **Space**); with no `cwd` a relative href is refused. NEVER rejects — a
 * refusal or an OS failure lands in `console.warn` with the typed reason. */
export async function externalOpen(href: string, cwd?: string | null): Promise<void> {
  try {
    await invoke("external_open", { href, cwd: cwd ?? null });
  } catch (err) {
    console.warn(`external open refused: ${String(err)}`, href);
  }
}
```

**What NOT to change:** nothing in `capabilities/`; do not remove the `@tauri-apps/plugin-opener` npm dep or the `tauri_plugin_opener::init()` registration — retiring them is a separate concern and this plan leaves them in place.

**Steps:**
- [ ] In `src/lib/tauri.test.ts`, following that file's existing `vi.mock("@tauri-apps/api/core")` wire-contract style, write a failing test: `await externalOpen("https://x.test", "/home/u/proj")` calls `invoke` with `"external_open"` and `{ href: "https://x.test", cwd: "/home/u/proj" }`; a second case with `cwd` omitted asserts `cwd: null` on the wire (NOT `undefined` — an absent key would deserialize to `None`, but `null` is what this wrapper promises); a third case where `invoke` rejects asserts the promise RESOLVES and that `console.warn` was called (spy with `vi.spyOn(console, "warn")`).
- [ ] Run `pnpm test src/lib/tauri.test.ts` — fails because `externalOpen` does not exist? If it passed, stop and investigate.
- [ ] Add `externalOpen` to `src/lib/tauri.ts`.
- [ ] Run `pnpm test src/lib/tauri.test.ts` — green.
- [ ] Add the Rust command + `pub mod open;` + the `generate_handler!` entry.
- [ ] Run `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --all -- --check` — green.
- [ ] Run `pnpm build` (type-check) — green.
- [ ] Commit: `feat(open): expose external_open over IPC and the externalOpen wrapper`

**Acceptance criteria:**
- [ ] The command name and both arg keys are pinned by a test on the JS side.
- [ ] `externalOpen` never rejects; a refusal is a `console.warn`, not an unhandled rejection.
- [ ] Both roots green.

---

### Task 3: the navigation guard — the Client can no longer navigate away

**Context:**
Today Tauri's default `on_navigation` hook returns `true`, so a click on any un-intercepted anchor replaces the Client's own page with someone else's — in a frameless window with no back and no reload. Per-anchor handlers fix the anchors we know about; this task makes the failure structurally impossible for the anchors nobody has written yet. The window is declared in `tauri.conf.json`, so `WebviewWindowBuilder::on_navigation` is unreachable; `tauri::plugin::Builder::on_navigation` is the route that works for config-created windows. Getting the allowed set wrong bricks the app (a refused initial load, or a refused `invoke` on Windows), so the predicate is a pure function with tests.

**Files:**
- Create: `src-tauri/src/navigation_guard.rs`
- Modify: `src-tauri/src/lib.rs` (module list; register the plugin alongside the other `.plugin(...)` calls around lines 240-247)
- Test: unit tests in `src-tauri/src/navigation_guard.rs`

**What to implement:**

```rust
use tauri::Url;

/// The app's OWN url: the dev server, the custom protocol, `about:blank`
/// (the initial load passes through `on_navigation`), and the dev HMR socket.
/// Everything else — every real website — is refused.
/// `dev_host` is the `TAURI_DEV_HOST` env value when set (`vite.config.ts:5-6`
/// serves the dev bundle from a LAN address in that mode), so the guard does
/// not brick `pnpm tauri dev` with that variable set.
pub fn is_app_url(url: &Url, dev_host: Option<&str>) -> bool
```

Rules, exactly:
- `scheme == "tauri"` → `true` (the custom protocol on macOS/Linux, and the IPC origin `tauri://localhost`).
- `scheme` is `http` or `https` → `true` iff the host is `localhost`, `127.0.0.1`, or ANY `<name>.localhost` (that covers `tauri.localhost` on Windows, `ipc.localhost` and `asset.localhost`; a host under `.localhost` only resolves when a custom protocol of that name is registered, so no web content can be served there — pin it as accepted with that reason), or the `dev_host`.
- `scheme` is `ws` or `wss` → `true` iff the host is `localhost`, `127.0.0.1`, or the `dev_host` (Vite HMR; `vite.config.ts:27-32` pins it to port 1421 when `TAURI_DEV_HOST` is set).
- `scheme == "about"` and `url.path() == "blank"` → `true`.
- everything else → `false`.

Plugin registration in `lib.rs`, next to the existing `.plugin(...)` calls:

```rust
let dev_host = std::env::var("TAURI_DEV_HOST").ok();
let navigation_guard = tauri::plugin::Builder::new("navigation-guard")
    .on_navigation(move |_webview, url| crate::navigation_guard::is_app_url(url, dev_host.as_deref()))
    .build();
// … .plugin(navigation_guard)
```

**What NOT to change:** do not add an `on_new_window` handler (no plugin hook exists for it; the default already denies, and Task 7 removes the only `target="_blank"` in the app). Do not touch `app.security.csp` in `tauri.conf.json`.

**Steps:**
- [ ] Write the failing tests (all calling `is_app_url(url, None)` unless stated): allowed — `tauri://localhost`, `tauri://localhost/index.html`, `http://localhost:1420/`, `http://localhost:1420/#/x`, `http://tauri.localhost/`, `https://tauri.localhost/`, `http://ipc.localhost/`, `about:blank`, `ws://localhost:1420/`, `http://example.com.localhost:1420/` (pin it with the `.localhost` reason as a comment); with `dev_host = Some("192.168.1.20")` — `http://192.168.1.20:1420/` and `ws://192.168.1.20:1421/`. Refused — `https://example.com/`, `file:///etc/passwd`, `javascript:alert(1)`, `data:text/html,x`, `ftp://host/x`, `slack://chan`, and `https://example.com/` AGAIN with `dev_host` set.
- [ ] Run `cd src-tauri && cargo test navigation_guard` — fails because the module does not exist? Good.
- [ ] Implement `is_app_url` + register the plugin.
- [ ] Run `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --all -- --check` — green.
- [ ] **Manual check on Linux** (`pnpm tauri dev`, or the built app): the app still loads, IPC still works (the sidebar lists Spaces — that requires `invoke`), and clicking an `https://` link in a transcript no longer changes what the window displays. If the app fails to load, the predicate is wrong for this platform's app URL — fix the predicate, not the window config.
- [ ] Commit: `feat(open): refuse navigation to any origin that is not the app's own`

**Acceptance criteria:**
- [ ] `is_app_url` is pure and fully tested; the four allowed classes and the refused set are each pinned.
- [ ] The app loads and `invoke` still works with the guard registered (checked on at least this platform).
- [ ] `cargo` trio green.

---

### Task 4: the renderer primitives — `SpaceCwdProvider`, `OpenAnchor`, `linkifyText`

**Context:**
Three surfaces need the same behaviour (prose anchors, linkified tool output, settled thinking) and each needs the active **Session**'s `cwd` to resolve a relative path. `OpenAnchor` is the ONE shared piece — it reads the cwd from context, so no surface threads a prop through six components. `linkifyText` exists because `remark-gfm`'s autolink literals only cover prose; a plain `<pre>` of tool output is one text node with nothing in it.

**Files:**
- Create: `src/components/SpaceCwd.tsx` (NOT `src/lib/` — every file in `src/lib/` is plain `.ts`; a provider returning JSX does not belong there, and `src/hooks/` is `.ts`-only too)
- Create: `src/components/OpenAnchor.tsx`
- Create: `src/lib/linkify.tsx`
- Test: `src/lib/linkify.test.tsx`, `src/components/OpenAnchor.test.tsx`

**What to implement:**

`src/components/SpaceCwd.tsx`:

```tsx
/** The active Session's `cwd` (= its **Space**'s folder) for everything that
 * External-opens a relative path. `useSpaceCwd` deliberately returns `null`
 * rather than throwing when no provider is mounted: a surface outside the
 * provider then resolves NO relative path, and `external_open` refuses it —
 * the safe direction, and it keeps every component renderable in isolation. */
export function SpaceCwdProvider({ cwd, children }: {
  cwd: string | null; children: ReactNode;
}): ReactElement;
export function useSpaceCwd(): string | null;
```

Write `SpaceCwdProvider` as a `function` declaration returning `ReactElement` (imported from `react`). Do NOT annotate it `=> JSX.Element`: this repo's `@types/react@19` has no global `JSX` namespace (it is only `React.JSX`), so that spelling fails `pnpm build` with `TS2503: Cannot find namespace 'JSX'`.

`src/components/OpenAnchor.tsx`:

```tsx
export default function OpenAnchor({ href, className, children }: {
  href: string; className?: string; children?: ReactNode;
}) {
  const cwd = useSpaceCwd();
  return (
    <a href={href} className={className}
       onClick={(e) => { e.preventDefault(); void externalOpen(href, cwd); }}>
      {children}
    </a>
  );
}
```

Keep `href` on the element (hover target, focus, copy-link all still work). Intercept every LEFT-click and modifier-click (ctrl/cmd/shift) — the Client has no "open in a new tab", so a modifier must not mean something else. Do NOT add `onMouseDown`/`onAuxClick`: keyboard `Enter` on a focused anchor already dispatches a `click`, which this handler cancels; a middle click dispatches none, and that case is covered by the absence of `target` (wry denies the new-window request by default) plus Task 3's navigation guard. Do not add `target`/`rel`.

`src/lib/linkify.tsx` (a pure text-splitting helper that happens to return nodes — `src/lib` is by ROLE, not by extension: the provider above is a mounted **component** and so lives in `src/components`, while this is a function no one mounts):

```tsx
/** Split a plain-text run into text + `OpenAnchor`s. GFM's autolink shape:
 * `http(s)://`, `www.` (which GFM turns into `http://www.…`) and `mailto:`. */
export function linkifyText(text: string): ReactNode[]
```

- One module-level regex with the `g` flag; note a `g` regex is stateful, so reset `lastIndex` (or build it inside the function) — a shared `lastIndex` is a real bug class here.
- **Give every anchor a `key`** (`key={index}` over the emitted segments; plain-string segments need none). `linkifyText` returns an ARRAY used as JSX children, so an unkeyed element makes React log `Each child in a list should have a unique "key" prop` on every card that contains a URL — a `console.error` in a repo whose test suite asserts a clean console elsewhere.
- Trim trailing punctuation `.,;:!?)]}"'` off each match before using it (`See https://x.com/a.` must not swallow the full stop). If trimming empties it, emit text.
- A `www.` match becomes `href = "http://" + match`.
- Non-matching segments render as plain strings; preserve the original characters byte-for-byte (the caller is `whitespace-pre-wrap` text — do not collapse spaces or newlines, and do not wrap in extra elements that break `break-words`).

**What NOT to implement:** no prose linkifier (GFM already autolinks — see "Read this before starting"); no linkifying inside inline `code` spans or code fences; no `title` tooltips; no "copy link" affordance.

**Steps:**
- [ ] Write failing tests in `src/lib/linkify.test.tsx`: `see https://x.test/a and done.` produces ONE anchor whose `href` is `https://x.test/a` and whose text is `https://x.test/a` (the trailing full stop stays in the text, not the href); `www.foo.com` → `href="http://www.foo.com"`; `mailto:a@b.c` → `href="mailto:a@b.c"`; `git@github.com:x/y.git` produces NO anchor (an e-mail-ish / scp-ish shape is not a URL); `a\nhttps://x.test\nb` keeps the `\n` in the text segments; a string with no URL renders byte-identical; two URLs in one string produce two anchors AND emit no console error (spy `console.error` — this is the test that catches both a shared `lastIndex` and a missing `key`).
- [ ] Write a failing test in `src/components/OpenAnchor.test.tsx`: render `<SpaceCwdProvider cwd="/home/u/proj"><OpenAnchor href="src/main.rs">m</OpenAnchor></SpaceCwdProvider>`, `fireEvent.click`, assert the mocked `externalOpen` from `../lib/tauri` was called with `("src/main.rs", "/home/u/proj")`; a second case with NO provider asserts `(href, null)`; a third asserts `preventDefault` happened (assert `event.defaultPrevented` from a `onClick` spy on a parent, or `expect(handler).toHaveBeenCalled()` + the anchor has no navigation in jsdom).
- [ ] Run `pnpm test src/lib/linkify.test.tsx src/components/OpenAnchor.test.tsx` — both fail because the modules are absent? Good.
- [ ] Implement the three modules.
- [ ] Run `pnpm test src/lib/linkify.test.tsx src/components/OpenAnchor.test.tsx` then `pnpm build` — green.
- [ ] Commit: `feat(open): add OpenAnchor, linkifyText and the SpaceCwd provider`

**Acceptance criteria:**
- [ ] `useSpaceCwd()` returns `null` with no provider — no throw, every existing test still mounts these components bare.
- [ ] `linkifyText` never alters a string that contains no URL, and never loses whitespace.
- [ ] Two anchors in one string work (stateless across calls).

---

### Task 5: prose links, and mounting the cwd provider

**Context:**
The markdown link renderer is the surface the user reported: a plain `<a href>` with no handler, which today navigates the Client's own page away (Task 3 stops that; this task makes the click do the useful thing instead). It also needs the `urlTransform` override, because `react-markdown@10`'s default filter blanks every protocol outside `http|https|irc|ircs|mailto|xmpp` — without the override, the wide scheme policy from ADR 0051 is unreachable and `ssh://` renders `href=""`. And the cwd provider must be mounted in `App`, not `ChatStream`, because the subagent sheet is a sibling of the workspace view (`App.tsx:357`).

**Files:**
- Modify: `src/components/MessageBubble.tsx` (the `a` renderer at lines 435-448; the `components` `useMemo` deps at 461-463; the `<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>` call at line 470)
- Modify: `src/App.tsx` (the `data-testid="content-row"` div at 337-375 — see below)
- Modify: `src/components/ChatStream.tsx` (line 490's `spacePath` — read it through the new hook)
- Create: `src/hooks/useActiveSpaceCwd.ts`
- Test: `src/components/MessageBubble.markdown.test.tsx`, `src/hooks/useActiveSpaceCwd.test.ts` (every other hook in `src/hooks/` has a co-located test — this module OWNS the derivation, so it is the one that must pin it)

**What to implement:**

`src/hooks/useActiveSpaceCwd.ts` — the single shared implementation of the derivation `ChatStream.tsx:86-103 + 490` performs today: the live session's `cwd` (`s.sessions.find(x => x.sessionId === s.activeSessionId)`), else the stored one (searching BOTH stored lists, because a session living only in `archivedSessions` must still resolve — that half is at `:99-101`), else `null`. Return the `string | null` directly from the selector — never a fresh object or array (`ChatStream.tsx:80-81` states the stable-reference rule; breaking it makes `pnpm test` hang).

`ChatStream.tsx:490` then becomes `const spacePath = useActiveSpaceCwd();`, keeping the existing comment. **Do not delete `liveSession` (86-90) or `historySession` (96-103)** — they have other consumers (`:387` reads `capabilities`; `:882-885` derive `isLive` / `isHistoryOnly` / `canResume` → `composerEnabled`), so they stay and `spacePath` simply stops re-deriving the cwd. The rule this task establishes is "the cwd derivation lives in exactly ONE module", not "`ChatStream` has one store selector". Keep the hook call ABOVE the `!activeSessionId` early return (at `:913`; the hook-count rule is documented at `:474-483`) — placing a hook conditionally crashes the app on the session/no-session transition.

`src/App.tsx` — one `SpaceCwdProvider cwd={useActiveSpaceCwd()}` inside the `data-testid="content-row"` div (`:337`), wrapping **both** the settings/workspace ternary (from `:338`) **and** `<SubagentModals …>` at `:374`, i.e. children `:338-374`. That is the only placement that is outside the ternary (so the sheet at `:357` is inside) AND leaves `SubagentModals` inside. Note for the record: this is `App`'s first subscription to the SESSIONS store (it already subscribes to the left-pane flag via `useSyncExternalStore` at `:261`), so `App` re-renders on session-list/active-session changes — acceptable (`applySessionUpdates` rewrites `messages`, not the lists, so streaming does not trigger it), and do not "optimise" it with a memo wrapper.

`src/components/MessageBubble.tsx`:
- Replace the `a` renderer's element with `<OpenAnchor href={href ?? ""} className="text-ui-base font-medium text-icon-blue no-underline decoration-dotted underline-offset-4 hover:underline">{children}</OpenAnchor>` — the className is unchanged from today's anchor.
- Keep the `components` `useMemo` deps as `[]`. It stays correct because `OpenAnchor` reads the cwd from context itself; if you feel the urge to add `cwd` to the deps, delete it instead.
- Add the exported transform and pass it: `urlTransform={safeUrlTransform}`.

```tsx
/** ADR 0051: the External-open policy is Rust-side; this ONLY stops
 * react-markdown blanking the schemes we ALLOW (its default filter is
 * `http|https|irc|ircs|mailto|xmpp`), and keeps refusing the executable ones so
 * no script-bearing href is ever in the DOM (a middle click or an `Enter` on a
 * focused anchor does not pass through a cancelable click). Deliberately NOT
 * percent-encoding — the href goes to the OS verbatim. NOTE this transform
 * governs `img src` too: `data` stays denied, so a markdown `data:` image stays
 * blanked exactly as it is today — do not "widen" DENIED later. */
const DENIED = ["javascript", "data", "vbscript", "blob", "filesystem"];
const SCHEME = /^[a-z][a-z0-9+.-]*$/i;
export function safeUrlTransform(url: string): string {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  const q = url.indexOf("?");
  const hash = url.indexOf("#");
  const relative =
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (q !== -1 && colon > q) ||
    (hash !== -1 && colon > hash);
  if (relative) return url;
  const scheme = url.slice(0, colon);
  // The token before `:` must be a LEGAL scheme. micromark hands this function
  // an already-percent-encoded destination, so `java&#9;script:` arrives as
  // `java%09script:alert(1)` — a `%` is illegal in a scheme, and without this
  // test the override would let through a class the DEFAULT filter refused.
  return SCHEME.test(scheme) && !DENIED.includes(scheme.toLowerCase()) ? url : "";
}
```

**What NOT to change:** the ZCode markdown scale (every other entry of `components`), the `code` renderer, `CodeBlock`, `react-markdown`'s `remarkPlugins`.

**Steps:**
- [ ] Write the failing `src/hooks/useActiveSpaceCwd.test.ts` first (the `src/hooks/useSessionStatus.test.ts` pattern — `useSessions.setState(...)` then `renderHook`): a live session wins; a session living only in `archivedSessions` still resolves; neither → `null`; and the selector returns a `string | null` (assert `Object.is(result.current, result.current)` across a re-render — never a fresh object). Then continue below.
- [ ] Add the failing tests to `src/components/MessageBubble.markdown.test.tsx`. Mock the IPC module with the **`importActual` spread** form used by `src/components/SessionStalledBanner.test.tsx:11-22` — `vi.mock("../lib/tauri", async () => ({ ...(await vi.importActual<Record<string, unknown>>("../lib/tauri")), externalOpen: vi.fn() }))` — because this file does not mock that module today and its graph reaches it transitively (`MessageBubble` → `SubagentDelegatingCard`/`ToolCallCard` → the stores); a factory-only mock deletes the other exports and fails the whole file. Wrap `render` in `SpaceCwdProvider` where a cwd matters):
  - `[docs](https://x.test/a)` renders an anchor that keeps its `href` AND, on click, calls `externalOpen("https://x.test/a", null)`.
  - `[GH](ssh://host/repo)` keeps `href="ssh://host/repo"` (this is the test that fails against react-markdown's default filter — it pins why `safeUrlTransform` exists).
  - `<javascript:alert(1)>`-style input (`[x](javascript:alert(1))`) renders an anchor whose `href` is `""` and does not throw.
  - `[main.rs](src/main.rs)` inside `<SpaceCwdProvider cwd="/home/u/proj">` calls `externalOpen("src/main.rs", "/home/u/proj")`.
  - `see https://x.test/a` (bare, no markdown link) renders an anchor — the GFM autolink rides the same handler. If it does NOT render as an anchor, stop and re-check the renderer setup rather than adding a linkifier.
  - `unit test for safeUrlTransform` cases: `"https://a"`, `"a/b.md"`, `"C:/x"`, `"ssh://h/r"` pass through; `"JavaScript:alert(1)"` (mixed case) → `""`; `"data:text/html,x"` → `""`; and `java%09script:alert(1)` (what `[x](java&#9;script:alert(1))` reaches this function as) → `""` — that row is the proof the scheme-shape test earns its place.
- [ ] Run `pnpm test src/components/MessageBubble.markdown.test.tsx` — new cases fail? If the `ssh://` case passes already, you are not looking at react-markdown's default filter — investigate before continuing.
- [ ] Implement the `a` renderer swap, `safeUrlTransform`, `useActiveSpaceCwd`, and the `App` provider.
- [ ] Run `pnpm test src/components/MessageBubble.markdown.test.tsx` — green.
- [ ] Run `pnpm test` — `ChatStream`'s existing `?`-completion / Mention tests still pass with the hook (the derivation must be identical); `MessageBubble.test.tsx`'s memo/frequency pins are unaffected.
- [ ] Run `pnpm build` — green.
- [ ] Commit: `feat(ui): transcript links External-open; provide the Space cwd app-wide`

**Acceptance criteria:**
- [ ] No transcript anchor can navigate the Client, and each calls `externalOpen` with the context cwd.
- [ ] `ssh://` / `slack://` / `file://` survive to the DOM; `javascript:` / `data:` / `java%09script:` do not.
- [ ] The active-Space-cwd derivation lives in exactly one module (`useActiveSpaceCwd`), used by both `ChatStream`'s `spacePath` and `App`'s provider.
- [ ] `pnpm test` and `pnpm build` green.

---

### Task 6: tool output, and the file chip that is not inside a button

**Context:**
Tool output is a plain `<pre>` (`ToolCallCard.tsx:105` and `:128`) — a settled single text node, so `linkifyText` is cheap there and a URL printed by `bash` becomes clickable. The file chip becomes clickable ONLY at `ToolCallCard.tsx:115`: every other `FileChip` call site sits inside a toggle `<button>` — `ToolCallCardHeader.tsx:99` inside the `<button>` opened at `:82` (`onClick={onToggle}` at `:84`), and `ChangesGroupCard.tsx:211`, `:229` and `:234` inside the `<button>` opened at `:168` — where a nested interactive element is invalid HTML whose click would also toggle the card. The chip is a file, not a URL, so it renders as a `<button>` calling `externalOpen` — an `<a>` would be a lie.

**Files:**
- Modify: `src/components/ToolCallCard.tsx` (lines 100-135)
- Modify: `src/components/FileChip.tsx`
- Test: `src/components/ToolCallCard.test.tsx`

**What to implement:**

`FileChip.tsx` — add an optional `onOpen?: () => void`. When present, render the SAME icon+name markup inside `<button type="button" onClick={onOpen} title={path}>` with `cursor-pointer hover:text-foreground` (and the existing `title={path}` moved to the button); when absent, keep today's non-interactive `<span>` EXACTLY as it is, so the header chips at `ToolCallCardHeader.tsx:99` and `ChangesGroupCard.tsx:211`/`:229`/`:234` are byte-identical and the responsive chip-width measurement in `ChangesGroupCard` is untouched. Update the component doc comment: it currently says "Non-clickable in v1" — say that it is clickable where the caller passes `onOpen`, and say WHY only one caller does (the nesting constraint, with the file:lines).

`ToolCallCard.tsx`:
- `<pre>` at `:128` (the output): render `linkifyText(output.length > 20000 ? output.slice(0, 20000) + "…" : output)` — keep the truncation and the `…` and the trailing "truncated — N chars total" paragraph exactly as they are.
- `<pre>` at `:105` (the shell command): `linkifyText(command)` too — a `curl https://…` line is the commonest clickable URL in this app's output. If the existing test pins the raw command string, keep its text identical (linkify must not alter text that has no URL in it).
- The body chip at `:115`: pass `onOpen={() => void externalOpen(files[0].path, cwd)}` where `const cwd = useSpaceCwd()` is read at the TOP of the component (a hook may not be called inside the JSX of a conditional branch — hoist it). Do NOT pass `onOpen` at any other call site. Note `ChangesGroupCard.tsx:248` renders `ToolCallCard`s in its own EXPANDED body, so a card nested inside an open Changes group gets a clickable chip too — correct, and the reason the nesting assertion below is scoped to the header row.

**What NOT to change:** `DiffBlock` (the edit view stays inert), `ChangesGroupCard`'s layout and measurement code, `FileChip`'s inert default, `MessageBubble`'s `code`/`CodeBlock`. And do not wrap the linkified output in a `useMemo` to "fix" the fact that `ToolCallCard` is not memoized (only `MessageBubble` is): re-splitting a ≤ 20 000-char string on a status change is not a cost worth a memo, and a memo whose deps are got wrong changes the truncation the tests pin.

**Steps:**
- [ ] Write failing tests in `src/components/ToolCallCard.test.tsx` (mock `../lib/tauri`'s `externalOpen`): a card whose `rawOutput` contains `https://x.test/a` renders an anchor in the expanded body and clicking it calls `externalOpen("https://x.test/a", <cwd or null>)`; the output's whitespace is preserved (`textContent` still contains the raw newline); the truncation case still shows `…` and the "truncated" line; the body file row's chip is a `button` whose click calls `externalOpen("<path>", <cwd>)` when rendered inside `SpaceCwdProvider`; the collapsed header chip is NOT a button (assert `queryByRole("button", { name: <basename> })` is absent from the header row) — that is the nesting pin.
- [ ] Run `pnpm test src/components/ToolCallCard.test.tsx` — fails as expected? Good.
- [ ] Implement the `FileChip` prop and the two `<pre>` swaps plus the body `onOpen`.
- [ ] Run `pnpm test src/components/ToolCallCard.test.tsx src/components/ChangesGroupCard.test.tsx` — green (there is no `FileChip.test.tsx` — do not add a filter for a file that does not exist; vitest exits 1 on "No test files found", and the Changes group must be untouched).
- [ ] Run `pnpm test && pnpm build` — green.
- [ ] Commit: `feat(ui): linkify tool output and open the expanded-body file chip`

**Acceptance criteria:**
- [ ] A URL printed in tool output is clickable; text without a URL renders byte-identically.
- [ ] Exactly one `FileChip` call site is interactive; no interactive element is nested in a `<button>`.
- [ ] The diff/edit view renders no anchor.

---

### Task 7: settled thinking, and the two remaining anchors

**Context:**
Three loose ends. `Reasoning` renders its body as plain text on purpose — re-parsing markdown per streamed chunk was a real perf bug (`Reasoning.tsx:575-580`), which is also why linkifying there must wait for the thought to SETTLE; the flag already exists (`isStreaming`, already in `ReasoningContext`, already in the memo deps at `:214-217`, and passed by both mount sites — `MessageBubble.tsx:548-554` and `SubagentTranscript.tsx:108-119`). Then the two links outside the transcript: Settings' "Get key" (`target="_blank"`, silently denied by wry — a dead control in a shipped screen) and the stalled banner's crash log (`openPath`, denied by the capability — the bug that motivated this branch).

**Files:**
- Modify: `src/components/Reasoning.tsx` (`ReasoningContent` from line 447, its `useReasoning()` destructure at `:449`, the body `<div>` at `:581` whose `{children}` is at `:585`)
- Modify: `src/components/settings/ProviderSection.tsx` (lines 161-169)
- Modify: `src/components/SessionStalledBanner.tsx` (line 3 import, line 46 handler)
- Test: `src/components/Reasoning.test.tsx`, `src/components/settings/SettingsPage.test.tsx`, `src/components/SessionStalledBanner.test.tsx`

**What to implement:**

`Reasoning.tsx` — in `ReasoningContent`, also destructure `isStreaming` from the existing `useReasoning()` call (line 449), and render the body as:

```tsx
{isStreaming ? children : linkifyText(children)}
```

No `typeof children === "string"` guard: `ReasoningContentProps.children` is typed `string` (`:443`), so the guard's else-arm is dead code. No markdown is introduced here.

`ProviderSection.tsx` — the `keyUrl` anchor: drop `target="_blank"` and `rel="noreferrer"`, add `onClick={(e) => { e.preventDefault(); void externalOpen(provider.keyUrl!); }}`. Keep its classes and the `Get key` label (the Settings test finds it by text). A relative `keyUrl` cannot occur (the catalog stores absolute base URLs), so no cwd is passed.

`SessionStalledBanner.tsx` — delete the `import { openPath } from "@tauri-apps/plugin-opener"` and use `externalOpen(stalled.crashLog!)` from `../lib/tauri` (already a mocked module in that test). Update the doc bullet that names `tauri-plugin-opener` `openPath` → the External-open seam (ADR 0051).
**Steps:**
- [ ] Failing tests:
  - `Reasoning.test.tsx`: with `isStreaming` true, an expanded body containing `https://x.test/a` renders NO anchor; after the thought settles (that file already rerenders to flip streaming → settled, e.g. its `:107-145` sequence), the same text renders ONE anchor.
  - `SettingsPage.test.tsx`: set `keyUrl` to `"https://keys.test/get"` in the **INLINED `getSettings` fixture** (the mock at `:71-74`, whose `getSettings: vi.fn().mockResolvedValue({…})` starts at `:78` and whose provider row has `keyUrl: null` at `:93`) — NOT the `baseSettings` const at `:28`, which only feeds the save-assertions (`:382`+); the file's own comment at `:76-77` says why the two exist. ALSO add `externalOpen: vi.fn()` to that same `importActual`-spread mock, or `externalOpen` resolves to the real wrapper (Task 2), which swallows its own failure and can never be asserted on. Then `go("Providers")` (`:329`), `fireEvent.click(screen.getByText("Get key"))`, assert `externalOpen` was called with `"https://keys.test/get"`, and assert the anchor has no `target` attribute.
  - `SessionStalledBanner.test.tsx`: delete the `import { openPath } from "@tauri-apps/plugin-opener"` at `:5` (leaving it is an unused import — `noUnusedLocals` makes `pnpm build` fail on it) and import `externalOpen` from `../lib/tauri` instead; replace the `vi.mock("@tauri-apps/plugin-opener", …)` block (lines 24-28) by adding `externalOpen: vi.fn()` to that file's EXISTING `../lib/tauri` `importActual`-spread mock; change the `:83` test ("…calls openPath when present") to assert `externalOpen` was called with `"/data/crash-123-worker.log"` — the path the fixture already uses. Update the mock's comment at `:24`, which still names `openPath`.
- [ ] Run `pnpm test src/components/Reasoning.test.tsx src/components/settings/SettingsPage.test.tsx src/components/SessionStalledBanner.test.tsx` — all three fail as expected? Good.
- [ ] Implement the three changes.
- [ ] Run that same command — green.
- [ ] Run `pnpm test && pnpm build`, then `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --all -- --check` — green.
- [ ] Confirm nothing imports the opener JS module any more: `grep -rn "@tauri-apps/plugin-opener" src` returns nothing. Leave the npm dependency and the Rust plugin registration in place (deliberate — see Task 2).
- [ ] Commit: `feat(ui): External-open settings key links, crash logs, and settled-thinking URLs`

**Acceptance criteria:**
- [ ] A thinking block linkifies only once its run settles — no per-chunk regex while streaming.
- [ ] "Get key" and the crash-log path both reach `external_open`; no `target="_blank"` remains in `src/`.
- [ ] Both roots fully green.

---

## Ship check

- [ ] `pnpm test`, `pnpm build` (root) and `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check` (`src-tauri/`) all green.
- [ ] Manual, on Linux: a web link opens the default browser; a `mailto:` opens the mail client; `~/notes.md` opens under `$HOME`; a relative path and the expanded-body chip open the file; a `#L42` anchor on a path still opens the file; clicking any of them never changes what the Client is displaying.
- [ ] Manual, on macOS and Windows (the `open`/`cmd start` behaviour is platform code we do not own): same list. On Windows specifically, a `C:\…` path href and a UNC path href open their file, and IPC still works with the guard registered (`http://tauri.localhost` / `http://ipc.localhost` must be allowed).
- [ ] On ship: fold the durable behaviour into `docs/features/` and delete this roadmap doc (history lives in git). ADR 0051 and the `CONTEXT.md` **External open** entry stay.
