---
status: accepted
date: 2026-10-12
superseded-by:
---

# The attention countdown runs in Rust; the renderer only decides

The renderer computes whether an **Attention alert** should arm or disarm (it holds
the stores and is the only place DOM input exists) and hands Rust the delay plus the
title/body through `attention_arm` / `attention_disarm`; the sleep itself, the focus
check, and the delivery live in the Supervisor. The obvious implementation — a
`setTimeout` in the hook — is the one that silently fails: Tauri throttles a
backgrounded webview (cf. tauri-apps/tauri#5250), and a hidden or minimised window is
this feature's entire customer base, so a renderer-side clock is a notification
feature that does not notify exactly when it matters.

## Considered Options

- All in the renderer (plus `@tauri-apps/plugin-notification` and a `notification`
  capability) — least new surface, easiest tests; rejected on throttling alone.
- All in Rust (the Supervisor arms on `agent_settled` / `track_modal` and the
  renderer sends a debounced `ui_activity` command) — no throttling exposure at all,
  but every keystroke burst then pays IPC whether or not anything is armed, and the
  arm/disarm rule moves out of the vitest layer that already tests rules like
  `sessionStatusOf`.

## Consequences

Activity pings cross IPC only while an alert is armed, so idle typing costs nothing;
and a ping delayed by throttling is harmless, because a hidden window receives no
input to report. Rust stays dumb by construction: it reads no settings and knows no
Session vocabulary, so the delay's single source of truth stays the renderer's
settings store. Delivery needs no permission work — the notification plugin's
`request_permission` is a documented no-op on desktop — so there is no npm package,
no capability entry, and no first-run prompt.
