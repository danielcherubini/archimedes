import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
// TYPE-ONLY, deliberately. `tsconfig.json` has `isolatedModules` but NOT
// `verbatimModuleSyntax`, so a plain `import { FilmEngine } from "…/scene"` would
// be elided by the bundler's type-stripping and three.js would *happen* to stay
// out of the eager chunk. The whole feature rests on ~130 KB of three never
// joining a chunk that loads on every session, so the boundary is stated in the
// syntax instead of relying on that: `import type` here, and the only RUNTIME
// reference to the scene module is the dynamic `import()` in `loadFilmEngine`
// below — its own lazy chunk, evaluated only after this file has confirmed a
// WebGL2 context exists.
import type { FilmEngine } from "../../lib/archimedes-film/scene";
import {
  BAND_COUNT,
  FILM_GLYPH_COLOR_CLASS,
  chooseTier,
  containBox,
  drawGrid,
  measureAdvanceRatio,
  resolveTokenColor,
  type GridTier,
  type GlyphSink,
} from "../../lib/archimedes-film/compositor";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";

/**
 * The film's frame budget: 24 fps.
 *
 * The reference demo ran free at display rate, which is the wrong answer in a
 * desktop webview: it spends a GPU and a compositor on a pane the user has not
 * typed into yet, and `wry#204` measured 12% CPU with the window minimised
 * because rAF pausing cannot be assumed in wry. The loop therefore accumulates
 * real elapsed time and composites at most one frame per interval. It is
 * `1000 / 24` — asserted in the test file, so a mistyped denominator cannot
 * pass review.
 */
export const FRAME_INTERVAL_MS = 1000 / 24;

/**
 * How far short of the frame budget an accumulator may be and still draw.
 *
 * `1000 / 24` is not representable in binary floating point, so a stream of
 * frames arriving exactly one interval apart accumulates `41.66666666666666` —
 * which is *less* than `FRAME_INTERVAL_MS`'s `41.666666666666664` — and a bare
 * `accumulator < FRAME_INTERVAL_MS` would therefore decline to draw, then draw on
 * the following tick. Measured, not hypothetical: it halves the rate (24 fps
 * becomes 12) on any source whose timestamps land exactly on the interval, and it
 * is exactly the kind of bug that reproduces on a 24 Hz panel and nowhere in
 * review. Ten microseconds of tolerance buys that away; drawing 0.00024 % early is
 * not a visible cost, and the film's TIME is unaffected either way because the
 * whole accumulator is charged to it.
 */
const FRAME_INTERVAL_TOLERANCE_MS = 0.01;

/**
 * The frame `"static"` shows.
 *
 * This is `FILM_HERO_TIME` from `scene.ts`, restated here on purpose: importing it
 * at RUNTIME would evaluate `scene.ts`, which statically imports `three`, which is
 * exactly the chunk membership this file exists to protect. (The loop length is
 * not restated because the loop does not need it — `evaluateChoreography` wraps
 * `time` into `[0, FILM_LOOP_SECONDS)` itself, so `filmTime` can grow forever.)
 *
 * The duplication is not free, so it is pinned from the test file, which may
 * import the scene freely (tests do not ship): move the constant in `scene.ts` and
 * `expect(engine.frame).toHaveBeenCalledWith(FILM_HERO_TIME, 0)` fails.
 */
const FILM_HERO_TIME_LOCAL = 6.5;

/** What the empty state shows. See `resolveFilmMode` for how one is chosen. */
export type FilmMode = "off" | "static" | "film" | "fallback";

/**
 * The precedence rules, isolated so they are testable without rendering.
 *
 * The order IS the contract (ADR 0070):
 *
 *  1. `"off"` wins outright. The user asked for nothing; an OS preference is not
 *     a licence to add motion nobody requested.
 *  2. Any failure — no WebGL2, a construction throw, a frame that composited
 *     zero cells — is `"fallback"`. A dead renderer is NOT upgraded to `"static"`
 *     by a reduced-motion preference, because `static` is itself a rendered state
 *     and the renderer is the thing that is broken.
 *  3. Reduced motion is `"static"`: it may only ever reduce.
 *  4. The explicit `"static"` setting is `"static"`.
 *  5. Everything else — `null` (the app default, `"animated"`), and any value
 *     this build does not recognise — is `"film"`.
 */
export function resolveFilmMode(input: {
  setting: string | null;
  reducedMotion: boolean;
  glAvailable: boolean;
  drewCells: boolean;
  engineFailed: boolean;
}): FilmMode {
  if (input.setting === "off") return "off";
  if (input.engineFailed || !input.glAvailable || !input.drewCells) return "fallback";
  if (input.reducedMotion) return "static";
  if (input.setting === "static") return "static";
  return "film";
}

export interface EmptyStateFilmProps {
  /** `AppSettings.emptyStateAnimation`: `"off" | "static" | "animated" | null`. */
  setting: string | null;
  /**
   * Injected for tests; defaults to the real dynamic-import factory.
   *
   * Not test cosmetics. jsdom's `HTMLCanvasElement.getContext` returns `null` for
   * every context id, so the real engine cannot be constructed under test at all,
   * and stubbing three.js's `WebGLRenderer` against a fake GL would test the stub
   * rather than this file.
   */
  createEngine?: () => Promise<FilmEngine>;
  /** Resolved glyph colour; defaults to `resolveTokenColor(FILM_GLYPH_COLOR_CLASS)`. */
  glyphColor?: string;
}

/**
 * The real engine loader — the only runtime reference to the scene module, and
 * dynamic so `three` lands in its own chunk (see the import above).
 */
const loadFilmEngine = async (): Promise<FilmEngine> => {
  const scene = await import("../../lib/archimedes-film/scene");
  return scene.createFilmEngine();
};

/**
 * The text line the empty state showed before the film existed.
 *
 * The markup of `src/components/chat/MessageList.tsx`, byte for byte: `"off"` and
 * `"fallback"` must be indistinguishable from the pre-feature state, including to
 * the assertions that predate it.
 */
const renderTextLine = (): ReactElement => (
  <div className="flex h-full items-center justify-center">
    <p className="text-ui-base text-foreground-subtlest">Send a prompt to start</p>
  </div>
);

/** The extension the WebGL spec offers for handing a context slot back on demand. */
const LOSE_CONTEXT_EXTENSION = "WEBGL_lose_context";

/**
 * Ask for a WebGL2 context, learn whether one exists, and give it straight back.
 *
 * This runs on the CALLER side, before anything imports three.js, for two
 * reasons. First, chunk membership: evaluating the scene module on a machine with
 * no WebGL would download ~130 KB of three.js to learn nothing. Second, context
 * budget: a browser caps live WebGL contexts near 16 and the engine creates its
 * own canvas immediately afterwards, so this probe transiently holds a second
 * slot in a long-lived desktop window where a leak is unrecoverable — hence
 * `loseContext()`, which returns the slot deterministically instead of waiting on
 * GC (and hence keeping no reference to the context or its canvas either).
 *
 * This is NOT the capability probe ADR 0070 rejects. That decision refuses to
 * trust a capability check as the liveness DECISION; here the decision stays the
 * composited-cell count. On WebKitGTK, where a context is handed out and is then
 * silently software-backed or paints nothing, this pre-check passes and the cell
 * count still does the real work. It is a chunk-membership guard that happens to
 * be a GL query, and it can only ever *prevent* work — it never picks a look.
 */
function probeWebGL2(): boolean {
  const probeCanvas = document.createElement("canvas");
  let context: WebGL2RenderingContext | null = null;
  try {
    context = probeCanvas.getContext("webgl2");
  } catch {
    // Some embedders throw instead of returning null when GL is disabled outright.
    return false;
  }
  if (context === null) return false;
  try {
    // Best effort: if the extension is missing the slot returns when the probe
    // canvas is garbage-collected, which is what it used to be. The answer we
    // came for is already known either way.
    context.getExtension(LOSE_CONTEXT_EXTENSION)?.loseContext();
  } catch {
    // Ignored for the same reason.
  }
  return true;
}

/** The flags the mode is resolved from, plus whether the engine has landed yet. */
interface FilmStatus {
  /** `null` until the probe has run: until then nothing about the renderer is known. */
  glAvailable: boolean | null;
  engineFailed: boolean;
  /**
   * `true` means "nothing has proven the renderer dead yet". Only ever set to
   * `false`, by a composited frame whose lit-cell count was zero — the behavioural
   * liveness test of ADR 0070. Nothing else needs to know the count.
   */
  rendererAlive: boolean;
  /**
   * The engine this component currently owns, or `null` until it has arrived (and
   * forever after a dispose). Held in STATE, not only in a ref, because the canvas
   * plumbing must re-attach when a *different* engine shows up — a ref would let
   * the ResizeObserver and the context-lost listener stay bound to an engine that
   * has been freed. Its identity is stable between renders, so this never causes
   * the plumbing effect to churn.
   */
  engine: FilmEngine | null;
}

const INITIAL_STATUS: FilmStatus = {
  glAvailable: null,
  engineFailed: false,
  rendererAlive: true,
  engine: null,
};

/**
 * A band's alpha, given that the COLOUR already carries the palette's hue.
 *
 * The compositor hands the sink a band INDEX and owns nothing about colour;
 * luminance is the data, so the bands have to be visible as brightness. One token
 * colour × eight alphas keeps ADR 0071's single dimming axis (the alpha here IS
 * the luminance, it is not a second dimmer stacked on a translucent token).
 */
const bandAlpha = (band: number): number => (band + 1) / BAND_COUNT;

/** Device-pixel scale for the backing store. Capped, or a 4K panel costs 4× the pixels. */
const cappedDevicePixelRatio = (): number => Math.min(window.devicePixelRatio, 2);

/** The face glyphs are drawn in: canvas needs a concrete family, so the pane's is read. */
const fontFamilyFor = (element: Element): string => {
  if (typeof getComputedStyle !== "function") return "monospace";
  const family = getComputedStyle(element).fontFamily.trim();
  // jsdom has no stylesheet to ask, and an empty family is an invalid `font`
  // shorthand; `monospace` is the answer for any runtime that cannot say.
  return family === "" ? "monospace" : family;
};

/** A size is irrelevant to a ratio, so measure at a fixed 100px reference size. */
const MEASURE_FONT_SIZE_PX = 100;

/**
 * The contain box for a pane, in whole CSS pixels, or `null` when there is none.
 *
 * A zero box is not "a very small film": it is the pane not being laid out yet (a
 * hidden tab, a collapsed transcript, jsdom). Judging the renderer dead from a
 * frame that had nowhere to draw would retire the film for the whole session, so
 * the caller must treat `null` as "not yet" rather than as a black frame.
 */
function measureContainBox(element: Element): { width: number; height: number } | null {
  const rect = element.getBoundingClientRect();
  const box = containBox(rect.width, rect.height);
  const width = Math.round(box.width);
  const height = Math.round(box.height);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** The geometry the film is currently fitted to. */
interface FilmLayout {
  box: { width: number; height: number } | null;
  tier: GridTier | null;
  /** `measureAdvanceRatio` for the current `--font-mono`, 0 until measured. */
  advanceRatio: number;
}

const EMPTY_LAYOUT: FilmLayout = { box: null, tier: null, advanceRatio: 0 };

/**
 * The empty-state film: Archimedes levering a boulder, behind the transcript's
 * greeting slot, drawn from a live three.js scene into a plain 2D canvas.
 *
 * The document holds one `<canvas>` inside a decorative `aria-hidden` wrapper.
 * The GL surface is never in the document (ADR 0070), and nothing here is
 * announced to assistive tech or responds to a click — the pane stays inert.
 * Where the film cannot be trusted (no WebGL2, a construction throw, a zero-cell
 * frame, a lost GL context) this renders the pre-existing text line instead.
 *
 * Mounting it is the empty-state branch's decision, not this file's: it belongs
 * exactly where the text line lives today, and must not render once a
 * conversation exists.
 */
export default function EmptyStateFilm(props: EmptyStateFilmProps): ReactElement | null {
  const { setting, glyphColor } = props;

  const reducedMotion = usePrefersReducedMotion();
  const [status, setStatus] = useState<FilmStatus>(INITIAL_STATUS);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<FilmEngine | null>(null);
  /**
   * Engines already freed. `FilmEngine.dispose` is documented idempotent, so this
   * latch is belt-and-braces: it makes a second call a non-event rather than a
   * question about what the browser does to a context that is already gone.
   */
  const disposedRef = useRef<WeakSet<FilmEngine>>(new WeakSet());
  /**
   * The engine factory, held for the MOUNT.
   *
   * A prop, and read once — deliberately. A caller that inlines
   * `createEngine={() => ...}` hands over a new function identity every render,
   * and keying the engine effect on that identity would tear down and rebuild a
   * GPU scene on every parent re-render, leaking a WebGL context per render in an
   * app whose window lives for days. The factory is a construction strategy, not
   * reactive state: swapping it under a mounted film has no meaning, so the first
   * one wins for the life of the component.
   */
  const createEngineRef = useRef<(() => Promise<FilmEngine>) | null>(null);
  if (createEngineRef.current === null) {
    createEngineRef.current = props.createEngine ?? loadFilmEngine;
  }
  const createEngine = createEngineRef.current;
  /** Film time of the last composited frame, or `null` when nothing has been drawn. */
  const paintedTimeRef = useRef<number | null>(null);
  const layoutRef = useRef<FilmLayout>(EMPTY_LAYOUT);

  const settingIsOff = setting === "off";
  const settingIsStatic = setting === "static";

  // The freshest reduced-motion value, readable from inside the async engine
  // setup and from the paint path. A LAYOUT effect updates it, and layout effects
  // all run before any passive effect of the same commit — so the passive effect
  // that builds the engine reads the truth even when the preference was learned in
  // that same commit. (`usePrefersReducedMotion` seeds `false` and learns in a
  // passive effect of its own, which is why this ref exists at all.)
  const reducedMotionRef = useRef(reducedMotion);
  const settingIsStaticRef = useRef(settingIsStatic);
  const glyphColorRef = useRef(glyphColor);
  useLayoutEffect(() => {
    reducedMotionRef.current = reducedMotion;
    settingIsStaticRef.current = settingIsStatic;
    glyphColorRef.current = glyphColor;
  }, [reducedMotion, settingIsStatic, glyphColor]);

  /**
   * Free an engine at most once per instance (live WebGL contexts cap near 16),
   * and drop it from state so nothing can paint into a freed renderer.
   */
  const disposeEngine = useCallback((engine: FilmEngine | null): void => {
    if (engine === null) return;
    if (disposedRef.current.has(engine)) return;
    disposedRef.current.add(engine);
    engine.dispose();
    if (engineRef.current === engine) engineRef.current = null;
    setStatus((prev) => (prev.engine === engine ? { ...prev, engine: null } : prev));
  }, []);

  /**
   * Give up on the film: free the renderer and take the empty state back to the
   * text line. One path for every "the renderer is not usable" route — a
   * zero-cell frame (the liveness probe), a lost GL context, a canvas that will
   * not hand out a 2D context — so none of them can forget to release the slot.
   *
   * The engine is freed HERE rather than by the canvas effect's cleanup, because
   * that cleanup also runs on ordinary mode changes and would otherwise strand a
   * canvas on a freed renderer.
   */
  const retireRenderer = useCallback((): void => {
    disposeEngine(engineRef.current);
    setStatus((prev) =>
      prev.rendererAlive ? { ...prev, rendererAlive: false, engine: null } : prev,
    );
  }, [disposeEngine]);

  // -------------------------------------------------------------------------
  // 1. The engine: probe for WebGL2, then build it.
  //
  // Deliberately NOT keyed on `reducedMotion`: that bit arrives one commit late
  // (the hook seeds `false`), and rebuilding a GPU scene because the OS
  // preference landed would be both wasteful and a race with the loop. The mode
  // is re-resolved from `reducedMotion` in render; only the canvas is built here.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (settingIsOff) return;
    let cancelled = false;

    const start = async (): Promise<void> => {
      // The pre-check comes first so a machine with no WebGL never parses three.
      if (!probeWebGL2()) {
        if (!cancelled) setStatus((prev) => ({ ...prev, glAvailable: false }));
        return;
      }
      if (!cancelled) setStatus((prev) => ({ ...prev, glAvailable: true }));

      let engine: FilmEngine;
      try {
        engine = await createEngine();
      } catch (error) {
        console.error("EmptyStateFilm: the film engine could not be created", error);
        if (!cancelled) setStatus((prev) => ({ ...prev, engineFailed: true }));
        return;
      }
      if (cancelled) {
        // Unmounted while the scene chunk was still downloading: free it instead
        // of leaking a context nobody is watching any more.
        disposeEngine(engine);
        return;
      }
      engineRef.current = engine;
      setStatus((prev) => ({ ...prev, engine }));
    };

    void start();

    return () => {
      cancelled = true;
      disposeEngine(engineRef.current);
    };
  }, [settingIsOff, createEngine, disposeEngine]);

  // -------------------------------------------------------------------------
  // 2. One composited frame: layout, paint, and the liveness probe.
  // -------------------------------------------------------------------------

  /** Paint one frame of `grid` into the 2D canvas and report whether anything lit. */
  const paintFrame = useCallback(
    (elapsed: number, dt: number): void => {
      const canvas = canvasRef.current;
      const engine = engineRef.current;
      const layout = layoutRef.current;
      if (canvas === null || engine === null || layout.box === null || layout.tier === null) return;

      // The engine owns the tone curve and returns FINAL luminance; nothing here
      // re-applies a curve or a vignette.
      const grid = engine.frame(elapsed, dt);

      const ctx = canvas.getContext("2d");
      if (ctx === null) {
        // A canvas that will not hand out a 2D context is a dead surface: fall
        // back rather than keep a blank pane behind a running film.
        retireRenderer();
        return;
      }

      const { box, tier } = layout;
      const dpr = cappedDevicePixelRatio();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Skip, never clear-to-black: the pane's `--color-chat` shows through every
      // cell the compositor declines, which is why there are no letterbox bars
      // and no scrim (ADR 0071).
      ctx.clearRect(0, 0, box.width, box.height);
      ctx.fillStyle = glyphColorRef.current ?? resolveTokenColor(FILM_GLYPH_COLOR_CLASS);
      ctx.textBaseline = "top";

      const cellWidth = box.width / tier.cols;
      // Font size from cell WIDTH via the measured advance, not the demo's guess
      // from cell HEIGHT: `--font-mono` is user-changeable and a face whose advance
      // disagrees would overlap or gap while the grid stayed perfectly aligned.
      const ratio = layout.advanceRatio > 0 ? layout.advanceRatio : 0.6;
      ctx.font = `${cellWidth / ratio}px ${fontFamilyFor(canvas)}`;

      const sink: GlyphSink = {
        drawRun: (text, x, y, band) => {
          ctx.globalAlpha = bandAlpha(band);
          ctx.fillText(text, x, y);
        },
      };
      const litCells = drawGrid(grid, tier, box.width, box.height, sink);
      ctx.globalAlpha = 1;
      paintedTimeRef.current = elapsed;

      // THE liveness probe (ADR 0070): a composited frame that lit zero cells means
      // nothing is painting, whatever the renderer claimed about itself. This is
      // also how a context lost WITHOUT a `webglcontextlost` event is caught — the
      // engine's own latch answers an all-zero grid once it is dead.
      if (litCells === 0) retireRenderer();
    },
    // Stable on purpose: the loop effect below re-runs (and so restarts the film
    // clock) whenever this identity changes, so every value the paint reads comes
    // from a ref rather than from the closure.
    [retireRenderer],
  );

  // -------------------------------------------------------------------------
  // 3. `static` and `film` need the engine painted; `off` and every failure do not.
  // -------------------------------------------------------------------------
  const canvasShown =
    !settingIsOff &&
    status.glAvailable === true &&
    !status.engineFailed &&
    status.rendererAlive &&
    status.engine !== null;

  useEffect(() => {
    if (!canvasShown) return;
    const canvas = canvasRef.current;
    const engine = status.engine;
    if (canvas === null || engine === null) return;

    // The nearest sized ancestor is the PANE. This wrapper is `absolute
    // inset-0`, so its own box is DERIVED from the ancestor's; observing the
    // wrapper would observe a consequence and miss the cause.
    const sizeSource: Element = wrapperRef.current?.parentElement ?? canvas;

    /** The time the first frame shows: the hero pose for `static`, the loop's start otherwise. */
    const firstPaintTime = (): number =>
      settingIsStaticRef.current || reducedMotionRef.current ? FILM_HERO_TIME_LOCAL : 0;

    /** Re-derive box, tier and font; repaint. Called on mount and on coalesced resizes. */
    const relayout = (): void => {
      const box = measureContainBox(sizeSource);
      const previous = layoutRef.current;
      if (box === null) {
        layoutRef.current = { ...previous, box: null };
        return;
      }
      const sameBox =
        previous.box !== null &&
        previous.box.width === box.width &&
        previous.box.height === box.height;
      // Observers fire once on `observe()` and repeatedly while a window is
      // dragged; a repeat must not resize a GPU render target or re-measure a font.
      if (sameBox && previous.tier !== null) return;

      const tier = chooseTier(box.width, box.height);
      const tierChanged = previous.tier === null || previous.tier.cols !== tier.cols;
      const dpr = cappedDevicePixelRatio();

      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
      engine.resize(box.width, box.height, dpr, tier);

      // The advance ratio is a property of the FONT, not of the pane, so it is
      // measured only when the tier changes — that is the only moment the caller
      // needs a fresh number, and `measureText` is not free.
      const ctx = canvas.getContext("2d");
      const measured =
        ctx === null || !tierChanged
          ? previous.advanceRatio
          : measureAdvanceRatio(ctx, `${MEASURE_FONT_SIZE_PX}px ${fontFamilyFor(canvas)}`);
      layoutRef.current = {
        box,
        tier,
        advanceRatio: measured > 0 ? measured : previous.advanceRatio,
      };

      // Draw immediately: this is the first frame (and therefore the liveness
      // probe), or a resize that must not leave the canvas showing the old box.
      paintFrame(paintedTimeRef.current ?? firstPaintTime(), 0);
    };

    relayout();

    let resizeRaf: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      // rAF-coalesced: a dragged window delivers many callbacks per frame, and
      // each one would otherwise reallocate a render target.
      const schedule = (): void => {
        if (resizeRaf !== null) return;
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = null;
          relayout();
        });
      };
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(sizeSource);
    }

    const handleContextLost = (event: Event): void => {
      // Cancelling tells the browser the loss is handled. `tauri#6559` is a real
      // report, and unhandled a lost context would leave the film frozen on its
      // last frame forever instead of falling back.
      event.preventDefault();
      engineRef.current?.onContextLost();
      retireRenderer();
    };
    canvas.addEventListener("webglcontextlost", handleContextLost);

    return () => {
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
      resizeObserver?.disconnect();
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      layoutRef.current = EMPTY_LAYOUT;
      paintedTimeRef.current = null;
      // NOTE: no `disposeEngine` here, deliberately. This cleanup also runs on
      // reversible changes (a render where the setting says `off`, a mode flip),
      // and disposing there would strand a live canvas on a freed renderer.
      // Freeing is decided where the renderer is owned: the engine effect's
      // cleanup on unmount, and `retireRenderer` on every give-up route.
    };
    // `canvasShown` and `status.engine` are the only non-stable dependencies, by
    // design: this effect owns the canvas plumbing, and the mode inputs it reads
    // (static intent, colour, reduced motion) come from refs so a settings change
    // repaints without rebuilding the ResizeObserver or the GL render target.
  }, [canvasShown, status.engine, retireRenderer, paintFrame]);

  // -------------------------------------------------------------------------
  // 4. The loop (24 fps + three idle gates), or exactly one frame for `static`.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!canvasShown) return;

    if (reducedMotion || settingIsStatic) {
      // `static`: one frame and no rAF ever. The painting effect already drew it
      // when this intent was known at mount; this covers the preference landing
      // afterwards, which is the one case the hero frame has not been drawn for.
      if (paintedTimeRef.current !== FILM_HERO_TIME_LOCAL) {
        paintFrame(FILM_HERO_TIME_LOCAL, 0);
      }
      return;
    }

    let rafHandle: number | null = null;
    /** `null` until the first tick — the wall time before it is not the film's to spend. */
    let lastTick: number | null = null;
    let accumulator = 0;
    let filmTime = 0;
    let running = false;
    // The three gates, each judged independently: rAF pausing cannot be relied on
    // in a webview (`wry#204`: 12% CPU minimised; `SIZE_MINIMIZED` is a no-op), so
    // every one of these cancels the callback explicitly.
    let visible = !document.hidden;
    let focused = true;
    let onScreen = true;

    const paint = (): void => {
      // No box yet means the pane is not laid out, which is "not yet" and not a
      // dead renderer: draw nothing and let the next resize try again.
      if (layoutRef.current.box === null) return;
      paintFrame(filmTime, accumulator / 1000);
      accumulator = 0;
    };

    const tick = (now: number): void => {
      rafHandle = null;
      if (!running) return;
      rafHandle = requestAnimationFrame(tick);
      if (lastTick === null) {
        lastTick = now;
        return;
      }
      // ONE accumulator holding real elapsed time: a tab throttled to one rAF per
      // 200 ms advances the film by 200 ms in a single draw, rather than replaying
      // five frames it can no longer show.
      accumulator += Math.max(0, now - lastTick);
      lastTick = now;
      if (accumulator < FRAME_INTERVAL_MS - FRAME_INTERVAL_TOLERANCE_MS) return;
      filmTime += accumulator / 1000;
      paint();
    };

    const stop = (): void => {
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
    };

    const start = (): void => {
      if (!running || rafHandle !== null) return;
      // Re-seed the clock: time spent behind a closed gate is not animation the
      // film gets to sprint through on the first frame back.
      lastTick = null;
      rafHandle = requestAnimationFrame(tick);
    };

    const sync = (): void => {
      if (visible && focused && onScreen) {
        running = true;
        start();
      } else {
        running = false;
        stop();
      }
    };

    const handleVisibilityChange = (): void => {
      visible = !document.hidden;
      sync();
    };
    const handleBlur = (): void => {
      focused = false;
      sync();
    };
    const handleFocus = (): void => {
      focused = true;
      sync();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("focus", handleFocus);

    let intersectionObserver: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) onScreen = entry.isIntersecting;
        sync();
      });
      intersectionObserver.observe(wrapperRef.current ?? canvasRef.current ?? document.body);
    }

    sync();

    return () => {
      running = false;
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
      intersectionObserver?.disconnect();
    };
  }, [canvasShown, reducedMotion, settingIsStatic, paintFrame]);

  // `off` answers immediately and synchronously — it must not even flash a canvas.
  if (settingIsOff) return renderTextLine();

  const mode = resolveFilmMode({
    setting,
    reducedMotion,
    // Nothing is known yet: treat "unknown" as "not failed", which is what the
    // `canvasShown` guard below then refuses to act on.
    glAvailable: status.glAvailable ?? true,
    drewCells: status.rendererAlive,
    engineFailed: status.engineFailed,
  });

  if (mode === "off" || mode === "fallback") return renderTextLine();

  // The engine has not landed yet. Showing the text line while we wait is the
  // defensive direction: if the scene chunk never resolves, the user is left with
  // the cue that typing is possible rather than a blank pane (ADR 0070 names that
  // blank pane as the failure to avoid), and the swap to the film is one frame.
  if (!canvasShown) return renderTextLine();

  // Decoration, and said so twice — the convention `braille-loader.tsx` follows
  // (wrapper and inner element both `aria-hidden`) so the film is out of the
  // accessibility tree at every level. No label, no role, no caption, no click
  // handler: clicking the empty pane stays inert.
  //
  // The wrapper stays a full-pane `absolute inset-0` box: the ResizeObserver
  // watches this element's PARENT (the pane — this box is derived from it), and
  // the IntersectionObserver watches THIS box, so shrinking it to its content
  // would move both the measurement source and the off-screen threshold. The
  // canvas is sized to the CONTAIN box, which is smaller than the pane on one
  // axis whenever the pane's aspect differs from the film's, so it is centred
  // here — the same placement the text line this replaced had
  // (`flex h-full items-center justify-center`). Without it the canvas anchored
  // to the top-left and the film hugged the pane's left edge on a wide pane.
  return (
    <div
      ref={wrapperRef}
      className="absolute inset-0 pointer-events-none flex items-center justify-center"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
