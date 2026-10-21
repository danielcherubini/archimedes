import { beforeEach, beforeAll, describe, expect, test, vi, type Mock } from "vitest";
import type { ChatComposerAttachment } from "../lib/chatAttachments";
import { useQueuedPrompts, type QueuedPrompt } from "./queuedPrompts";

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
    // ... yet the failed entry stays LIVE — not `leaving` — so the row keeps
    // rendering it and the user can fix it. `failed` hides an entry from
    // `takeHead` ONLY; it is `leaving` that removes it from view.
    expect(list()?.map((p) => p.id)).toEqual(["p1"]);
    expect(list()?.[0]?.leaving).toBeUndefined();
    expect(list()?.[0]?.failed).toBe(true);
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

  test("inserts NOTHING for a session whose key no longer exists (a closed Session stays clean)", () => {
    // THE ORPHAN PIN. `closeSession` / delete call `clearSession` (ADR 0069: a
    // reopened Session must not offer a Flush whose turn can never arrive) —
    // but a Flush already in flight doesn't know that. Its `sendPrompt` then
    // rejects with unknown-session and the catch requeues: an unconditional
    // insert would re-create the key nobody will ever clear again, permanently
    // orphaning an entry that holds a `File` and previews that were already
    // revoked. So a missing key means "this Session's queue is gone", and the
    // requeue is dropped.
    useQueuedPrompts.getState().enqueue(S1, prompt("p1"));
    const taken = useQueuedPrompts.getState().takeHead(S1)!;
    useQueuedPrompts.getState().clearSession(S1);
    useQueuedPrompts.getState().requeueHead(S1, { ...taken, failed: true });
    expect("s1" in useQueuedPrompts.getState().bySession).toBe(false);
    // And the dropped requeue released nothing — nobody owns those URLs any
    // more than this function does, and `clearSession` already released them.
    expect(revokeCalls()).toEqual([]);
  });
});

describe("markLeaving", () => {
  test("hides an entry from takeHead while keeping it in the list, mounted for its exit", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1"));
    useQueuedPrompts.getState().enqueue(S1, prompt("p2"));
    useQueuedPrompts.getState().markLeaving(S1, "p1", "deleted");
    // Still in the list — `QueueRows` renders the raw array so the row can play
    // its exit and call `forget`. `takeHead` is what skips it.
    expect(list()?.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(list()?.[0]?.leaving).toBe("deleted");
    expect(useQueuedPrompts.getState().takeHead(S1)?.id).toBe("p2");
  });

  test("releases nothing on its own", () => {
    useQueuedPrompts.getState().enqueue(S1, prompt("p1", { attachments: [attachment("a1")] }));
    useQueuedPrompts.getState().markLeaving(S1, "p1", "deleted");
    expect(revokeCalls()).toEqual([]);
  });

  test("is a NO-OP for an entry that is already leaving (one entry, one exit owner)", () => {
    // The trash is still clickable during a `"sent"` row's ~300 ms exit
    // (`AnimatePresence mode="popLayout"` keeps an exiting row mounted AND
    // hit-testable). Overwriting `"sent"` with `"deleted"` would fly the row
    // right instead of up AND make `forget` release the object URLs the SEND
    // path owns — a double revoke under the sender's feet. And if that flush
    // then fails, `requeueHead` resurrects a row the user just deleted, with a
    // revoked preview.
    useQueuedPrompts.getState().enqueue(
      S1,
      prompt("p1", { leaving: "sent", attachments: [attachment("a1")] }),
    );
    useQueuedPrompts.getState().markLeaving(S1, "p1", "deleted");
    expect(list()?.[0]?.leaving).toBe("sent");
    expect(revokeCalls()).toEqual([]);
  });

  test("is a NO-OP for an entry already leaving as deleted (the exit is not re-triggered)",
    () => {
      // The same rule seen from the other side, and stated for the reason type
      // the API actually accepts (`markLeaving`'s ONLY reason is `"deleted"` —
      // `"sent"` is written by `takeHead`, which is exactly why a row can never
      // be re-armed with a new cause from the UI). A second trash click during
      // the exit changes nothing, so the animation is never restarted and the
      // entry is never handed to a second remover.
      useQueuedPrompts.getState().enqueue(
        S1,
        prompt("p1", { leaving: "deleted", attachments: [attachment("a1")] }),
      );
      useQueuedPrompts.getState().markLeaving(S1, "p1", "deleted");
      expect(list()?.map((p) => p.leaving)).toEqual(["deleted"]);
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

  test("is a NO-OP for an entry that is already leaving (a row animating out is not a control)",
    () => {
      // The row body is the edit affordance and stays hit-testable through the
      // exit, so a click can land on a `"sent"` entry mid-animation. Putting it
      // into `editing` opens an editor whose Save is later destroyed by
      // `forget` — a silently lost edit — and an entry that is `editing` is no
      // longer what the exit was for. One entry, one owner: `leaving` wins.
      useQueuedPrompts.getState().enqueue(S1, prompt("p1", { leaving: "sent" }));
      useQueuedPrompts.getState().setEditing(S1, "p1", true);
      expect(list()?.[0]).toMatchObject({ state: "queued", leaving: "sent" });
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
