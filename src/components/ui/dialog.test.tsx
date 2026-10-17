import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";

// Why this file exists at all: `DialogContent`'s base class is `w-full
// max-w-[calc(100%-2rem)]`, and `w-full` on a `fixed` element resolves
// against the VIEWPORT — so a caller that passes no width fills the window.
// The sibling primitive `AlertDialogContent` already ended its base class
// with `sm:max-w-md`; `DialogContent` not doing so is the asymmetry that made
// the New Space dialog span the app.
//
// The `<DialogHeader>`/`<DialogTitle>` wrapper is not decoration: Radix
// `console.error`s about a dialog with no accessible title, and a green-but-
// noisy test hides a real failure (see the same note in `App.test.tsx`). A
// bare `ui/dialog` mount needs no `matchMedia`/`scrollIntoView` stubs and no
// Tauri mocks — the primitive touches neither.
//
// Note for the `grep -rn "<DialogContent" src/ | grep -v "sm:max-w"`
// straggler check: the fixture below is that grep's second hit (the first is
// `NewSpaceDialog.tsx`), and it is NOT a straggler — it forwards
// `className={className}` precisely so one case can render the no-width
// caller. Scope the grep with `--exclude=*.test.tsx`.
function renderContent(className?: string): void {
  render(
    <Dialog open>
      <DialogContent data-testid="content" className={className}>
        <DialogHeader>
          <DialogTitle>Width</DialogTitle>
          <DialogDescription>The default cap.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>,
  );
}

// Token-set membership, never `toContain`: `toContain("max-w-md")` also
// matches INSIDE `"sm:max-w-md"`, so a substring assertion cannot tell the
// two merge groups apart — which is the exact distinction this test guards.
function tokens(): string[] {
  return (screen.getByTestId("content").className as string).split(/\s+/);
}

describe("DialogContent width default", () => {
  it("caps itself at sm:max-w-md when the caller passes no width", () => {
    renderContent();
    expect(tokens()).toContain("sm:max-w-md");
  });

  it("keeps the viewport-relative cap that holds a dialog inside a narrow window", () => {
    renderContent();
    const classTokens = tokens();
    expect(classTokens).toContain("w-full");
    expect(classTokens).toContain("max-w-[calc(100%-2rem)]");
  });

  it("a caller stating its width in the sm: form replaces the default", () => {
    renderContent("sm:max-w-3xl");
    const classTokens = tokens();
    expect(classTokens).toContain("sm:max-w-3xl");
    expect(classTokens).not.toContain("sm:max-w-md");
  });

  // The trap this whole migration exists for: `cn()` is `tailwind-merge`, and
  // it files `max-w-3xl` and `sm:max-w-md` in DIFFERENT groups, so both
  // survive into the emitted class list — and the `sm:` rule is emitted later
  // than the plain one, so it wins above 640px. An unmigrated caller is
  // therefore silently 28rem on a desktop window, invisible to jsdom.
  it("a caller passing a bare max-w-* does NOT win (the groups differ, so the default survives)", () => {
    renderContent("max-w-3xl");
    const classTokens = tokens();
    expect(classTokens).toContain("max-w-3xl");
    expect(classTokens).toContain("sm:max-w-md");
  });
});
