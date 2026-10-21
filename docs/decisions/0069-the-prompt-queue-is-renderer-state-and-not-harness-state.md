---
status: accepted
date: 2026-10-21
superseded-by:
---

# The Prompt queue is renderer state, and not harness state

A **Queued prompt** — text the user sends while its **Session**'s turn is in flight — lives in the renderer (`src/store/queuedPrompts.ts`) and nowhere else. The **Supervisor** is never told a queue exists: `send_prompt_with_images`'s atomic `pending_turn` claim keeps refusing a second prompt mid-turn, and the queue's **Flush** turns a queue head into an ordinary `send_prompt` only at its own turn. **Why:** the queue exists to let a person keep typing during inference, which is a property of the composer, not of the conversation — and every queue operation the feature needs (edit in place, delete, reorder-before-send) is a trivial mutation of a renderer list and a new IPC command + a new race per command if the same list lived behind the wire. The Supervisor's one-turn-at-a-time invariant is the load-bearing rule of the whole Worker protocol (ADR 0025), and this feature leaves it exactly as it found it.

**Considered Options**

- **Supervisor-owned queue** (relax the `pending_turn` claim and let a mid-turn prompt ride `AgentLoop`'s existing `prompt_queue`): rejected — it is the option a reader of `loop.rs:361` will assume is already built, which is the trap. That queue is unreachable from the user path precisely because the Supervisor refuses the prompt before it is written, and `cancel_turn` DRAINS it (a Stop is specified to discard it, `loop.rs:516`). Reusing it would mean every edit/delete becomes a protocol round trip, every queue entry holds a live `pending_turn` resolver, and Stop's drain rule has to be re-litigated against a user who wants their queued prompts kept.
- **Both, mirrored** (renderer list for the UI, Supervisor copy for durability): rejected — two owners of one ordered list across a process boundary is the class of bug ADR 0050 exists to settle, for a durability benefit nobody asked for.

**Consequences**

- **A reload or an app quit loses the queue.** Accepted: it is the same lifetime the composer draft already has.
- **`closeSession` clears the Session's queue**, for the same reason `closeSession` clears `stalled` and `compacting` — a reopened **Session** must not offer a **Flush** whose turn can never arrive. Closing a tab therefore discards queued prompts; closing a tab already confirms when the **Session** is live.
- **The name collides on purpose with `AgentLoop`'s `prompt_queue`, so the glossary names both.** The user-facing list is the **Prompt queue**; the Rust one is the **Harness prompt queue**, and its `drain` is the opposite act of our **Flush** — it discards.
- **A Stop does not Flush and does not clear the queue**, but the resulting `turnCompleted("cancelled")` does land on the settle edge that triggers the **Flush**. So Stop means "stop this answer", and the next queued prompt then starts its turn — which is the chosen reading of "stop this, not my whole plan", and the reason the trigger is the settle edge and not the Stop itself.
- **The queue is absent from `sessionStatusOf`** (ADR 0038/0040's one status rule): a non-empty queue means the user has more to say, never that the **Agent** is parked on the user, so it must not feed a **Session status** pill or an **Attention alert**.
- **A queued prompt holds the RAW draft; `expandMentions` runs at send.** So an edit made after queueing can retarget a `$name` **Mention** and still expand correctly at its turn, and the bubble shows the token the user typed rather than a skill body. It also preserves ADR 0031's byte-identity contract by construction — the text that goes on the wire is produced by the same call that always produced it.
