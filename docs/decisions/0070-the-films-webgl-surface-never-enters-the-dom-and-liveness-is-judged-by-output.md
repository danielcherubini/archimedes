---
status: accepted
date: 2026-10-21
superseded-by:
---

# The film's WebGL surface never enters the DOM, and liveness is judged by what the compositor drew

The **Transcript**'s **empty state** runs the Archimedes ASCII film from a live three.js scene, in a webview whose graphics stack we do not control. We decided: three renders into an offscreen `WebGLRenderTarget` that is **never attached to the document** — the DOM contains only a 2D canvas — and a dead or unusable renderer is detected **behaviourally**, by compositing one frame and checking that it drew at least one cell, rather than by probing GL capabilities. When either test fails the empty state falls back to the text line.

## Why not ask the browser what it can do

The obvious implementation queries capability and it is useless here, which is the part worth recording. Tauri's own [Linux graphics doc](https://v2.tauri.app/develop/debug/linux-graphics) states that a WebGL2 context **creation succeeds even when the result is backed by a software rasterizer**, and that WebKitGTK masks the renderer string so `WEBGL_debug_renderer_info` reports `Apple GPU` on every Linux machine — so the two standard ways to ask "is this GL real" both answer "yes" on the machines where the answer is no. Its explicit recommendation is to give the app a non-WebGL fallback on Linux rather than trust the context. Upstream failures are silent too: `tauri#6559` (`WebGL: context lost`), `tauri#8498` (`Could not create a WebGL context`), `tauri#15936` (blank window under Xvfb until `WEBKIT_DISABLE_COMPOSITING_MODE=1`, DOM present, nothing painted). A capability check passes on all of these and the user gets an empty pane.

Judging by composited output catches every one of them, because the thing we actually care about — *did pixels land* — is exactly what breaks.

## Why the surface stays offscreen

The main window is `transparent: true` (`src-tauri/tauri.conf.json:16`). A composited WebGL layer inside a transparent WebKitGTK window has a documented paints-nothing failure mode, and keeping GL off the compositor tree sidesteps it entirely. It also means the fallback path in this decision needs no second rendering implementation: the 2D canvas is the only surface either way, so "no film" is just "draw nothing and show the text line".

## Considered Options

- **Probe `WEBGL_debug_renderer_info` / test for a WebGL2 context and skip the film when unsupported (rejected).** Cheap and conventional, and it cannot work: the renderer string is masked and software-backed context creation reports success. It would have shipped confident-looking detection that never fires on the broken machines.
- **Bake the film to a precomputed luminance asset at build time (rejected).** Measured at 111 KB (4-bit quantised, temporal delta) and it removes every runtime GL risk, which is why it deserves naming as a real option. Rejected because the scene stops being code — no re-camera, re-light, or response to input — and the request was explicitly for a live animation. The port's choreography and IK maths are kept pure (`evaluateChoreography`, `solveLimbIK`) precisely so they stay testable and reusable if this is revisited.
- **Render the scene with a CPU software rasterizer, no WebGL (rejected).** Measured at 8 ms/frame at 2,500 triangles and ~37 ms at the demo's ~12,000, so viable after culling, with zero dependency and zero GL risk. Rejected because three's shadow maps and PBR shading are the reason the film looks the way it does, and hand-rolling equivalent chiaroscuro is a larger project than the port.
- **Ship with no fallback beyond `webglcontextlost` (rejected).** Since the empty state now shows *no* caption, a silent GL failure would leave a blank pane with no cue that typing is possible. The text line is retained in the codebase as the degraded state, which also keeps the existing `"Send a prompt to start"` assertions meaningful instead of deleted.

## Consequences

- `three` is pinned as an exact pair with `@types/three` (`three@0.186.1` ships **no** `.d.ts`), loaded by dynamic `import()` so the ~130 KB gz chunk downloads only when an empty state actually animates. Same reasoning `AGENTS.md` applies to `@tauri-apps/cli`: the pair must move together or the types describe a different API.
- three ≥ r163 requires WebGL2 ("WebGL 1 is not supported since r163"), and WebKitGTK only gained WebGL2 via ANGLE in 2.40 — so an older Linux webview is a **supported fallback case**, not a crash.
- The renderer is disposed on unmount: browsers cap live WebGL contexts near 16, and a React remount leak can steal the slot from the only thing in the app that uses GL.
- rAF pausing cannot be assumed in a webview (`wry#204` measured 12% CPU while minimised; `SIZE_MINIMIZED` is a no-op in wry), so `visibilitychange`, window blur and `IntersectionObserver` each stop the loop explicitly.
