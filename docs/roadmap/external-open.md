---
status: approved
done-when: clicking a link in a transcript opens it in the OS default handler on Linux, macOS and Windows, and the Client's own page never navigates — verified by hand on each platform (no CI can assert what xdg-open launched).
---

# External open — links, paths and chips reach the OS default handler

## Problem

Four mechanisms in the Client try to open something outside itself, and each fails differently.

| Site | Today | Why it fails |
|---|---|---|
| `MessageBubble.tsx:442` — a markdown link | plain `<a href>`, no handler | Tauri's default `on_navigation` hook returns `true` (`tauri-2.12.2/src/plugin.rs:287`), so the click **navigates the Client's own webview**. Frameless window, no back, no reload: the workspace view is gone. |
| `settings/ProviderSection.tsx:162` — "Get key" | `target="_blank"` | The app installs no `on_new_window` handler, so wry's default denies the new-window request → the control is silently dead. |
| `SessionStalledBanner.tsx:46` — the crash log | `openPath()` from `@tauri-apps/plugin-opener` | `capabilities/default.json` grants `opener:default` = `allow-open-url` + `allow-reveal-item-in-dir` + `allow-default-urls`. There is **no `allow-open-path`** in it → the command is refused by the ACL. |
| `agent/mcp/manager.rs:363` — the MCP OAuth browser open | hand-rolled `open` / `cmd /c start` / `xdg-open` | Works, and is the only per-OS opener code in the repo. |

The plugin that does what we want (`tauri-plugin-opener`, Rust 2.5.5 / JS 2.5.5) is already registered in `lib.rs:242`. Nothing new gets installed.

## What it means

**External open** (added to `CONTEXT.md`): handing a URL or a filesystem path to the OS's own default handler. One seam, `crate::open`, behind a thin `external_open { href, cwd }` command. See ADR 0051 for why that seam deliberately bypasses the Tauri ACL.

## Behaviour — the decision table (`classify`)

Normalise FIRST: strip every tab / LF / CR and trim. Markdown can spell `javascript:` as `java&#10;script:`, and that bypass is closed here, not downstream.

| href | route | result |
|---|---|---|
| `https://`, `http://`, `mailto:`, `tel:` | URL | OS default for the scheme |
| any other scheme — `slack://`, `ssh://`, `ftp://`, … | URL | OS default. The policy is a **denylist**, not an allow-list |
| `javascript:`, `data:`, `vbscript:`, `blob:`, `filesystem:` | — | refused (`DeniedScheme`) |
| `file:///abs`, `file://localhost/abs` | Path | strip scheme, percent-decode, `/C:/x` → `C:/x`; a host that is not empty/`localhost` is refused |
| `file://otherhost/abs` | — | refused |
| `/abs/path`, `C:\dir\f`, `C:/dir/f` | Path | used as given |
| `~/notes.md` | Path | expanded with `skills::home_dir()` — the ONE tilde the app expands (ADR 0051) |
| `src/main.rs` | Path | `cwd.join(href)` via `PathBuf` (never a string concat — Windows); refused when `cwd` is absent |
| any path route + `#fragment` / `?query` | Path | the fragment/query is STRIPPED first: `README.md#install` and `main.rs#L42` are what the model emits, and unstripped the path does not exist. A line number cannot be honoured — the Client has no editor to point at a line |
| empty / whitespace-only | — | refused; renders no link at all |

Paths are **not** judged against the _Boundary_ — a path outside the _Space_ opens too. The _Boundary_ governs what the **Agent** may reach, never what the user's own click opens. Existence is the OS's business: `open_path` errors on a missing path, so we do not pre-stat and hold no TOCTOU seam of our own.

## Design

```
src-tauri/src/open.rs            the policy, no IPC (beside skills.rs / agents.rs)
  enum Target { Url(String), Path(PathBuf) }
  enum Refusal { DeniedScheme(String), RelativeWithoutCwd, HostInFileUrl(String), Empty }
  fn classify(href, cwd: Option<&Path>) -> Result<Target, Refusal>   // pure
  fn open(href, cwd: Option<&Path>) -> Result<(), String>            // classify → plugin's Rust API

src-tauri/src/commands/open.rs   the IPC wrapper
  #[tauri::command] async fn external_open(href: String, cwd: Option<String>) -> Result<(), String>
```

`open.rs` is NOT inside `commands/` because a non-IPC caller needs it: `production_open_browser` (`agent/mcp/manager.rs:363`) becomes `crate::open::open(url, None)`, deleting the per-OS block. The plugin's Rust free functions bypass the IPC scope check, so **`capabilities/default.json` is not touched by this work** (ADR 0051).

**Navigation guard**: a ~20-line local `Plugin` implementing `on_navigation` (`tauri-2.12.2/src/plugin.rs:95`, invoked for every webview including config-created ones at `manager/webview.rs:620`) returning `false` for any URL whose origin is not the app's own. The window is declared in `tauri.conf.json`, so `WebviewWindowBuilder::on_navigation` is unreachable — the plugin hook is the only route. Allowed: the dev origin `http://localhost:1420`, the prod custom protocol (`tauri://localhost` / `tauri.localhost`), `about:blank` (the initial load passes through the hook). No `on_new_window` change: no plugin hook exists for it, the default already denies, and after this branch nothing writes `target="_blank"`.

**The cwd**: a React context (`SpaceCwdContext` + `useSpaceCwd()`) provided once at the `ChatStream` root from the `spacePath` it already derives (`ChatStream.tsx:490`). Six components would otherwise thread a `cwd` prop they never use (`MessageBubble`, `ToolCallCard`, `ToolCallCardHeader`, `ChangesGroupCard`, `FileChip`, `SubagentTranscript`), and a **Subagent session**'s sheet is already inside that subtree — correct, because a child's Worker runs with `cwd = parent_cwd` (`agent/worker/manager.rs:474`).

## Surfaces

| Surface | Change |
|---|---|
| Prose anchors (`MessageBubble.tsx` `a` renderer) | keep the `href` (hover, focus, copy-link still work) + `onClick` → `preventDefault()` + `externalOpen(href, cwd)`. EVERY click routes there, including ctrl/cmd/shift — there is no "open in a new tab" in the Client, so a modifier cannot mean something else. Middle-click is not reliably cancelable, which is what the guard is for |
| Bare URLs in prose | **already links** — `remark-gfm` autolink literals cover `https://…`, `www.…` (→ `http://www…`) and `mailto:`. Verified through the app's own renderer. No prose linkifier is written |
| `slack://` and other non-GFM schemes as bare text | stay text — duplicating GFM's autolink rule for a rare case is not worth a second text pass over every bubble |
| Inline code spans and highlighted code fences | stay inert (verified: remark does not autolink inside `code`, and Shiki tokenises a URL across sibling `<span>`s, so no anchor can be placed there anyway) |
| `react-markdown` `urlTransform` | overridden, and **load-bearing**: the v10 default blanks every protocol outside `http|https|irc|ircs|mailto|xmpp` (`react-markdown/lib/index.js:124,421-443`), so `ssh://` would otherwise render `href=""`. The override passes everything through EXCEPT the denied schemes, which it blanks so no `javascript:` href is ever in the DOM (presentation hygiene; the Rust list stays authoritative) |
| Tool output `<pre>` (`ToolCallCard.tsx:105,128`) | `linkifyText(text)` in `src/lib/linkify.tsx`, GFM's shape (`https?://`, `www.`, `mailto:`), over a settled text node |
| Thinking (`Reasoning.tsx`) | same `linkifyText`, gated on the EXISTING `isStreaming` prop — linkified only once the thought settles, because the body re-renders per streamed chunk (the perf note at `Reasoning.tsx:577-581` is exactly this cost) |
| File chips (`FileChip.tsx`) | `<span>` → `<button>` that External-opens the path (relative against the context cwd). Fixes its own doc comment, which says "non-clickable in v1" |
| Settings "Get key" (`ProviderSection.tsx:162`) | drop `target="_blank"`, `onClick` → `externalOpen(keyUrl)` |
| Crash log (`SessionStalledBanner.tsx:46`) | `openPath(…)` → `externalOpen(…)` |
| MCP OAuth (`manager.rs:363`) | the per-OS block → `crate::open::open(url, None)` |

## Failure

Silent, with the reason in `console.warn`: `denied-scheme:javascript`, `relative-path-without-cwd`, `os-error:…`. `external_open` returns `Result<(), String>`, so a surface that later wants visible feedback already has the reason. No toast surface is built — the app has none (`src/components/ui/` ships 18 primitives, no toast), and the refusals left are only deliberately-denied schemes and a missing cwd.

## Out of scope

Linkifying inside highlighted fence bodies; a file-viewer/editor action (which is what would make a `#L42` fragment mean something); making a refused open visible; any in-app browser (`openWith: 'inAppBrowser'`); any change to `capabilities/default.json`.

## Verification

- `cargo test` (`open.rs`): the table above as data — the denylist including `java\nscript:`; `file:///a/b` vs `file://otherhost/a` vs `file:///C:/x`; relative join vs absolute passthrough; `~/x`; `README.md#install` / `main.rs#L42` losing the fragment; relative-without-cwd refused. Windows-shaped paths asserted separator-agnostically so a Linux CI still pins them.
- `cargo test` (the guard): the predicate is a pure `is_app_origin(&Url) -> bool`; dev origin, both prod custom-protocol hosts and `about:blank` allowed, `https://example.com` refused.
- `MessageBubble.markdown.test.tsx`: a click calls the mocked command with `(href, cwd)` and does not navigate; `ssh://` survives `urlTransform`; a `javascript:` href renders inert; a relative href receives the context cwd.
- `ToolCallCard` / `Reasoning` / `FileChip` / `ProviderSection` / `SessionStalledBanner`: the affordance is present and the click routes to the wrapper; `Reasoning` linkifies only once `isStreaming` is false. `SessionStalledBanner.test.tsx` currently mocks `@tauri-apps/plugin-opener` and moves to the new wrapper.
- Green per `AGENTS.md`: `pnpm test` + `pnpm build` at the root; `cargo test`, `cargo clippy --all-targets` (0 warnings) and `cargo fmt --check` in `src-tauri/`.
- Manual, per platform: a web link opens the default browser; `mailto:` opens the mail client; a relative path and a file chip open the file in its default app; clicking a link never changes what the Client is displaying.
