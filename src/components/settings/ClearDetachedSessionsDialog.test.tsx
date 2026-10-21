import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import ClearDetachedSessionsDialog from "./ClearDetachedSessionsDialog";

// Presentational component: no store, no IPC (see the component's doc comment),
// so there is nothing to mock — the whole contract is the dialog's TEXT and its
// two exits. Every assertion is scoped with `within(dialog)` (the pattern in
// `src/components/SpacesList.test.tsx:2575`): the folder list renders the same
// strings the surrounding section renders, so an unscoped `getByText` would be
// ambiguous the moment this dialog is mounted inside that section.
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(
  props: Partial<{
    count: number;
    folders: string[];
    onConfirm: () => void;
    onClose: () => void;
  }> = {},
) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ClearDetachedSessionsDialog
      count={3}
      folders={["/tmp/beta", "/tmp/gamma", "/tmp/delta"]}
      onConfirm={onConfirm}
      onClose={onClose}
      {...props}
    />,
  );
  return { onConfirm, onClose, dialog: screen.getByRole("dialog") };
}

describe("ClearDetachedSessionsDialog", () => {
  it("names BOTH the session count and the folder count in the title", () => {
    const { dialog } = renderDialog();
    // ADR 0016's amendment: the confirm names the blast radius. The count and
    // the folder count are the two numbers that decide whether this is the
    // sweep you meant.
    expect(
      within(dialog).getByText("Delete 3 detached sessions from 3 folders?"),
    ).toBeTruthy();
  });

  it("lists every folder passed to it", () => {
    const { dialog } = renderDialog();
    for (const folder of ["/tmp/beta", "/tmp/gamma", "/tmp/delta"]) {
      expect(within(dialog).getByText(folder)).toBeTruthy();
    }
  });

  it("renders the folder list sorted, whatever order the props arrive in", () => {
    // The caller may hand these over in store order; the dialog's own text is
    // deterministic so the confirm reads the same every time.
    const { dialog } = renderDialog({
      folders: ["/tmp/zeta", "/tmp/alpha", "/tmp/mid"],
    });
    const listed = within(dialog)
      .getAllByText(/^\/tmp\//)
      .map((node) => node.textContent);
    expect(listed).toEqual(["/tmp/alpha", "/tmp/mid", "/tmp/zeta"]);
  });

  it("lists FULL paths, so two folders sharing a base name both appear", () => {
    // The dialog is the evidence that this is the sweep you meant: `/proj` and
    // `/mnt/backup/proj` must read as two entries, not as `proj` once.
    const { dialog } = renderDialog({
      count: 2,
      folders: ["/home/alice/proj", "/mnt/backup/proj"],
    });
    expect(
      within(dialog).getByText("/home/alice/proj"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("/mnt/backup/proj"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Delete 2 detached sessions from 2 folders?"),
    ).toBeTruthy();
  });

  it("singularizes BOTH nouns when one session in one folder is at stake", () => {
    // Grammar the count must not break: "Delete 1 detached session from 1
    // folder?" — the wording is otherwise identical.
    const { dialog } = renderDialog({ count: 1, folders: ["/tmp/beta"] });
    expect(
      within(dialog).getByText("Delete 1 detached session from 1 folder?"),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Delete 1 session" }),
    ).toBeTruthy();
  });

  it("pluralizes both nouns once either count passes one", () => {
    // ONE session spread over TWO folders still reads "2 folders" — each noun
    // agrees with its OWN number.
    const { dialog } = renderDialog({
      count: 1,
      folders: ["/tmp/beta", "/tmp/gamma"],
    });
    expect(
      within(dialog).getByText("Delete 1 detached session from 2 folders?"),
    ).toBeTruthy();
  });

  it("labels the destructive button with the count", () => {
    const { dialog } = renderDialog({ count: 7 });
    expect(
      within(dialog).getByRole("button", { name: "Delete 7 sessions" }),
    ).toBeTruthy();
  });

  it("Cancel calls onClose and never onConfirm", () => {
    const { dialog, onConfirm, onClose } = renderDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Escape calls onClose and never onConfirm", () => {
    const { dialog, onConfirm, onClose } = renderDialog();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("only the destructive button reaches onConfirm", () => {
    const { dialog, onConfirm, onClose } = renderDialog();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete 3 sessions" }),
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
