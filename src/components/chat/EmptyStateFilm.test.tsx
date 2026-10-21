/**
 * The empty-state film's React shell: mode precedence, the engine lifecycle, the
 * 24 fps loop, and the three idle gates.
 *
 * ## Why the engine is injected
 *
 * jsdom's `HTMLCanvasElement.getContext` returns `null` for every context id
 * (measured, not assumed), so the real `FilmEngine` cannot be constructed here at
 * all — and stubbing three.js's `WebGLRenderer` against a fake GL would test our
 * stub instead of our code. Every test therefore hands the component a fake engine
 * and asserts on the *shell*: what it draws with, when it stops, and when it gives
 * up. The look of the film is checked against a rendered reference frame, not here.
 *
 * ## Stubs, and why each is load bearing
 *
 *  - `getContext` — answers a fake 2D context (the compositor needs `fillText` and
 *    `measureText`) and, only when the test asks for a GPU, a fake WebGL2 context.
 *    That WebGL2 answer is exactly what the component's pre-check reads, so a test
 *    that leaves it `null` proves `three` was never reached.
 *  - `requestAnimationFrame`/`cancelAnimationFrame` — a registry this file pumps by
 *    hand with EXPLICIT deltas. The loop is a time accumulator, so wall-clock
 *    timing would turn every assertion into a race; driving the clock makes "no
 *    further frame was scheduled" an exact statement rather than a `waitFor`, and
 *    there is no `waitFor` or raised timeout anywhere in this file.
 *  - `ResizeObserver`/`IntersectionObserver` — jsdom ships neither, which is the
 *    same hole a webview-era WebKit can have; the component guards both with
 *    `typeof`, and these stubs are what let the guarded path be exercised.
 *  - `window.matchMedia` — jsdom has no `matchMedia`, and `prefers-reduced-motion`
 *    has three outcomes to pin.
 *  - `getBoundingClientRect` — jsdom lays out nothing, so the pane would measure
 *    0×0 and every geometry assertion would be vacuous (and the component would
 *    correctly refuse to draw at all).
 *  - `document.hidden` — jsdom's is a fixed `false`; the gate needs to flip.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { FILM_HERO_TIME, type FilmEngine } from "../../lib/archimedes-film/scene";
import { containBox } from "../../lib/archimedes-film/compositor";
import EmptyStateFilm, { FRAME_INTERVAL_MS, resolveFilmMode } from "./EmptyStateFilm";

const TEXT = "Send a prompt to start";

/** The pane size the layout stub reports, until a test changes it. */
const PANE_WIDTH = 800;
const PANE_HEIGHT = 600;

/** The demo's top tier — what an 800×600 pane gets. */
const TOP_TIER = { cols: 230, rows: 115 };
const SMALLEST_TIER = { cols: 116, rows: 58 };

// ---------------------------------------------------------------------------
// fake engine
// ---------------------------------------------------------------------------

interface FakeEngine extends FilmEngine {
  frame: Mock<FilmEngine["frame"]>;
  resize: Mock<FilmEngine["resize"]>;
  dispose: Mock<FilmEngine["dispose"]>;
  onContextLost: Mock<FilmEngine["onContextLost"]>;
}

/** An engine whose `frame()` answers with `grid` forever. */
function makeFakeEngine(grid: Float32Array): FakeEngine {
  return {
    frame: vi.fn(() => grid),
    resize: vi.fn(),
    dispose: vi.fn(),
    onContextLost: vi.fn(),
  };
}

/**
 * A grid that lights a band of cells. `drawGrid` reads it through the tier's
 * `cols`, so it is sized to the top tier; at a coarser tier the same bytes still
 * describe lit cells (different shapes, same "not black" property).
 */
function litGrid(): Float32Array {
  const grid = new Float32Array(TOP_TIER.cols * TOP_TIER.rows);
  for (let y = 40; y < 60; y++) {
    for (let x = 20; x < 200; x++) {
      grid[y * TOP_TIER.cols + x] = 0.2 + ((x + y) % 7) / 10;
    }
  }
  return grid;
}

/** Nothing above `DRAW_THRESHOLD_LUM`: the dead-renderer signature (ADR 0070). */
function blankGrid(): Float32Array {
  return new Float32Array(TOP_TIER.cols * TOP_TIER.rows);
}

// ---------------------------------------------------------------------------
// rAF registry — pump with an explicit delta so accumulator maths is exact
// ---------------------------------------------------------------------------

let pendingFrames: Map<number, FrameRequestCallback>;
let frameSeq: number;
let clockNow: number;

/** Advance the fake clock by `deltaMs` and run whatever frames were queued. */
function pump(deltaMs: number, times = 1): void {
  act(() => {
    for (let i = 0; i < times; i++) {
      clockNow += deltaMs;
      const due = [...pendingFrames.values()];
      pendingFrames.clear();
      for (const callback of due) callback(clockNow);
    }
  });
}

/** Pump a run of frames one interval apart, bypassing `act` for the caller. */
function pumpInterval(times: number): void {
  pump(FRAME_INTERVAL_MS, times);
}

// ---------------------------------------------------------------------------
// canvas contexts
// ---------------------------------------------------------------------------

interface FakeContext2D {
  fillText: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  measureText: ReturnType<typeof vi.fn>;
  setTransform: ReturnType<typeof vi.fn>;
  font: string;
  fillStyle: string;
  globalAlpha: number;
  textBaseline: string;
}

interface FakeWebGL2Context {
  getExtension: ReturnType<typeof vi.fn>;
  loseContext: ReturnType<typeof vi.fn>;
}

let context2d: FakeContext2D;
let probeWebGL: FakeWebGL2Context | null;

function makeContext2D(): FakeContext2D {
  const ctx: FakeContext2D = {
    fillText: vi.fn(),
    clearRect: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    setTransform: vi.fn(),
    font: "",
    fillStyle: "",
    globalAlpha: 1,
    textBaseline: "",
  };
  // A face with the conventional 0.6em advance. It has to honour `ctx.font`
  // because `measureAdvanceRatio` sets the font and THEN measures — measuring
  // the default face instead of the assigned one is the bug that function
  // exists to kill, so a fake that ignored `font` would hide it.
  ctx.measureText.mockImplementation((text: string) => {
    const size = Number.parseFloat(ctx.font.replace(/^[^-\d.]*/, "")) || 0;
    return { width: size * 0.6 * String(text).length };
  });
  return ctx;
}

function makeWebGL2Context(): FakeWebGL2Context {
  const loseContext = vi.fn();
  return { loseContext, getExtension: vi.fn(() => ({ loseContext })) };
}

function installCanvasStub(probe: "present" | "absent" | "throws"): void {
  context2d = makeContext2D();
  probeWebGL = probe === "present" ? makeWebGL2Context() : null;
  // The real `getContext` is an overload union the fake cannot satisfy exactly;
  // this file only ever asks for "2d" and "webgl2", so the cast is contained here.
  const impl = (contextId: string): unknown => {
    if (probe === "throws" && contextId === "webgl2") {
      throw new Error("WebGL context creation failed");
    }
    if (contextId === "2d") return context2d;
    if (contextId === "webgl2") return probeWebGL;
    return null;
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    impl as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
}

// ---------------------------------------------------------------------------
// ResizeObserver / IntersectionObserver
// ---------------------------------------------------------------------------

interface FakeResizeObserver {
  observed: Element[];
  trigger: () => void;
}

const resizeObservers: FakeResizeObserver[] = [];

function installResizeObserver(): void {
  class StubResizeObserver {
    private readonly self: FakeResizeObserver;

    constructor(private readonly callback: ResizeObserverCallback) {
      this.self = {
        observed: [],
        trigger: () => {
          const target = this.self.observed[0] ?? document.body;
          const rect = target.getBoundingClientRect();
          const entry = { contentRect: rect, target } as unknown as ResizeObserverEntry;
          this.callback([entry], this as unknown as ResizeObserver);
        },
      };
      resizeObservers.push(this.self);
    }

    observe(target: Element): void {
      this.self.observed.push(target);
    }

    unobserve(target: Element): void {
      this.self.observed = this.self.observed.filter((el) => el !== target);
    }

    disconnect(): void {
      this.self.observed = [];
    }
  }
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
}

function fireResize(): void {
  const observer = resizeObservers[0];
  if (observer === undefined) throw new Error("the component never built a ResizeObserver");
  act(() => {
    observer.trigger();
  });
}

interface FakeIntersectionObserver {
  trigger: (isIntersecting: boolean) => void;
}

const intersectionObservers: FakeIntersectionObserver[] = [];

function installIntersectionObserver(): void {
  class StubIntersectionObserver {
    private readonly self: FakeIntersectionObserver;

    constructor(private readonly callback: IntersectionObserverCallback) {
      this.self = {
        trigger: (isIntersecting) => {
          const entry = { isIntersecting } as IntersectionObserverEntry;
          this.callback([entry], this as unknown as IntersectionObserver);
        },
      };
      intersectionObservers.push(this.self);
    }

    observe(): void {}

    unobserve(): void {}

    disconnect(): void {}

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }

    root: Element | Document | null = null;

    rootMargin = "0px";

    thresholds: number[] = [];
  }
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
}

function fireIntersection(isIntersecting: boolean): void {
  const observer = intersectionObservers[0];
  if (observer === undefined) throw new Error("the component never built an IntersectionObserver");
  act(() => {
    observer.trigger(isIntersecting);
  });
}

// ---------------------------------------------------------------------------
// matchMedia / layout / document.hidden
// ---------------------------------------------------------------------------

function installMatchMediaStub(reduced: boolean): void {
  const impl = ((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" ? reduced : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as (query: string) => MediaQueryList;
  if (typeof window.matchMedia !== "function") window.matchMedia = impl;
  vi.spyOn(window, "matchMedia").mockImplementation(impl);
}

let paneWidth = PANE_WIDTH;
let paneHeight = PANE_HEIGHT;

function installLayoutStub(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width: paneWidth,
        height: paneHeight,
        top: 0,
        left: 0,
        right: paneWidth,
        bottom: paneHeight,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

let documentHidden = false;

function installDocumentHiddenStub(): void {
  documentHidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => documentHidden,
  });
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

/**
 * Render, then settle the `await createEngine()` chain. The flush is a
 * macrotask, which drains the whole microtask queue deterministically — the
 * component reaches its decided mode through `await` plus two `setState`s, and
 * counting microtasks here would be a second-order guess about React internals.
 * This is a scheduler flush, not a `waitFor` retry loop: no assertion is retried.
 */
async function mount(props: {
  setting: string | null;
  createEngine?: () => Promise<FilmEngine>;
  glyphColor?: string;
}) {
  const utils = render(
    <EmptyStateFilm
      setting={props.setting}
      {...(props.createEngine === undefined ? {} : { createEngine: props.createEngine })}
      {...(props.glyphColor === undefined ? {} : { glyphColor: props.glyphColor })}
    />,
  );
  await settle();
  return utils;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** The most recent `frame(elapsed, dt)` call. `.at(-1)` is ES2022; lib here is ES2020. */
function lastFrameArgs(engine: { frame: { mock: { calls: [number, number][] } } }): [number, number] {
  const calls = engine.frame.mock.calls;
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error("the engine was never framed");
  return last;
}

const cappedDpr = (): number => Math.min(window.devicePixelRatio, 2);

/** The box the film paints into for the current pane size, in whole CSS px. */
function expectedBox(width: number, height: number): { width: number; height: number } {
  const box = containBox(width, height);
  return { width: Math.round(box.width), height: Math.round(box.height) };
}

function canvasOrNull(): HTMLCanvasElement | null {
  return document.querySelector("canvas");
}

// ---------------------------------------------------------------------------

describe("resolveFilmMode", () => {
  const alive = {
    setting: null,
    reducedMotion: false,
    glAvailable: true,
    drewCells: true,
    engineFailed: false,
  };

  it("off beats everything, including reduced motion and a dead renderer", () => {
    expect(
      resolveFilmMode({ ...alive, setting: "off", reducedMotion: true, glAvailable: false }),
    ).toBe("off");
  });

  it("a failed engine is fallback", () => {
    expect(resolveFilmMode({ ...alive, engineFailed: true })).toBe("fallback");
  });

  it("no WebGL2 is fallback", () => {
    expect(resolveFilmMode({ ...alive, glAvailable: false })).toBe("fallback");
  });

  it("a frame that drew zero cells is fallback", () => {
    expect(resolveFilmMode({ ...alive, drewCells: false })).toBe("fallback");
  });

  it("reduced motion is static", () => {
    expect(resolveFilmMode({ ...alive, reducedMotion: true })).toBe("static");
  });

  it("the static setting is static", () => {
    expect(resolveFilmMode({ ...alive, setting: "static" })).toBe("static");
  });

  it("everything else is the film", () => {
    expect(resolveFilmMode(alive)).toBe("film");
    expect(resolveFilmMode({ ...alive, setting: "animated" })).toBe("film");
    // A stored value the app does not know degrades to the default, not to a crash.
    expect(resolveFilmMode({ ...alive, setting: "hologram" })).toBe("film");
  });

  it("reduced motion only ever REDUCES: off stays off", () => {
    expect(resolveFilmMode({ ...alive, setting: "off", reducedMotion: true })).toBe("off");
    expect(resolveFilmMode({ ...alive, setting: "off", reducedMotion: false })).toBe("off");
    expect(resolveFilmMode({ ...alive, setting: "static", reducedMotion: true })).toBe("static");
    expect(resolveFilmMode({ ...alive, setting: null, reducedMotion: true })).toBe("static");
  });

  it("failure outranks reduced motion, which would otherwise have been static", () => {
    expect(resolveFilmMode({ ...alive, reducedMotion: true, drewCells: false })).toBe("fallback");
    expect(
      resolveFilmMode({ ...alive, setting: "static", reducedMotion: true, engineFailed: true }),
    ).toBe("fallback");
    expect(
      resolveFilmMode({ ...alive, setting: "static", reducedMotion: true, glAvailable: false }),
    ).toBe("fallback");
  });
});

describe("FRAME_INTERVAL_MS", () => {
  it("is 24 fps", () => {
    expect(FRAME_INTERVAL_MS).toBeCloseTo(41.667, 2);
  });
});

describe("EmptyStateFilm", () => {
  beforeEach(() => {
    pendingFrames = new Map();
    frameSeq = 0;
    clockNow = 0;
    paneWidth = PANE_WIDTH;
    paneHeight = PANE_HEIGHT;
    resizeObservers.length = 0;
    intersectionObservers.length = 0;

    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameSeq += 1;
        pendingFrames.set(frameSeq, callback);
        return frameSeq;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((handle: number) => {
        pendingFrames.delete(handle);
      }),
    );
    installResizeObserver();
    installIntersectionObserver();
    installMatchMediaStub(false);
    installLayoutStub();
    installDocumentHiddenStub();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // -- the two settings that must not build an engine -----------------------

  it("off renders the text line and builds no engine", async () => {
    installCanvasStub("present");
    const createEngine = vi.fn(async () => makeFakeEngine(litGrid()));
    await mount({ setting: "off", createEngine });

    expect(screen.getByText(TEXT)).toBeDefined();
    expect(canvasOrNull()).toBeNull();
    expect(createEngine).not.toHaveBeenCalled();
    expect(pendingFrames.size).toBe(0);
  });

  it("reduced motion still honours off", async () => {
    installCanvasStub("present");
    installMatchMediaStub(true);
    const createEngine = vi.fn(async () => makeFakeEngine(litGrid()));
    await mount({ setting: "off", createEngine });

    expect(screen.getByText(TEXT)).toBeDefined();
    expect(createEngine).not.toHaveBeenCalled();
  });

  // -- the WebGL2 pre-check -------------------------------------------------

  it("never calls the engine factory when no WebGL2 context is available", async () => {
    installCanvasStub("absent");
    const createEngine = vi.fn(async () => makeFakeEngine(litGrid()));
    await mount({ setting: null, createEngine });

    // The keep-three-out-of-jsdom guarantee: `import("../../lib/archimedes-film/scene")`
    // was never evaluated, so `three` is unreachable in this runtime.
    expect(createEngine).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT)).toBeDefined();
    expect(canvasOrNull()).toBeNull();
  });

  it("falls back when the WebGL2 probe throws", async () => {
    installCanvasStub("throws");
    const createEngine = vi.fn(async () => makeFakeEngine(litGrid()));
    await mount({ setting: null, createEngine });

    expect(createEngine).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT)).toBeDefined();
    expect(canvasOrNull()).toBeNull();
  });

  it("releases the probe context so the GL slot comes back deterministically", async () => {
    installCanvasStub("present");
    const probe = probeWebGL;
    if (probe === null) throw new Error("expected a stubbed WebGL2 probe context");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    expect(probe.getExtension).toHaveBeenCalledWith("WEBGL_lose_context");
    expect(probe.loseContext).toHaveBeenCalledTimes(1);
    // Releasing the probe did not take the film down — it still painted.
    expect(engine.frame).toHaveBeenCalled();
    expect(context2d.fillText).toHaveBeenCalled();
  });

  // -- the living film ------------------------------------------------------

  it("a live engine draws to a canvas and the text line is gone", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine, glyphColor: "rgb(9, 8, 7)" });

    expect(canvasOrNull()).not.toBeNull();
    expect(screen.queryByText(TEXT)).toBeNull();
    expect(engine.resize).toHaveBeenCalled();
    expect(context2d.clearRect).toHaveBeenCalled();
    expect(context2d.fillText).toHaveBeenCalled();
    // The glyph colour arrives from the token (ADR 0071), not a hardcoded ramp.
    expect(context2d.fillStyle).toBe("rgb(9, 8, 7)");
  });

  it("the canvas and its wrapper are both aria-hidden and carry no semantics", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    const canvas = canvasOrNull();
    if (canvas === null) throw new Error("no canvas");
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    if (canvas.parentElement === null) throw new Error("canvas has no wrapper");
    expect(canvas.parentElement.getAttribute("aria-hidden")).toBe("true");
    // Decoration only: no label, no role, no caption.
    expect(canvas.getAttribute("role")).toBeNull();
    expect(canvas.getAttribute("aria-label")).toBeNull();
    expect(document.querySelector("figcaption")).toBeNull();
  });

  it("sizes the canvas to the contain box at a capped device pixel ratio", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    const box = expectedBox(PANE_WIDTH, PANE_HEIGHT);
    const canvas = canvasOrNull();
    if (canvas === null) throw new Error("no canvas");
    // jsdom reports dpr 1; the cap is `Math.min(dpr, 2)` so the backing store is
    // the CSS box, and the CSS box is the CONTAIN box (letterboxed, never stretched).
    expect(canvas.width).toBe(Math.round(box.width * cappedDpr()));
    expect(canvas.height).toBe(Math.round(box.height * cappedDpr()));
    expect(canvas.style.width).toBe(`${box.width}px`);
    expect(canvas.style.height).toBe(`${box.height}px`);
    expect(engine.resize).toHaveBeenCalledWith(box.width, box.height, cappedDpr(), TOP_TIER);
  });

  /**
   * The film is CENTRED in the transcript area — that is what the design says, and
   * what the markup it replaces (`MessageList.tsx`'s old hint) did with
   * `flex h-full items-center justify-center`.
   *
   * The canvas's CSS size is the CONTAIN box (aspect 1.16, never stretched), so it
   * is narrower or shorter than the pane whenever the pane's aspect differs. With
   * no alignment on the wrapper the canvas anchored to the wrapper's top-left
   * corner, and on a wide pane the film visibly hugged the left edge.
   *
   * jsdom lays out nothing, so it cannot report where the canvas ended up; this
   * asserts the CLASS CONTRACT that produces the centring — the thing jsdom CAN
   * see. The geometry it produces was verified separately in a real headless
   * browser: in a 1000×600 pane the canvas measures 696×600 with
   * `getBoundingClientRect().left` ≈ 152 (centred) instead of 0, and in a 420×900
   * pane it measures 420×362 with `.top` ≈ 269 instead of 0.
   *
   * The tail of this test pins the two things the centring must NOT disturb: the
   * wrapper's own box (`absolute inset-0`, which is what the IntersectionObserver
   * watches — shrinking the wrapper to its content would change when the film
   * counts as off-screen) and the ResizeObserver's target (the wrapper's PARENT —
   * the wrapper's box is derived from that ancestor, so observing the wrapper
   * would observe a consequence and miss the cause).
   */
  it("centres the canvas in the pane without moving either observed box", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    const canvas = canvasOrNull();
    if (canvas === null) throw new Error("no canvas");
    const wrapper = canvas.parentElement;
    if (wrapper === null) throw new Error("canvas has no wrapper");

    const classes = new Set(wrapper.classList);
    // The centring: the contain box is letterboxed inside the pane, so the canvas
    // has to be pushed to the middle of it on both axes.
    expect(classes.has("flex")).toBe(true);
    expect(classes.has("items-center")).toBe(true);
    expect(classes.has("justify-center")).toBe(true);
    // The wrapper's geometry is UNCHANGED — still the full pane. Centring is done
    // to the child, never by resizing the wrapper.
    expect(classes.has("absolute")).toBe(true);
    expect(classes.has("inset-0")).toBe(true);
    expect(classes.has("pointer-events-none")).toBe(true);
    // Nothing was added that would give the canvas a say in the parent's size.
    expect(wrapper.parentElement).not.toBeNull();

    // The observers still watch exactly what they watched before.
    const resize = resizeObservers[0];
    if (resize === undefined) throw new Error("the component never built a ResizeObserver");
    expect(resize.observed).toEqual([wrapper.parentElement]);
    expect(resize.observed[0]).not.toBe(wrapper);
    expect(intersectionObservers.length).toBeGreaterThan(0);
    expect(engine.frame).toHaveBeenCalled();
  });

  it("coalesces resize through rAF and re-measures the font only when the tier changes", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    const measuredAtMount = context2d.measureText.mock.calls.length;
    expect(measuredAtMount).toBe(1);

    // A shorter pane, still tall enough for the top tier: the canvas and the
    // engine follow the box, and the font is NOT re-measured (measuring needs a
    // `measureText` per call and the face does not depend on the pane's size).
    // Height is what is varied on purpose — the contain box is height-limited at
    // 800×600, so widening the pane would not move the box at all.
    paneHeight = 590;
    fireResize();
    // The ResizeObserver callback is rAF-coalesced, so nothing has happened yet.
    expect(engine.resize).toHaveBeenCalledTimes(1);
    pump(FRAME_INTERVAL_MS);
    expect(engine.resize).toHaveBeenCalledTimes(2);
    expect(engine.resize).toHaveBeenLastCalledWith(
      expectedBox(PANE_WIDTH, 590).width,
      expectedBox(PANE_WIDTH, 590).height,
      cappedDpr(),
      TOP_TIER,
    );
    expect(context2d.measureText.mock.calls.length).toBe(measuredAtMount);

    // A repeat of the same box (observers deliver duplicate callbacks in real
    // browsers, and the initial `observe()` fire is one of them) must not touch
    // the engine at all.
    fireResize();
    pump(FRAME_INTERVAL_MS);
    expect(engine.resize).toHaveBeenCalledTimes(2);

    // Short enough to drop a tier: now the font IS re-measured.
    paneHeight = 200;
    fireResize();
    pump(FRAME_INTERVAL_MS);
    expect(engine.resize).toHaveBeenCalledTimes(3);
    expect(engine.resize).toHaveBeenLastCalledWith(
      expectedBox(PANE_WIDTH, 200).width,
      expectedBox(PANE_WIDTH, 200).height,
      cappedDpr(),
      SMALLEST_TIER,
    );
    expect(context2d.measureText.mock.calls.length).toBe(measuredAtMount + 1);
  });

  it("recovers when the pane first measures zero and later has a size", async () => {
    installCanvasStub("present");
    paneWidth = 0;
    paneHeight = 0;
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    // Zero box: nothing to composite, so the renderer is NOT judged dead.
    expect(engine.resize).not.toHaveBeenCalled();
    expect(context2d.fillText).not.toHaveBeenCalled();

    paneWidth = PANE_WIDTH;
    paneHeight = PANE_HEIGHT;
    fireResize();
    pump(FRAME_INTERVAL_MS);

    expect(engine.frame).toHaveBeenCalled();
    expect(context2d.fillText).toHaveBeenCalled();
    expect(canvasOrNull()).not.toBeNull();
  });

  // -- the liveness probe (ADR 0070) ---------------------------------------

  it("a first frame that draws nothing falls back to the text line", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(blankGrid());
    await mount({ setting: null, createEngine: async () => engine });

    expect(engine.frame).toHaveBeenCalled();
    expect(context2d.fillText).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT)).toBeDefined();
    expect(canvasOrNull()).toBeNull();

    // A renderer that drew nothing must not keep being asked for frames.
    const calls = engine.frame.mock.calls.length;
    pumpInterval(3);
    expect(engine.frame.mock.calls.length).toBe(calls);
  });

  it("an engine that goes black mid-film falls back and stops", async () => {
    installCanvasStub("present");
    const grid = litGrid();
    const engine = makeFakeEngine(grid);
    await mount({ setting: null, createEngine: async () => engine });
    pumpInterval(2);
    expect(screen.queryByText(TEXT)).toBeNull();

    // The engine's own context-loss latch answers an all-zero grid (its contract),
    // so the OUTPUT check catches a death that no event delivered to us.
    grid.fill(0);
    pumpInterval(2);

    expect(screen.getByText(TEXT)).toBeDefined();
    expect(canvasOrNull()).toBeNull();
    const calls = engine.frame.mock.calls.length;
    pumpInterval(3);
    expect(engine.frame.mock.calls.length).toBe(calls);
  });

  it("an engine that throws on construction falls back and logs", async () => {
    installCanvasStub("present");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("film engine: WebGL2 context could not be created");
    await mount({
      setting: null,
      createEngine: () =>
        Promise.reject(boom),
    });

    expect(screen.getByText(TEXT)).toBeDefined();
    expect(canvasOrNull()).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.some((call) => call.includes(boom))).toBe(true);
  });

  it("a lost WebGL context is prevented, reported, disposed once, and falls back", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    const canvas = canvasOrNull();
    if (canvas === null) throw new Error("no canvas");
    const lost = new Event("webglcontextlost", { cancelable: true });
    act(() => {
      canvas.dispatchEvent(lost);
    });

    // preventDefault is how we tell the browser the loss is being handled.
    expect(lost.defaultPrevented).toBe(true);
    expect(engine.onContextLost).toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    expect(screen.getByText(TEXT)).toBeDefined();

    // Teardown now runs a second dispose path: the latch must hold, because a
    // remount leak steals the app's only GL slot (live contexts cap near 16).
    cleanup();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  // -- static ---------------------------------------------------------------

  it("reduced motion draws the hero frame once and schedules nothing further", async () => {
    installCanvasStub("present");
    installMatchMediaStub(true);
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    expect(canvasOrNull()).not.toBeNull();
    expect(engine.frame).toHaveBeenCalledTimes(1);
    expect(engine.frame).toHaveBeenCalledWith(FILM_HERO_TIME, 0);
    expect(pendingFrames.size).toBe(0);

    const calls = engine.frame.mock.calls.length;
    pumpInterval(5);
    expect(engine.frame.mock.calls.length).toBe(calls);
    expect(pendingFrames.size).toBe(0);
  });

  it("the static setting draws the hero frame once too", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: "static", createEngine: async () => engine });

    expect(canvasOrNull()).not.toBeNull();
    expect(engine.frame).toHaveBeenCalledTimes(1);
    expect(engine.frame).toHaveBeenCalledWith(FILM_HERO_TIME, 0);
    expect(pendingFrames.size).toBe(0);
  });

  // -- the 24 fps loop ------------------------------------------------------

  it("the film loop composites at most one frame per interval", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    // The frame that decided the mode: film time 0, no delta yet.
    expect(engine.frame).toHaveBeenCalledTimes(1);
    expect(engine.frame).toHaveBeenLastCalledWith(0, 0);

    // The first tick after the loop starts only establishes the clock base — a
    // loop that drew on its first tick would charge the whole time between
    // `start()` and the first callback to the film.
    pumpInterval(1);
    expect(engine.frame).toHaveBeenCalledTimes(1);

    pumpInterval(1);
    expect(engine.frame).toHaveBeenCalledTimes(2);
    const [, firstDelta] = engine.frame.mock.calls[1] as [number, number];
    expect(firstDelta).toBeCloseTo(FRAME_INTERVAL_MS / 1000, 6);

    // Three more intervals: three more frames, and the film clock is where the
    // accumulator says it should be — 24 fps, not free-running at rAF rate.
    pumpInterval(3);
    expect(engine.frame).toHaveBeenCalledTimes(5);
    const [elapsed] = lastFrameArgs(engine);
    expect(elapsed).toBeCloseTo(4 * (FRAME_INTERVAL_MS / 1000), 6);
    expect(pendingFrames.size).toBe(1);
  });

  it("coalesces a long frame gap into one draw carrying the whole delta", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    pumpInterval(1);
    const before = engine.frame.mock.calls.length;

    // A tab throttled to ~2 fps: one rAF carrying five intervals of time. The
    // seed tick spent no film time, so the accumulator's whole 5 intervals is
    // the first draw's delta.
    pump(FRAME_INTERVAL_MS * 5);

    expect(engine.frame.mock.calls.length).toBe(before + 1);
    const [elapsed, dt] = lastFrameArgs(engine);
    expect(dt).toBeCloseTo((5 * FRAME_INTERVAL_MS) / 1000, 6);
    expect(elapsed).toBeCloseTo((5 * FRAME_INTERVAL_MS) / 1000, 6);
  });

  // -- idle gates (each independent) ---------------------------------------

  it("visibilitychange with document.hidden stops the loop", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    pumpInterval(3);
    const calls = engine.frame.mock.calls.length;
    expect(calls).toBeGreaterThan(1);

    act(() => {
      documentHidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(pendingFrames.size).toBe(0);

    pumpInterval(4);
    expect(engine.frame.mock.calls.length).toBe(calls);
  });

  it("window blur stops the loop", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    pumpInterval(3);
    const calls = engine.frame.mock.calls.length;
    expect(calls).toBeGreaterThan(1);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(pendingFrames.size).toBe(0);

    pumpInterval(4);
    expect(engine.frame.mock.calls.length).toBe(calls);
  });

  it("IntersectionObserver reporting isIntersecting false stops the loop", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    pumpInterval(3);
    const calls = engine.frame.mock.calls.length;
    expect(calls).toBeGreaterThan(1);

    fireIntersection(false);
    expect(pendingFrames.size).toBe(0);

    pumpInterval(4);
    expect(engine.frame.mock.calls.length).toBe(calls);
  });

  it("the loop resumes when a gate opens again, without a time jump", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    await mount({ setting: null, createEngine: async () => engine });

    pumpInterval(3);
    const paused = engine.frame.mock.calls.length;

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    pumpInterval(5);
    expect(engine.frame.mock.calls.length).toBe(paused);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    // Two intervals: the first re-seeds the clock base, so the pause is not
    // charged to the film as one enormous delta.
    pumpInterval(2);
    const [elapsed] = lastFrameArgs(engine);
    expect(engine.frame.mock.calls.length).toBe(paused + 1);
    const lastDelta = (lastFrameArgs(engine))[1];
    expect(lastDelta).toBeCloseTo(FRAME_INTERVAL_MS / 1000, 6);
    expect(elapsed).toBeLessThan(FILM_HERO_TIME);
  });

  // -- teardown -------------------------------------------------------------

  it("changing the setting mid-session does not dispose the engine it still needs", async () => {
    // The settings page can flip `emptyStateAnimation` while the empty state is on
    // screen. Re-resolving the mode must NOT recycle the GPU scene: the engine's
    // lifecycle belongs to the mount, and a cleanup that freed it here would leave
    // a canvas with nothing behind it until the pane happened to unmount.
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    const { rerender } = await mount({ setting: "static", createEngine: async () => engine });
    expect(engine.frame).toHaveBeenCalledTimes(1);

    rerender(<EmptyStateFilm setting={null} createEngine={async () => engine} />);
    await settle();

    expect(engine.dispose).not.toHaveBeenCalled();
    expect(canvasOrNull()).not.toBeNull();
    // And the film now animates: the loop is live with the engine still in hand.
    pumpInterval(3);
    expect(engine.frame.mock.calls.length).toBeGreaterThan(1);
  });

  it("unmount disposes the engine and tears down every listener", async () => {
    installCanvasStub("present");
    const engine = makeFakeEngine(litGrid());
    const { unmount } = await mount({ setting: null, createEngine: async () => engine });

    const observer = resizeObservers[0];
    if (observer === undefined) throw new Error("no ResizeObserver was built");
    pumpInterval(2);

    unmount();

    expect(engine.dispose).toHaveBeenCalledTimes(1);
    expect(observer.observed.length).toBe(0);
    expect(pendingFrames.size).toBe(0);

    const calls = engine.frame.mock.calls.length;
    pumpInterval(3);
    expect(engine.frame.mock.calls.length).toBe(calls);
  });

  it("unmount while the engine is still in flight disposes it instead of leaking it", async () => {
    installCanvasStub("present");
    let resolveEngine: ((engine: FilmEngine) => void) | null = null;
    const engine = makeFakeEngine(litGrid());
    const utils = render(
      <EmptyStateFilm
        setting={null}
        createEngine={() =>
          new Promise<FilmEngine>((resolve) => {
            resolveEngine = resolve;
          })
        }
      />,
    );
    await settle();
    utils.unmount();

    await act(async () => {
      if (resolveEngine !== null) (resolveEngine as (engine: FilmEngine) => void)(engine);
      await Promise.resolve();
    });

    // An engine that lands after teardown is freed at once, rather than becoming
    // the invisible 17th live context.
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });
});
