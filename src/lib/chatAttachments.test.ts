import { describe, expect, test, vi, beforeAll } from "vitest";
import { createChatComposerAttachment, readAttachmentAsBase64, releaseAttachment, addImageAttachments, agentSupportsImages, imageMarker, insertAtCaret, renumberImageMarkers, shiftImageMarkers, draftIsMarkerOnly } from "./chatAttachments";

describe("chatAttachments", () => {
  beforeAll(() => {
    URL.createObjectURL = vi.fn((file: File) => `blob:mock-${file.name}`);
    URL.revokeObjectURL = vi.fn();
  });

  test("createChatComposerAttachment creates correct structure", () => {
    const file = new File(["x"], "s.png", { type: "image/png" });
    const attachment = createChatComposerAttachment(file);
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.sizeBytes).toBe(1);
    expect(attachment.objectUrl).toBe("blob:mock-s.png");
  });

  test("createChatComposerAttachment infers mime type", () => {
    const file = new File(["x"], "s.webp", { type: "" });
    const attachment = createChatComposerAttachment(file);
    expect(attachment.mimeType).toBe("image/webp");
  });

  test("readAttachmentAsBase64 reads correctly", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    const attachment = createChatComposerAttachment(file);
    const base64 = await readAttachmentAsBase64(attachment);
    expect(base64).toBe("AQID");
  });

  test("releaseAttachment calls revokeObjectURL", () => {
    const file = new File(["x"], "s.png", { type: "image/png" });
    const attachment = createChatComposerAttachment(file);
    releaseAttachment(attachment);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-s.png");
  });

  describe("addImageAttachments", () => {
    test("rejects non-image files", () => {
      const file = new File(["x"], "a.txt", { type: "text/plain" });
      const { attachments, rejected } = addImageAttachments([], [file]);
      expect(attachments.length).toBe(0);
      expect(rejected[0]).toContain("is not a supported image format");
    });

    test("rejects unsupported image types", () => {
      const file = new File(["x"], "a.svg", { type: "image/svg+xml" });
      const { attachments, rejected } = addImageAttachments([], [file]);
      expect(attachments.length).toBe(0);
      expect(rejected[0]).toContain("is not a supported image format");
    });

    test("rejects files over 10 MiB", () => {
      const file = new File([new Uint8Array(11 * 1024 * 1024)], "big.png", { type: "image/png" });
      const { attachments, rejected } = addImageAttachments([], [file]);
      expect(attachments.length).toBe(0);
      expect(rejected[0]).toContain("exceeds the 10 MiB limit");
    });

    test("rejects more than 8 attachments", () => {
      const existing = Array(8).fill(null).map((_, i) => ({ id: `${i}`, file: new File(["x"], "s.png"), filename: "s.png", mimeType: "image/png", sizeBytes: 1, objectUrl: "url" }));
      const file = new File(["x"], "extra.png", { type: "image/png" });
      const { attachments, rejected } = addImageAttachments(existing, [file]);
      expect(attachments.length).toBe(8);
      expect(rejected[0]).toBe("at most 8 images per message");
    });

    test("accepts valid files", () => {
      const file1 = new File(["x"], "a.png", { type: "image/png" });
      const file2 = new File(["y"], "b.jpg", { type: "image/jpeg" });
      const { attachments, rejected } = addImageAttachments([], [file1, file2]);
      expect(attachments.length).toBe(2);
      expect(rejected.length).toBe(0);
    });
  });

  // ── The `[image #N]` draft markers (Task 3) ──────────────────────────────
  //
  // `N` counts the attachments of ONE message, never the session: the harness
  // (`src-tauri/src/agent/harness/loop.rs`, the `MessageContent::Blocks` build)
  // pushes the text block FIRST and then the images in send order, so "the Nth
  // image of this prompt" is the only reading a model can resolve.

  describe("imageMarker", () => {
    test("is the bracketed marker for a 1-based position", () => {
      expect(imageMarker(1)).toBe("[image #1]");
      expect(imageMarker(9)).toBe("[image #9]");
    });
  });

  describe("insertAtCaret", () => {
    test("inserts at the caret and returns the caret AFTER the inserted text", () => {
      const r = insertAtCaret("hello", 5, "[image #1]");
      expect(r.text).toBe("hello [image #1]");
      expect(r.caret).toBe(16); // 5 + " " + 10 chars of marker
    });

    test("inserts MID-string, keeping the text after the caret", () => {
      const r = insertAtCaret("ab cd", 2, "[image #1]");
      expect(r.text).toBe("ab [image #1] cd");
      expect(r.caret).toBe(13);
    });

    test("adds NO space when the character before the caret is whitespace", () => {
      expect(insertAtCaret("a ", 2, "[image #1]").text).toBe("a [image #1]");
      // The reachable no-space branch: a caret that follows a NEWLINE (the
      // user pasted on a fresh line of a multi-line draft).
      expect(insertAtCaret("a\n", 2, "[image #1]")).toEqual({
        text: "a\n[image #1]",
        caret: 12,
      });
    });

    test("adds NO space at the start of the draft (no stray leading blank)", () => {
      expect(insertAtCaret("", 0, "[image #1]")).toEqual({
        text: "[image #1]",
        caret: 10,
      });
      expect(insertAtCaret("draft", 0, "[image #1]")).toEqual({
        text: "[image #1]draft",
        caret: 10,
      });
    });

    test("clamps a caret outside the string (a stale caret is not a crash)", () => {
      expect(insertAtCaret("ab", 9, "[image #1]").text).toBe("ab [image #1]");
    });
  });

  describe("renumberImageMarkers", () => {
    // THE WHITESPACE CONTRACT, measured, verbatim. Without it the deletion
    // leaves orphan blanks (`"look at  and stuff"`) — and the shape of the
    // repair is load-bearing: the space is NEVER part of the marker match,
    // because that would swallow the separator following the LAST marker of a
    // mid-sentence draft.
    const table: [string, number, string][] = [
      ["[image #1]", 1, ""],
      ["[image #1] [image #2]", 1, "[image #1]"],
      ["a [image #1] [image #2] [image #3] b", 2, "a [image #1] [image #2] b"],
      ["a [image #1] [image #2] [image #3] b", 3, "a [image #1] [image #2] b"],
      ["look at [image #1] and stuff", 1, "look at and stuff"],
      ["prose with #3 unbracketed [image #1]", 1, "prose with #3 unbracketed"],
    ];
    for (const [input, removedAt, output] of table) {
      test(`"${input}" minus #${removedAt} → "${output}"`, () => {
        expect(renumberImageMarkers(input, removedAt)).toBe(output);
      });
    }

    test("keys on the NUMBER, not on text order (the caret case)", () => {
      // Markers are inserted AT THE CARET, so the text can hold them in an
      // order that differs from the staging order. Dropping the attachment
      // staged second (#2) deletes `[image #2]` wherever it sits and
      // decrements every number ABOVE 2 — a positional rescan of the text
      // would instead delete the FIRST marker it finds (`[image #2]` here, so
      // the answer would come out as `before [image #2]`).
      expect(renumberImageMarkers("[image #2] before [image #1]", 2)).toBe(
        "before [image #1]",
      );
      // The same shape from the other side: removing #1 leaves #2 in place and
      // shifts it down, even though #2 sits FIRST in the text.
      expect(renumberImageMarkers("[image #2] before [image #1]", 1)).toBe(
        "[image #1] before",
      );
    });

    test("leaves prose that mentions a bare number untouched", () => {
      // The pattern is the EXACT literal `[image #N]` — a bare `#3` in prose is
      // not a marker, so it is neither deleted nor decremented (only the
      // bracketed marker above the removed position moves down).
      expect(renumberImageMarkers("issue #3 and [image #4]", 1)).toBe(
        "issue #3 and [image #3]",
      );
    });

    test("still decrements when the removed marker's text is gone from the draft", () => {
      // The user backspaced `[image #1]` out of the draft and then clicks ✕ on
      // attachment 1: nothing is left to delete, but the SURVIVOR still shifts
      // (the draft's numbers must keep naming the right picture).
      expect(renumberImageMarkers("[image #2]", 1)).toBe("[image #1]");
    });

    test("repairs whitespace ONLY when a marker was actually deleted", () => {
      // Nothing named by `removedAt` exists, so the user's own double blanks
      // are not ours to rewrite — the collapse belongs to the deletion, not to
      // the decrement.
      expect(renumberImageMarkers("a  [image #3]  b", 1)).toBe("a  [image #2]  b");
    });

    test("collapses only the blanks the DELETION created, not the user's own", () => {
      // The double space is nowhere near the deleted marker, so it stays: the
      // pass repairs the seam, it does not reformat the draft.
      expect(renumberImageMarkers("a  b [image #1]", 1)).toBe("a  b");
      expect(renumberImageMarkers("keep  spacing [image #1] tail", 1)).toBe(
        "keep  spacing tail",
      );
    });

    test("does not invent a separator when a marker was welded between words", () => {
      // No space existed on either side of the marker, so none appears after
      // the deletion either — the repair restores the text that was there.
      expect(renumberImageMarkers("a[image #1]b", 1)).toBe("ab");
    });

    test("leaves a draft with no markers alone", () => {
      expect(renumberImageMarkers("no markers here", 1)).toBe("no markers here");
    });

    test("touches NOTHING for a position below 1 (an unknown attachment)", () => {
      // `removeAttachment` derives the position from `findIndex(...) + 1`, so
      // an id that is no longer in the list yields 0. Decrementing "everything
      // above 0" would shift EVERY marker — a no-op is the only safe answer.
      expect(renumberImageMarkers("[image #1] [image #2]", 0)).toBe(
        "[image #1] [image #2]",
      );
    });
  });

  describe("shiftImageMarkers", () => {
    // WHY THIS EXISTS: the numbers a draft's markers use are POSITIONAL — they
    // count the attachments of THIS message in list order (see `imageMarker`).
    // A send moves its attachments out of the composer, so anything staged
    // while the turn runs is numbered against the SHORTER list; when a failed
    // send puts the held attachments back IN FRONT, every list position below
    // the inserted block moves down by exactly the number restored, and the
    // draft's numbers have to move with it or each marker names its
    // predecessor's picture.
    test("moves EVERY marker up by `by` (the restore-prepends-N case)", () => {
      expect(shiftImageMarkers("look at [image #1]", 1)).toBe(
        "look at [image #2]",
      );
      expect(shiftImageMarkers("[image #1] and [image #2]", 3)).toBe(
        "[image #4] and [image #5]",
      );
    });

    test("is a NO-OP for `by === 0` (nothing was restored)", () => {
      expect(shiftImageMarkers("look at [image #1]", 0)).toBe(
        "look at [image #1]",
      );
    });

    test("matches ONLY the exact literal (prose `#3` is not a marker)", () => {
      // The same no-looser-pattern discipline as `renumberImageMarkers`: a bare
      // `#3`, a bracketed-but-not-ours `[foo #3]` and a marker missing its `]`
      // are all the user's own text and stay byte-identical.
      expect(shiftImageMarkers("issue #3 [foo #3] [image #3", 1)).toBe(
        "issue #3 [foo #3] [image #3",
      );
      expect(shiftImageMarkers("issue #3 and [image #3]", 1)).toBe(
        "issue #3 and [image #4]",
      );
    });

    test("shifts markers in ANY text order (the shift is keyed on the number)",
      () => {
        // A marker lands at the caret, so a draft can hold `#2` before `#1`;
        // shifting by number (not by scan position) keeps both correct.
        expect(shiftImageMarkers("[image #2] before [image #1]", 2)).toBe(
          "[image #4] before [image #3]",
        );
      });

    test("shifts DOWN for a negative `by`, and never invents a number below 1",
      () => {
        // The restore drops the overflow past the attachment cap, so the count
        // it actually restored can differ from the block that left the
        // composer — the shift uses that real count. A marker the shift would
        // drive to `#0` names nothing at all, so it is left alone rather than
        // rewritten into a number no attachment holds.
        expect(shiftImageMarkers("[image #4] and [image #3]", -2)).toBe(
          "[image #2] and [image #1]",
        );
        expect(shiftImageMarkers("[image #3] and [image #2]", -2)).toBe(
          "[image #1] and [image #2]",
        );
      });

    test("leaves a marker-less draft untouched (a shift never invents text)",
      () => {
        expect(shiftImageMarkers("no markers here", 4)).toBe("no markers here");
        expect(shiftImageMarkers("", 4)).toBe("");
      });
  });

  describe("draftIsMarkerOnly", () => {
    test("is true when the draft holds NOTHING but markers", () => {
      expect(draftIsMarkerOnly("[image #1]")).toBe(true);
      expect(draftIsMarkerOnly("[image #1] [image #2] [image #3]")).toBe(true);
      // The blanks `insertAtCaret` adds are not content either.
      expect(draftIsMarkerOnly("  [image #1]  ")).toBe(true);
    });

    test("is false the moment there is prose to send", () => {
      expect(draftIsMarkerOnly("explain [image #1]")).toBe(false);
      expect(draftIsMarkerOnly("[image #1] and [image #2]")).toBe(false);
      expect(draftIsMarkerOnly("[image #1]x")).toBe(false);
    });

    test("is false for the EMPTY draft (the caller's own case stays separate)", () => {
      // The predicate answers "is everything here a marker?", not "is there
      // nothing?". Keeping `""` out of it means a caller adds to an existing
      // emptiness check instead of silently redefining it.
      expect(draftIsMarkerOnly("")).toBe(false);
      expect(draftIsMarkerOnly("   ")).toBe(false);
    });

    test("is false for a bare `#3` in prose (the pattern is the bracketed literal)",
      () => {
        expect(draftIsMarkerOnly("#3")).toBe(false);
      });
  });

  describe("agentSupportsImages", () => {
    test("returns true for correct capability", () => {
      expect(agentSupportsImages({ promptCapabilities: { image: true } })).toBe(true);
    });
    test("returns false for incorrect capability", () => {
      expect(agentSupportsImages({ promptCapabilities: { image: false } })).toBe(false);
    });
    test("returns false for empty", () => {
      expect(agentSupportsImages({})).toBe(false);
      expect(agentSupportsImages(undefined)).toBe(false);
    });
  });
});
