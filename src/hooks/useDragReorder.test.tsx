import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDragReorder } from "./useDragReorder";
import { useWindowDropBackstop } from "./useWindowDropBackstop";

/**
 * `useDragReorder` — the one drag gesture both lists will share.
 *
 * This file is `.tsx` because the hook's contract IS DOM: it needs real elements
 * to carry `dragProps` and to stub their rects, so it drives a probe component
 * rather than `renderHook` (the same reason `ChatStream.test.tsx` is `.tsx`). It
 * is also the first `.tsx` test under `src/hooks/`.
 *
 * THE THREE jsdom FACTS every test here is built on — all measured on this tree,
 * none of them guessable, all of them traps if you reach for the obvious idiom:
 *  1. `DragEvent` and `DataTransfer` are both `undefined` in this jsdom, so every
 *     drag event is hand-built as a plain cancelable `Event`.
 *  2. `fireEvent.dragStart(el, { dataTransfer })` DOES deliver the stub (the
 *     library `defineProperty`s that one init member), but
 *     `fireEvent.dragOver(el, { clientY })` does NOT deliver `clientY` — a plain
 *     `Event` swallows the unknown init member, so it arrives `undefined` and
 *     every midpoint comparison collapses onto one branch. Hence `dragOver`
 *     below, which assigns the property after construction.
 *  3. `getBoundingClientRect()` is all zeros in jsdom, so the midpoint is `0` and
 *     EVERY pointer answers "after". Hence `layOut` below: without it,
 *     before-vs-after is not merely untested, it is untestable.
 */

/** jsdom has no DataTransfer (measured `undefined`). The hook CALLS exactly one
 *  member — `setData` — so exactly one is stubbed; `getData` is deliberately
 *  absent, because a hook that read it would be inviting a cross-window drop this
 *  single-window app cannot serve. */
const stubDataTransfer = () => ({ setData: vi.fn() });

/** `fireEvent.dragOver(el, { clientY })` does NOT deliver clientY (measured:
 *  undefined) — build the event and assign it. The return value is `false` iff a
 *  handler called `preventDefault`, which is how cancelability is asserted.
 *  `cancelable: true` is what makes that mean anything (the same reason
 *  `useWindowDropBackstop.test.ts`'s helpers say so). */
const dragOver = (el: Element, clientY: number) => {
  const ev = new Event("dragover", { bubbles: true, cancelable: true, composed: true });
  Object.assign(ev, { clientY });
  return fireEvent(el, ev);
};

/** A hand-built `drop`, returned rather than fired so a test can spy on it or
 *  read `defaultPrevented` after the fact. */
const buildDrop = () =>
  new Event("drop", { bubbles: true, cancelable: true, composed: true });

/** jsdom has no layout: the default rect is all zeros → midpoint 0 → every
 *  pointer "after" (measured). Override it so the half is a fact the TEST
 *  chooses. Without this the before/after assertions agree by accident. */
const layOut = (el: HTMLElement, top: number, height = 40) => {
  el.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      height,
      width: 200,
      left: 0,
      right: 200,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
};

/** The probe: one row per id, each wearing the hook's spread surface verbatim
 *  (which is exactly how T06 will wear it, through `RowButton`'s `...rest`), plus
 *  a readout of the gesture state so the tests assert what a RENDER would see —
 *  the reason the hook keeps that state in `useState` rather than refs. */
function Probe(props: {
  ids: readonly string[];
  onReorder: (ids: string[]) => void;
}) {
  const hook = useDragReorder(props);
  captured = hook;
  return (
    <div>
      <div data-testid="gesture">
        {JSON.stringify({
          draggingId: hook.draggingId,
          overId: hook.overId,
          overEdge: hook.overEdge,
        })}
      </div>
      {props.ids.map((id) => (
        <div key={id} data-testid={`row-${id}`} {...hook.dragProps(id)}>
          {id}
        </div>
      ))}
    </div>
  );
}

/** The same probe under spec hazard 2: the window drop backstop mounted alongside
 *  it, because "the row wins without `stopPropagation`" is only true if BOTH are
 *  listening. */
function ProbeWithBackstop(props: {
  ids: readonly string[];
  onReorder: (ids: string[]) => void;
}) {
  useWindowDropBackstop();
  return <Probe {...props} />;
}

/** The hook's return value as the last render produced it — the only way test 1
 *  can ask `dragProps` for its own key set. The probe is the sole writer. */
let captured: ReturnType<typeof useDragReorder> | null = null;

const IDS = ["r1", "r2", "r3", "r4", "r5"];

const gesture = () => JSON.parse(screen.getByTestId("gesture").textContent ?? "{}");
const row = (id: string) => screen.getByTestId(`row-${id}`);

beforeEach(() => {
  captured = null;
});

describe("useDragReorder (the gesture both lists share)", () => {
  it("dragProps returns exactly draggable + the five handlers (T06 spreads this onto a byte-compared row)", () => {
    render(<Probe ids={IDS} onReorder={vi.fn()} />);
    // TWO COMPETING ANSWERS: the contract is EXACTLY these six keys; anything
    // extra — a `className`, an `onDragEnter`, a `data-*` — is a second answer,
    // and `RowButton`'s header pins attribute order because its row
    // serialisation is byte-compared, so an extra key breaks T06's file.
    expect(Object.keys(captured!.dragProps("r1")).sort()).toEqual([
      "draggable",
      "onDragEnd",
      "onDragLeave",
      "onDragOver",
      "onDragStart",
      "onDrop",
    ]);
    expect(captured!.dragProps("r1").draggable).toBe(true);
  });

  it("onDragStart marks the row as the one being dragged, and seeds the native drag with setData", () => {
    const onReorder = vi.fn();
    render(<Probe ids={IDS} onReorder={onReorder} />);
    const stub = stubDataTransfer();
    fireEvent.dragStart(row("r1"), { dataTransfer: stub });
    expect(gesture()).toEqual({ draggingId: "r1", overId: null, overEdge: null });
    // THE Firefox PIN: a hook that skips `setData` is GREEN in jsdom and broken
    // in Firefox, which starts no drag without a payload. This call assertion is
    // the only place that requirement can be pinned.
    expect(stub.setData).toHaveBeenCalledWith("text/plain", "r1");
  });

  it("onDragOver makes the row a drop target and reports the pointer's half: above the midpoint is BEFORE, below is AFTER", () => {
    render(<Probe ids={IDS} onReorder={vi.fn()} />);
    fireEvent.dragStart(row("r5"), { dataTransfer: stubDataTransfer() });
    // Row 2 occupies 100..140, so its midpoint is 120. Without `layOut` the
    // midpoint is 0 and BOTH pointers below answer "after" — which is how a hook
    // that never reads the rect and a test that never overrides the rect agree.
    layOut(row("r2"), 100);
    expect(dragOver(row("r2"), 110)).toBe(false); // false === prevented === accepts drops
    expect(gesture()).toEqual({ draggingId: "r5", overId: "r2", overEdge: "before" });
    expect(dragOver(row("r2"), 130)).toBe(false);
    expect(gesture()).toEqual({ draggingId: "r5", overId: "r2", overEdge: "after" });
  });

  it("drop on a row's TOP half lands the dragged id ABOVE it; its BOTTOM half lands the id BELOW it, and onReorder gets the whole visible slice", () => {
    // Spec §5 test #13 at the hook level.
    const onReorder = vi.fn();
    render(<Probe ids={IDS} onReorder={onReorder} />);
    layOut(row("r2"), 100);

    fireEvent.dragStart(row("r5"), { dataTransfer: stubDataTransfer() });
    dragOver(row("r2"), 110); // top half → BEFORE
    fireEvent(row("r2"), buildDrop());
    // THE ROW IS THE TARGET, so "before" means DIRECTLY ABOVE r2. TWO COMPETING
    // ANSWERS: an off-by-one that reads "before" as one slot earlier answers
    // ["r5","r1","r2","r3","r4"] — the dragged row lands above r1, one row too
    // HIGH, while the indicator was promising r2. (The T05 plan printed exactly
    // that array here and labelled the correct answer the bug; the plan's own
    // reference `moveId` and its bottom-half expectation both say THIS array, so
    // the expectation was the slip. See the task report.)
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenLastCalledWith(["r1", "r5", "r2", "r3", "r4"]);

    // The bottom half, in a second gesture: the OTHER answer, which is what
    // stops a hook that always inserts after from passing.
    onReorder.mockClear();
    fireEvent.dragStart(row("r5"), { dataTransfer: stubDataTransfer() });
    dragOver(row("r2"), 130); // bottom half → AFTER
    fireEvent(row("r2"), buildDrop());
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenLastCalledWith(["r1", "r2", "r5", "r3", "r4"]);
  });

  it("dragging a row onto itself is a no-op: it is not even a drop target, and onReorder never runs", () => {
    const onReorder = vi.fn();
    render(<Probe ids={IDS} onReorder={onReorder} />);
    layOut(row("r3"), 100);
    fireEvent.dragStart(row("r3"), { dataTransfer: stubDataTransfer() });
    // TRUE, not false: nothing prevented the event, so the browser shows its
    // no-drop cursor and the window backstop is what swallows the release.
    // TWO COMPETING ANSWERS: a hook treating self-drop as a normal target
    // answers `overId === "r3"` and prevented.
    expect(dragOver(row("r3"), 130)).toBe(true);
    expect(gesture().overId).toBeNull();
    fireEvent(row("r3"), buildDrop());
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("the gesture state is cleared by onDragEnd (Esc cancels a drag and fires NO drop) and by onDrop", () => {
    const onReorder = vi.fn();
    const cleared = { draggingId: null, overId: null, overEdge: null };
    render(<Probe ids={IDS} onReorder={onReorder} />);
    layOut(row("r2"), 100);

    // Act one — `dragend`. Pressing Escape mid-drag fires `dragend` and NO
    // `drop`, and a lingering `draggingId` would make the next `dragOver` believe
    // a drag is still on.
    fireEvent.dragStart(row("r1"), { dataTransfer: stubDataTransfer() });
    fireEvent.dragEnd(row("r1"));
    expect(gesture()).toEqual(cleared);

    // Act two — a completed drop clears the same three.
    fireEvent.dragStart(row("r5"), { dataTransfer: stubDataTransfer() });
    dragOver(row("r2"), 130);
    fireEvent(row("r2"), buildDrop());
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(gesture()).toEqual(cleared);
  });

  it("onDragLeave clears the target only when the pointer leaves the CURRENT target (a stale leave must not flicker the indicator off)", () => {
    render(<Probe ids={IDS} onReorder={vi.fn()} />);
    layOut(row("r3"), 100);
    fireEvent.dragStart(row("r1"), { dataTransfer: stubDataTransfer() });
    dragOver(row("r3"), 130);
    expect(gesture().overId).toBe("r3");
    // The browser really does fire `dragleave` on the row the pointer CAME
    // FROM, after the `dragover` on the one it arrived at. TWO COMPETING
    // ANSWERS: an unconditional clear answers `null` here and the indicator
    // blinks off on every row-to-row move; the guarded version keeps "r3".
    fireEvent.dragLeave(row("r2"));
    expect(gesture()).toEqual({ draggingId: "r1", overId: "r3", overEdge: "after" });
    // Leaving the row that IS the target does clear it.
    fireEvent.dragLeave(row("r3"));
    expect(gesture()).toEqual({ draggingId: "r1", overId: null, overEdge: null });
  });

  it("a row's drop never calls stopPropagation, so the window drop backstop still sees the event", () => {
    // SPEC HAZARD 2, pinned where both halves are in reach.
    const onReorder = vi.fn();
    render(<ProbeWithBackstop ids={IDS} onReorder={onReorder} />);
    layOut(row("r3"), 100);
    fireEvent.dragStart(row("r1"), { dataTransfer: stubDataTransfer() });
    dragOver(row("r3"), 130);

    const ev = buildDrop();
    const spy = vi.spyOn(ev, "stopPropagation");
    const notPrevented = fireEvent(row("r3"), ev);
    expect(onReorder).toHaveBeenCalledTimes(1);
    // The row wins (false === prevented) WITHOUT taking propagation away: a hook
    // that "helpfully" called `stopPropagation` would read 1 here and leave the
    // backstop deaf in the real webview.
    expect(notPrevented).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it("a reorder drag released OUTSIDE any row is still swallowed by the backstop (no webview navigation)", () => {
    const onReorder = vi.fn();
    render(<ProbeWithBackstop ids={IDS} onReorder={onReorder} />);
    layOut(row("r3"), 100);
    fireEvent.dragStart(row("r1"), { dataTransfer: stubDataTransfer() });
    dragOver(row("r3"), 130);
    // Released on `document.body` — outside every row. The window listener still
    // swallows it, and no list moves.
    const ev = buildDrop();
    fireEvent(document.body, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("an id the list no longer contains gets no reorder (a row that closed mid-drag cannot half-move the list)", () => {
    const onReorder = vi.fn();
    const { rerender } = render(<Probe ids={IDS} onReorder={onReorder} />);
    layOut(row("r2"), 100);
    fireEvent.dragStart(row("r1"), { dataTransfer: stubDataTransfer() });
    // The row closes mid-drag: the next render has no `r1` at all.
    rerender(<Probe ids={["r2", "r3", "r4", "r5"]} onReorder={onReorder} />);
    dragOver(row("r2"), 110);
    fireEvent(row("r2"), buildDrop());
    // TWO COMPETING ANSWERS: an unguarded move would splice `undefined` into the
    // slice, or insert nothing and STILL fire the IPC — and a fired IPC carrying
    // a stale slice is exactly the half-moved list.
    expect(onReorder).not.toHaveBeenCalled();
  });
});
