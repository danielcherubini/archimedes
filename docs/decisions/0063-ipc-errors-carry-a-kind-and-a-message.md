---
status: accepted
date: 2026-10-19
superseded-by:
---

# IPC errors carry a `kind` and a `message`, Rust owns the sentence, and the payload is hand-built because a serde failure is a compile error and never a runtime one

A Windows user's first Space failed to open and the app said **`[object Object]`**. There was nothing to read and nothing on disk: every session command renders that way, and the release build has no console, so the one sentence that existed was never written down anywhere. We decided: the IPC error envelope is a named contract — `{ "kind": <snake_case discriminator>, "message": <the Display sentence>, …the variant's own field }` — with **Rust owning the sentence**, and `SessionError` gets its wire form from a hand-written `impl From<SessionError> for tauri::ipc::InvokeError` (`src-tauri/src/agent/errors.rs`) with the serde `Serialize` derive **removed**, so a payload serde cannot encode stops being a user-facing string and becomes a compile error in that one file.

**Numbering, so nobody renumbers after a merge race:** this is **0063**, and the number is not "highest in the directory + 1". `0062` exists on the unmerged `feature/ui-design-lightning-round` — absent from this checkout and from `main`, but taken in git. `0058`/`0059` are **not free either**: the unmerged `feature/web-search-and-fetch` carries both (and its `0056`/`0057` are different ADRs from `main`'s same-numbered files, while `main`'s `router.rs`, `web/render.rs` and `navigation_guard.rs` already cite "ADR 0058" in comments with no file behind the citation on this checkout). That trap is written up at `docs/research/windows-child-console-window.md:144`, which is why the 0060 decision took 0060; the genuine historical gaps are `0009` and `0012`, and nothing is coming to fill them. 0063 is the first number that cannot collide with anything in this repository's object database.

## The failure had two halves, and the second was worse

A Tauri command that rejects delivers either a **string** (the `Result<_, String>` commands, the large majority of the surface) or, when the Rust side returns a typed error, a **plain JSON object**. Every frontend site that rendered a rejection funneled the non-`Error` case through `String(…)` — 15 with the one-line idiom `e instanceof Error ? e.message : String(e)` (inherited from when a rejection was always a string), one with the same three-way unwrap spread over six lines where a grep for that idiom cannot see it, and two as a bare `String(error)` — and `String({…})` is exactly `[object Object]`. Nine commands in `src-tauri/src/commands/sessions.rs` return `Result<_, SessionError>` (`get_stalled_info`, the tenth, returns `Result<_, String>`), so nine commands were unreadable, including the one the report was about.

Then the payload itself was wrong, in a way no frontend change could fix. `SessionError` derived serde `Serialize` with `#[serde(tag = "kind", rename_all = "snake_case")]`, and an internally-tagged enum **cannot serialize a newtype variant containing a string**. `SessionError::Io(String)` is exactly that shape, and it is the constructor used 13 times in `agent/session/mod.rs`. Serde refused, and Tauri's blanket conversion swallowed the refusal:

```rust
impl<T: Serialize> From<T> for InvokeError {
  fn from(value: T) -> Self {
    serde_json::to_value(value).map(Self).unwrap_or_else(Self::from_error)
  }
} // tauri-2.12.2/src/ipc/mod.rs:240-247
```

So for those 13 sites the user did not see `[object Object]` — they saw `"cannot serialize tagged newtype variant SessionError::Io containing a string"`, the encoder's complaint standing in for the reason. Six of the seven variants had no `message` key at all, so even a renderer that knew to look had nothing to look for.

## Decision: the envelope, and who writes the prose

```json
{ "kind": "folder_missing", "message": "folder not found: C:\\work", "path": "C:\\work" }
```

- `kind` is the snake_case discriminator, byte-identical to what the deleted `#[serde(rename_all = "snake_case")]` produced — anything already reading it keeps working. Seven values: `io`, `command`, `unknown_session`, `not_resumable`, `folder_missing`, `invalid_prompt`, `settle_timeout`.
- `message` is the variant's `#[error(…)]` `Display` sentence. **Always present, always non-empty** — it is the only key the frontend renders, which is why the payload is built by hand rather than derived.
- The variant's own field keeps the name the derived shape gave it (`error`, `id`, `path`, `reason`, `detail`), so a structured consumer is unaffected. `Io` adds none: its payload already IS the whole `message` (`"i/o error: …"`).

**Rust owns the sentence.** The frontend never assembles prose from `kind`, never maps a `kind` to copy, never localizes it. `kind` is for machines and for the last-resort step below. The consequence is that adding an error variant means writing its user-facing English in `errors.rs`, in the `#[error(…)]` attribute, next to the variant — one place, one language, one owner.

**And the derive stays off, which is the load-bearing half.** With no `Serialize`, Tauri's blanket `impl<T: Serialize>` cannot apply, so the only route from `SessionError` to the wire is the one we wrote. A future variant holding something unserializable is then a **compile error in `errors.rs`**, not a silent trip through `unwrap_or_else(Self::from_error)` that prints the encoder's complaint on the user's screen. Both the `kind()` match and the `From` match are exhaustive with no catch-all arm, so a new variant must be named twice in this file — which is the whole point: the bug class this replaces was a payload that no one had to think about. `tauri::ipc::InvokeError`'s single field is `pub` (`tauri-2.12.2/src/ipc/mod.rs:224`), so the envelope is constructible from app code; nothing outside this file builds one.

## Decision: the frontend's resolution order is normative

`describeIpcError(err: unknown): string` (`src/lib/ipcError.ts`, zero imports) resolves in this order and no other:

1. `typeof err === "string"` → the string itself — the `Err(String)` commands, where the wire error *is* the message.
2. `err instanceof Error` → `err.message` — a JS-side throw, not the IPC path.
3. a non-null object with a **string** `message` → that string — the envelope above, and the rule that fixed the report.
4. a non-null object with a string `kind` → the `kind` alone — worse than a sentence, better than nothing, and what an older backend behind a newer webview yields.
5. otherwise → `String(err)`, and if that is exactly `"[object Object]"`, `"unknown error"` instead.

Step 5 is wrapped in `try`/`catch` also returning `"unknown error"`, because `String()` itself throws (`TypeError: Cannot convert a … to primitive value`) on `Object.create(null)` and `{ toString: null }`. That is unreachable from a real Tauri rejection — the wire is JSON — but the function is documented as total: never throws, always returns a string, and **`[object Object]` is a forbidden output**. It is a selector, not a formatter: it localizes nothing, prefixes nothing, adds no punctuation.

## Considered Options

- **Make every command return `Err(String)` (rejected).** One type, no envelope, and the whole frontend bug evaporates — because there would be no object to stringify. Rejected: it deletes `kind`, and the typed codes are the diagnostic on the surfaces that use them. `commands/open.rs` returns `crate::open`'s refusal codes (`denied-scheme:javascript`, `relative-without-cwd`, `os-error:…`) and the updater maps its plugin error to `release-not-found`, `endpoints-not-configured`, `signature-mismatch` (`map_check_error` in `commands/update.rs`) — a code a supporter greps for and a test asserts (`UpdateSection.test.tsx` pins `release-not-found` reaching the UI). Collapsing the session errors into strings to fix a renderer is paying for a display bug with a contract.
- **Always-on logging of rejected commands (rejected — the option a reviewer preferred).** The review wanted a log that exists. It is recorded here because it is the honest alternative, not a strawman: this bug was unauditable precisely because the switch was opt-in *and undocumented*. The counter-argument that carried it: the diagnostic surface stays **one** switch (`ARCHIMEDES_DEBUG`) that already governs the Worker protocol log and the worker lifecycle lines, it inherits that log's existing 5 MB rotation, and a normal run writes nothing to disk at all — `debuglog::log` is a cached atomic read when disabled and creates no file (`agent/debuglog.rs:60-68`), so wrapping all nine session commands in `logged(…)` costs nothing with the variable unset (`commands/sessions.rs:45-69`). **The accepted cost, named:** a person reporting a bug must set `ARCHIMEDES_DEBUG=1` **before** reproducing it — exactly the step that hid this report, and the reason the decision is only tolerable together with `README.md`'s `## Diagnostics` section. If the switch proves too costly in practice, reopen this bullet rather than re-deriving it.
- **Patch `@tauri-apps/api`'s `core.js` to unwrap the object (rejected).** It would fix every app on the wire rather than every call site in ours. It is also a vendored-asset fork for a one-line problem: the upstream behaviour is not wrong (it delivers a faithful JSON payload), and a patched node_modules is a build step that nobody on this repo can reproduce from a lockfile.
- **Fix only the two sites in the reported flow (rejected).** The failure was identical at all 18 rendering sites, so a partial fix leaves 16 latent copies of a bug whose symptom is "the user cannot read the error" — and the two sites in the flow were the two a future report is least likely to name. (19 call sites adopt the helper: the 18 renderers plus the one console site the exclusion rule below pulls in.)
- **Keep the derive and special-case `Io` (rejected).** It fixes the one variant that happens to be shaped badly and leaves the trap loaded: the next unserializable payload reappears on screen as the encoder's sentence. Removing the derive is what makes the class unrepresentable rather than improbable, and serde gives no hook to intercept the failure — the `unwrap_or_else` is inside Tauri's impl, not ours.

## What keeps the contract honest

- `src/lib/ipcError.test.ts` — 21 cases over the resolution order, including `Object.create(null)`, `{ toString: null }`, an inherited `message` getter, and an assertion that **no** input returns `"[object Object]"`.
- `agent/errors.rs`'s `every_variant_reaches_the_wire_with_a_kind_and_a_nonempty_message` — iterates all seven variants, asserts an object with a `kind`, a non-empty `message` equal to `Display`, and the variant's field; plus `io_reaches_the_wire_as_its_own_sentence_not_a_serde_complaint`, which asserts the string `cannot serialize` never reaches the wire.
- **Two invariant greps**, which do not cover the same ground. `grep -rn "instanceof Error ? " src/ --include=*.ts --include=*.tsx | grep -v "\.test\." | grep -v "lib/ipcError.ts"` must be empty; and `grep -rnE "String\((err|error|e|ex)\)" src/ …` must be empty. The second is not redundant: `settings/UpdateSection.tsx`'s two sites were bare `String(error)` and the first grep structurally cannot see them — yet they were the worst, because the updater's typed codes went through that fallback. Both are empty as of this ADR; both are manual, so they belong in review, not only in a PR checklist.
- `tests/storage.rs::the_session_cwd_string_and_the_space_path_key_are_the_same_string` — the characterization test from this branch. It says nothing about errors; it is the tripwire for the one change that could revisit the envelope indirectly, by re-spelling `SessionInfo.cwd`, since `message` interpolates that path into user-visible prose — and that change is governed by **ADR 0064**, which records why the Windows verbatim prefix in that field cannot be normalized on one side. Nothing else in this envelope depends on the path's spelling.

## Exclusion rule, and what it deliberately leaves dark

Console-only sites are **out of scope**: logging a rejection is not rendering one. The one exception is a module that already owns that message's formatting — which is why `src/lib/tauri.ts`'s external-open wrapper does call the helper (it composes the whole `external open refused: …` line; `Err(String)` today, so the output is unchanged and the line is merely future-proofed). Everything else that catches and console-logs stays as written: `SpaceTabs.tsx`, `SpacesList.tsx`, `SettingsPage.tsx`, the catalog hooks, the store's quiet catches.

**What that leaves open, and accepted:** a `close_session` rejection is logged server-side (`ipc close_session FAILED: …`) and `console.error`-ed in the renderer and **rendered nowhere** — a Space whose sessions failed to stop looks exactly like one that closed cleanly. Fixing it is a product call about whether a banner is warranted, not an envelope question; the envelope now guarantees the sentence exists when someone decides to show it.

## Consequences

- **A new error variant is a three-line obligation in one file**: the variant, its `#[error(…)]` sentence, and its arms in `kind()` and the `From` match. The compiler enforces the second half; the first half is review. The frontend needs no change, by design.
- **`message` is user-visible text, so it is now translatable-adjacent surface with no i18n behind it.** It is Rust `Display` prose in English, and the app has no localization layer. If one ever lands, the sentence's owner has to be renegotiated — this ADR is where that argument starts, and "the frontend assembles prose from `kind`" is the shape it must not take.
- **Rejections of the nine session commands land in `supervisor.log` as `ipc <name> FAILED: <Display>`** — the same words, character for character, that the user saw, which is what makes a screenshot and a support log one piece of evidence. Arguments are deliberately not logged: `send_prompt` carries the user's prompt text.
- **`%APPDATA%\archimedes` is the Windows instruction, and it is not variable.** `dirs` 6.0.0 resolves the Windows data dir through `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` (`dirs-6.0.0/src/win.rs:10`, `dirs-sys-0.5.0/src/lib.rs:150-178`), which **ignores `%APPDATA%`** — recorded in ADR 0025 as the reason `scripts/check-test-data-dir.sh` has no Windows arm, because a Windows "redirect" would move nothing and the check would pass for the wrong reason. Pointing a supporter at the Roaming path itself is therefore the only reliable instruction there. Worth knowing beside it: on Windows (and on macOS) `dirs::config_dir()` resolves to the SAME base as `dirs::data_dir()`, so `settings.json` sits in the very `archimedes` directory the logs live in; only on Linux are they separate (`~/.config/archimedes` vs `~/.local/share/archimedes`). Note in passing that `lib.rs`'s setup comment lists `%LOCALAPPDATA%/archimedes` among the app's on-disk dirs — `dirs::data_local_dir()` is never called in this crate, so nothing is written there today.
- **The console-free release build is why any of this needed a file at all**: `src-tauri/src/main.rs:2` sets `windows_subsystem = "windows"` for release, so `eprintln!` has nowhere to go on a shipped Windows build and the crash log is the only trace a panic left. Recorded in `README.md`'s `## Diagnostics`, next to the paths.
- **`kind` has exactly one reader today and it is a fallback** (`describeIpcError`'s rule 4). Nothing in `src/` branches on one of the seven error `kind` values — a grep for `unknown_session` / `folder_missing` / `settle_timeout` hits only `ipcError.test.ts`. That is not a licence to churn them: `kind` is a stable identifier a supporter quotes in a report, and it is the value a future consumer would switch on. But nobody should assume a hidden switch is already there, and nobody should add one to this file — the place a `kind` earns behaviour is Rust, beside the variant.
