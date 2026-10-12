---
status: accepted
date: 2026-10-12
superseded-by:
---

# Attention alerts fire only while the window is unfocused

An **Attention alert** whose delay elapses while the Archimedes window is the
focused window is dropped silently and never retried — the alert exists to reach a
user who has left, and a toast landing on top of the window they are reading is
noise. pi-archimedes' own `notify` package does the opposite on purpose ("no focus
tracking. Keystrokes are the only signal"), because a terminal cannot tell whether
the user is looking; the desktop can, so it uses that fact instead of mimicking the
terminal's blind spot. The one-shot half is the deliberate part: holding a fired-but
-suppressed alert until the next blur would let a Session that settled an hour ago
ring when the user finally alt-tabs, which is pi's own "a long-gone question cannot
ring" failure in new clothes.

## Considered Options

- Fire regardless of focus (the faithful port) — rejected: fires over the frontmost
  window, which is the one window the user is demonstrably reading.
- Hold the suppressed alert and fire it on the next blur — rejected: needs an expiry
  to avoid stale alerts, and re-introduces the delayed nag it was meant to avoid.
- Make focus-suppression a third setting — rejected: a knob for behaviour whose
  only alternative is worse on every platform (macOS suppresses frontmost-app
  notifications at the OS level anyway).

## Consequences

**Activity signals can never be the reason a focused alert is suppressed** — input
arrives with focus, so the two gates overlap almost entirely. They remain
load-bearing anyway: they stop an armed alert from ringing for a pause the user
already resolved inside the delay (came back, typed, left again), and — with the
`beginTurn` disarm — from announcing "finished" while a turn they just started is
still streaming.
