import { beforeEach, beforeAll, describe, expect, test, vi, type Mock } from "vitest";
import type { ChatComposerAttachment } from "../lib/chatAttachments";
import { livePrompts, useQueuedPrompts, type QueuedPrompt } from "./queuedPrompts";

const S1 = "s1";
const S2 = "s2";

/** Literal attachments — NOT `createChatComposerAttachment`, so a store test
 * can never fail because of the attachment factory. */
function attachment(id: string, name = "a.png"): ChatComposerAttachment {
  const file = new File(["x"], name, { type: "image/png" });
  return {
    id,
    file,
    filename: file.name,
    mimeType: "image/png",
    sizeBytes: file.size,
    objectUrl: `blob:mock-${name}`,
  };
}

function prompt(id: string, overrides: Partial<QueuedPrompt> = {}): QueuedPrompt {
  return { id, text: `prompt ${id}`, attachments: [], state: "queued", ...overrides };
}

function list(sessionId = S1): QueuedPrompt[] | undefined {
  return useQueuedPrompts.getState().bySession[sessionId];
}

function revokeCalls(): unknown[] {
  return (URL.revokeObjectURL as Mock).mock.calls.flat();
}

beforeAll(() => {
  URL.createObjectURL = vi.fn((file: File) => `blob:mock-${file.name}`);
  URL.revokeObjectURL = vi.fn();
});

beforeEach(() => {
  // Drop whatever a previous test left behind (the store is a module singleton).
  const sessions = new Set(Object.keys(useQueuedPrompts.getState().bySession));
  for (const id of sessions) useQueuedPrompts.getState().clearSession(id);
  (URL.revokeObjectURL as Mock).mockClear();
});

describe("enqueue", () => {
  test("appends and preserves order (the array order IS the send order)", () => {
    const enqueue = useQueuedPrompts.getState().enqueue;
    enqueue(S1, prompt("p1"));
    enqueue(S1, prompt("p2"));
    enqueue(S1, prompt("p3"));
    expect(list()?.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  test("keeps the raw text and the moved attachments as given", () => {
    const att = attachment("a1");
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { text: "raw $Skill mention", attachments: [att] }));
    const entry = list()?.[0];
    expect(entry?.text).toBe("raw $Skill mention");
    expect(entry?.attachments).toEqual([att]);
  });
});

describe("takeHead", () => {
  test("returns the first LIVE entry and marks it leaving: \"sent\" without removing it", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1"));
    useQueuedPrompts.getState().enqueue(S1, prompt("p2"));
    const taken = useQueuedPrompts.getState().takeHead(S1);
    expect(taken?.id).toBe("p1");
    // The returned value is the marked entry (the row must play its exit animation)...
    expect(list()?.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(list()?.find((p) => p.id === "p1")?.leaving).toBe("sent");
  });

  test("a second takeHead skips the entry already leaving and returns the next", () => {
    const enqueue = useQueuedPrompts.getState().enqueue;
    enqueue(S1, prompt("p1"));
    enqueue(S1, prompt("p2"));
    useQueuedPrompts.getState().takeHead(S1);
    expect(useQueuedPrompts.getState().takeHead(S1)?.id).toBe("p2");
  });

  test("returns undefined for an unknown session", () => {
    expect(useQueuedPrompts.getState().takeHead("nope")).toBeUndefined();
  });

  test("returns undefined and changes nothing when every entry is leaving", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { leaving: "sent" }));
    useQueuedPrompts.getState().enqueue(S1, prompt("p2", { leaving: "deleted" }));
    expect(useQueuedPrompts.getState().takeHead(S1)).toBeUndefined();
    expect(list()?.map((p) => p.leaving)).toEqual(["sent", "deleted"]);
  });

  test("skips a failed entry and returns undefined when every live entry failed", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { failed: true }));
    expect(useQueuedPrompts.getState().takeHead(S1)).toBeUndefined();
    // ... yet the failed entry stays LIVE: the user must see it and fix it.
    expect(livePrompts(list()).map((p) => p.id)).toEqual(["p1"]);
  });

  test("a failed entry ahead of a healthy one yields the turn to the one behind it", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { failed: true }));
    useQueuedPrompts.getState().enqueue(S1, prompt("p2"));
    expect(useQueuedPrompts.getState().takeHead(S1)?.id).toBe("p2");
  });

  test("skips an entry being edited and returns the one behind it", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { state: "editing" }));
    useQueuedPrompts.getState().enqueue(S1, prompt("p2"));
    expect(useQueuedPrompts.getState().takeHead(S1)?.id).toBe("p2");
    // The edited row is left completely alone until the user saves.
    const edited = list()?.find((p) => p.id === "p1");
    expect(edited?.state).toBe("editing");
    expect(edited?.leaving).toBeUndefined();
  });

  test("returns undefined when the only live entry is being edited", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { state: "editing" }));
    expect(useQueuedPrompts.getState().takeHead(S1)).toBeUndefined();
  });
});

describe("requeueHead", () => {
  test("puts the entry back at the FRONT with leaving cleared and does not release its attachments", () => {
    const att = attachment("a1");
    const enqueue = useQueuedPrompts.getState().enqueue;
    enqueue(S1, prompt("p1", { attachments: [att] }));
    enqueue(S1, prompt("p2"));
    const taken = useQueuedPrompts.getState().takeHead(S1)!;
    expect(taken.leaving).toBe("sent");
    // The store clears `leaving` itself — a requeued entry is live again.
    useQueuedPrompts.getState().requeueHead(S1, { ...taken, failed: true });
    expect(list()?.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(list()?.[0]?.leaving).toBeUndefined();
    expect(list()?.[0]?.failed).toBe(true);
    expect(revokeCalls()).toEqual([]);
  });
});

describe("livePrompts", () => {
  test("excludes leaving entries and keeps live ones (including failed)", () => {
    const enqueue = useQueuedPrompts.getState().enqueue;
    enqueue(S1, prompt("p1"));
    enqueue(S1, prompt("p2", { leaving: "sent" }));
    enqueue(S1, prompt("p3", { leaving: "deleted" }));
    enqueue(S1, prompt("p4", { failed: true }));
    expect(livePrompts(list()).map((p) => p.id)).toEqual(["p1", "p4"]);
  });

  test("tolerates an undefined list (the key is deleted once the queue empties)", () => {
    expect(livePrompts(undefined)).toEqual([]);
  });
});

describe("markLeaving", () => {
  test("hides an entry from livePrompts and from takeHead while keeping it mounted", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1"));
    useQueuedPrompts.getState().enqueue(S1, prompt("p2"));
    useQueuedPrompts.getState().markLeaving(S1, "p1", "deleted");
    expect(livePrompts(list()).map((p) => p.id)).toEqual(["p2"]);
    expect(list()?.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(useQueuedPrompts.getState().takeHead(S1)?.id).toBe("p2");
  });

  test("releases nothing on its own", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { attachments: [attachment("a1")] }));
    useQueuedPrompts.getState().markLeaving(S1, "p1", "deleted");
    expect(revokeCalls()).toEqual([]);
  });
});

describe("updateText", () => {
  test("changes only the text", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { attachments: [attachment("a1")] }));
    useQueuedPrompts.getState().updateText(S1, "p1", "edited");
    expect(list()?.[0]).toMatchObject({ text: "edited", state: "queued" });
    expect(list()?.[0]?.leaving).toBeUndefined();
    expect(revokeCalls()).toEqual([]);
  });

  test("on a failed entry clears failed (saving an edit IS the retry gesture)", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { failed: true, state: "editing" }));
    useQueuedPrompts.getState().updateText(S1, "p1", "fixed");
    expect(list()?.[0]?.text).toBe("fixed");
    expect(list()?.[0]?.failed).toBeUndefined();
    // Still not a takeHead candidate while its editor is open (saving does not
    // close the editor) — closing it is what makes it sendable again.
    expect(useQueuedPrompts.getState().takeHead(S1)).toBeUndefined();
    useQueuedPrompts.getState().setEditing(S1, "p1", false);
    expect(useQueuedPrompts.getState().takeHead(S1)?.id).toBe("p1");
  });

  test("leaves an unknown id alone", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1"));
    useQueuedPrompts.getState().updateText(S1, "nope", "x");
    expect(list()?.[0]?.text).toBe("prompt p1");
  });
});

describe("setEditing", () => {
  test("changes only state, and does NOT clear failed (opening the editor is not a retry)", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { failed: true }));
    useQueuedPrompts.getState().setEditing(S1, "p1", true);
    expect(list()?.[0]).toMatchObject({ state: "editing", failed: true, text: "prompt p1" });
    expect(list()?.[0]?.leaving).toBeUndefined();
    useQueuedPrompts.getState().setEditing(S1, "p1", false);
    expect(list()?.[0]).toMatchObject({ state: "queued", failed: true });
  });
});

describe("removeAttachment", () => {
  test("drops just that attachment and releases its object URL", () => {
    const a1 = attachment("a1", "a.png");
    const a2 = attachment("a2", "b.png");
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { attachments: [a1, a2] }));
    useQueuedPrompts.getState().removeAttachment(S1, "p1", "a1");
    expect(list()?.[0]?.attachments.map((a) => a.id)).toEqual(["a2"]);
    expect(revokeCalls()).toEqual(["blob:mock-a.png"]);
  });

  test("leaves text, state and leaving untouched", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { attachments: [attachment("a1")], state: "editing" }));
    useQueuedPrompts.getState().removeAttachment(S1, "p1", "a1");
    expect(list()?.[0]).toMatchObject({ text: "prompt p1", state: "editing" });
    expect(list()?.[0]?.leaving).toBeUndefined();
  });

  test("an unknown attachment id releases nothing", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { attachments: [attachment("a1")] }));
    useQueuedPrompts.getState().removeAttachment(S1, "p1", "nope");
    expect(list()?.[0]?.attachments).toHaveLength(1);
    expect(revokeCalls()).toEqual([]);
  });
});

describe("forget", () => {
  test("removes the entry by id", () => {
    const enqueue = useQueuedPrompts.getState().enqueue;
    enqueue(S1, prompt("p1", { leaving: "deleted" }));
    enqueue(S1, prompt("p2"));
    useQueuedPrompts.getState().forget(S1, "p1");
    expect(list()?.map((p) => p.id)).toEqual(["p2"]);
  });

  test("deletes the bySession key when the list empties", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { leaving: "sent" }));
    useQueuedPrompts.getState().forget(S1, "p1");
    expect("s1" in useQueuedPrompts.getState().bySession).toBe(false);
  });

  test("releases every attachment of a deleted entry", () => {
    const a1 = attachment("a1", "a.png");
    const a2 = attachment("a2", "b.png");
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { leaving: "deleted", attachments: [a1, a2] }));
    useQueuedPrompts.getState().forget(S1, "p1");
    expect(revokeCalls()).toEqual(["blob:mock-a.png", "blob:mock-b.png"]);
  });

  test("does NOT release the attachments of a sent entry (the send path owns them)", () => {
    useQueuedPrompts.getState().enqueue(
      S1,
      prompt("p1", { leaving: "sent", attachments: [attachment("a1")] }),
    );
    useQueuedPrompts.getState().forget(S1, "p1");
    expect(revokeCalls()).toEqual([]);
  });
});

describe("clearSession", () => {
  test("releases every attachment it drops (both leaving values) and deletes the key", () => {
    const enqueue = useQueuedPrompts.getState().enqueue;
    enqueue(S1, prompt("p1", { attachments: [attachment("a1", "a.png")] }));
    enqueue(S1, prompt("p2", { leaving: "sent", attachments: [attachment("a2", "b.png")] }));
    enqueue(S1, prompt("p3", { leaving: "deleted", attachments: [attachment("a3", "c.png")] }));
    useQueuedPrompts.getState().clearSession(S1);
    expect("s1" in useQueuedPrompts.getState().bySession).toBe(false);
    expect(revokeCalls()).toEqual(["blob:mock-a.png", "blob:mock-b.png", "blob:mock-c.png"]);
  });

  test("is a no-op for an unknown session", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1"));
    useQueuedPrompts.getState().clearSession("nope");
    expect(list()?.map((p) => p.id)).toEqual(["p1"]);
  });
});

describe("session isolation", () => {
  test("two sessions' queues never interfere", () => {
    const enqueue = useQueuedPrompts.getState().enqueue;
    enqueue(S1, prompt("a1"));
    enqueue(S2, prompt("b1"));
    enqueue(S2, prompt("b2"));
    expect(useQueuedPrompts.getState().takeHead(S1)?.id).toBe("a1");
    expect(list(S2)?.map((p) => p.id)).toEqual(["b1", "b2"]);
    useQueuedPrompts.getState().updateText(S2, "b1", "edited");
    expect(list(S1)?.[0]?.text).toBe("prompt a1");
    useQueuedPrompts.getState().clearSession(S2);
    expect(list(S1)?.map((p) => p.id)).toEqual(["a1"]);
    expect("s2" in useQueuedPrompts.getState().bySession).toBe(false);
  });
});
