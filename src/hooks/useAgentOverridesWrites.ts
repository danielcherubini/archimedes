import { useCallback, useRef, useState } from "react";

import {
  getSettings,
  saveSettings,
  type AgentOverrides,
  type AppSettings,
} from "../lib/tauri";
import { clearAgentCatalogCache } from "./useAgentCatalog";
import { useSettings } from "../store/settings";

/**
 * The SECOND owner of the settings document (finding 13a — the one the audit
 * missed: it filed only `SettingsPage`). The sidebar **Agents** modal edits
 * `agentOverrides`, and this chain — the code `SpacesList.tsx` used to hold inline
 * at `:333`, `:354`, `:596`, `:607` plus its own epoch/rollback logic — is that
 * modal's one write path. `SpacesList.tsx` now calls this hook.
 *
 * WHY IT IS A SECOND HOOK AND NOT A FLAG ON `useSettingsDocument`. The two owners
 * hold genuinely opposite contracts over the same document:
 *
 * |                          | `useSettingsDocument`     | this hook                  |
 * |--------------------------|--------------------------|----------------------------|
 * | composes from            | the store                | a fresh `getSettings` read |
 * | writes                   | the whole document       | the whole document, ONE    |
 * |                          |                          | field replaced wholesale   |
 * | re-reads after the write | never                    | on failure (the rollback)  |
 * | orders concurrent writes | not at all               | a serialized queue         |
 * | guards the store mirror  | not at all               | a publish epoch, at COMMIT |
 * | reports failure          | swallows into the save   | logs + rolls back + counts |
 *
 * A single hook serving both would be a union of two contracts that neither owner
 * satisfies — the shape this program's C1 lesson warns about (a hook that owns one
 * thing and is honest about its return shape beats a proxy for everything). What IS
 * now shared is the thing that was actually duplicated: both owners load/read
 * through `useSettings` rather than a private copy, and neither writes the store
 * with a bare `getState().setSettings` from a component body.
 *
 * The five properties above are each pinned in
 * `src/hooks/useAgentOverridesWrites.test.ts`, and the modal-level proof is
 * `SpacesList.test.tsx`: its 233 write-chain assertions ran unmodified across the
 * migration, and two characterisation pins were ADDED at the end of its Agents
 * block (`a rolled-back write moves the counter the dialog's suppression is
 * stamped against`, `holds the Agents dialog back while there is no settings
 * document, and keeps the button clickable`) for the two facts none of the 233
 * read. A loss in either direction shows.
 */
export interface UseAgentOverridesWrites {
  /**
   * The document, from the store. The modal's render gate needs it: with no
   * settings document there is nothing correct to edit, so the Agents button
   * stays clickable and the dialog simply waits.
   */
  settings: AppSettings | null;
  /**
   * How many of this owner's writes FAILED and rolled the store back. A counter,
   * not a boolean, so a second failure still reads as a change to the modal. The
   * dialog uses it as `rolledBackWrites`: the mount owns the save, and the dialog
   * owns the `edited` suppression that a rollback invalidates.
   */
  rolledBackWrites: number;
  /**
   * The ONE write path for `agentOverrides` (ADR 0066's store). Replaces the map
   * wholesale — never a field-level merge: the map carries no intent, so an absent
   * field is BOTH "the user just cleared it" and "nobody ever set it", and merging
   * would resurrect a field the user just unticked (ADR 0067 — absence is the only
   * meaning of "does not speak").
   *
   * Never rejects. The call site `void`s the result and the mount has nowhere to
   * attach a handler, so a rejection here is an unhandled rejection in the webview.
   */
  patchAgentOverrides: (next: AgentOverrides) => Promise<void>;
}

export function useAgentOverridesWrites(): UseAgentOverridesWrites {
  const settings = useSettings((s) => s.settings);
  const [rolledBackWrites, setRolledBackWrites] = useState(0);
  const noteRolledBack = useCallback(
    () => setRolledBackWrites((n) => n + 1),
    [],
  );
  // The write queue. Saves run one after another so "the last write wins" means the
  // LAST map the user produced and not whichever `saveSettings` resolved first.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  // How many optimistic publishes this owner has made. A write link captures the
  // value at its own publish and compares on completion (see `writeAgentOverrides`).
  const publishEpochRef = useRef(0);

  const patchAgentOverrides = useCallback(
    (next: AgentOverrides): Promise<void> => {
      const current = useSettings.getState().settings;
      // Publish first (before the awaits), so the dialog's next render — and thus
      // its next edit — sees this one. The epoch moves WITH the publish attempt: one
      // count per patch the user COMMITS, whether or not it reaches the store mirror
      // (the `current === null` guard below can skip the publish, and it still counts
      // — the guard makes that unreachable from this render site, but the count is
      // deliberately not tied to the mirror). That is exactly what a completing link
      // has to compare against to know whether it is still the newest answer.
      publishEpochRef.current += 1;
      const epoch = publishEpochRef.current;
      if (current !== null) {
        useSettings.getState().setSettings({ ...current, agentOverrides: next });
      }
      // SWALLOW STRUCTURALLY, at both ends of the link, because the two halves do
      // different work:
      // - the LEADING `.catch` turns a rejected held promise back into a resolved one
      //   before the `.then`, so a poisoned link can never make the NEXT write skip
      //   (a bare trailing swallow would swallow the error and still skip the write);
      // - the TRAILING `.catch` is the LOAD-BEARING half: the rejected link is what
      //   the call site `void`s, and the mount has nowhere to attach a handler, so
      //   without it a poisoned save is an unhandled rejection in the webview (this
      //   is exactly what the suite reported before it was added). It also covers the
      //   NEXT link, because the promise stored in the ref is the swallowed one.
      // The leading `.catch` is therefore not what saves the next write today — it is
      // here so the invariant does not depend on remembering the trailing half: the
      // held promise stays clean whatever order the two links are written in.
      // Neither half relies on the helper's error HANDLER being infallible, which is
      // the point: a `console.error` that throws, or a store that throws while
      // mirroring, used to leave the held promise rejected and silently disable every
      // later write while the modal kept looking like it saved.
      writeChainRef.current = writeChainRef.current
        .catch(() => {})
        .then(() =>
          writeAgentOverrides(next, epoch, publishEpochRef, noteRolledBack),
        )
        .catch(() => {});
      return writeChainRef.current;
    },
    [noteRolledBack],
  );

  return { settings, rolledBackWrites, patchAgentOverrides };
}

/**
 * The ONE write path's doc-comment, moved here with the code (see
 * `useAgentOverridesWrites` for the contract summary, and
 * `useAgentOverridesWrites.test.ts` for the pinned ordering).
 *
 * A READ-MODIFY-WRITE, never composed from the store. The re-read is load-bearing,
 * not paranoia: the store's copy is seeded at boot and by the Settings page, but
 * the Rust side writes `settings.json` on its own — `agent/session/mod.rs:1678`
 * persists a remembered thinking level through `load_settings` + mutate +
 * `write_settings` — so a modal opened at an arbitrary moment can be holding a
 * stale document, and composing from the store would silently clobber a concurrent
 * change. EVERY Rust writer does load-mutate-write; this has to match or the
 * desktop becomes the one writer that can lose someone else's field.
 *
 * THE ONE EXCEPTION to "this modal is the only writer of the map", and it is a real
 * one: `SettingsPage`'s Provider-rename handler is a SECOND writer (it walks the
 * map remapping each entry's `.model` when a Provider is renamed — ADR 0066 records
 * it). A rename landing concurrently with a modal write can be clobbered: the
 * modal's whole-map replace writes back the pre-rename refs, so the remapped refs
 * revert and the overrides re-orphan. Accepted as a narrow window because opening
 * Settings UNMOUNTS the pane that owns this hook — and with it the modal and its
 * queue — so the two writers cannot be live in the same screen; the epoch guards
 * THIS owner's links and does NOT reach that writer. (The follow-up idea, not taken
 * here: route the rename remap through this hook, which would need the queue lifted
 * above both lifecycles.)
 */
async function writeAgentOverrides(
  next: AgentOverrides,
  epoch: number,
  epochRef: { current: number },
  onRolledBack: () => void,
): Promise<void> {
  // A newer optimistic publish has mirrored a NEWER map into the store since this
  // link published, so this link's snapshot is the older answer.
  const isStale = () => epochRef.current !== epoch;
  let freshDocument: AppSettings;
  try {
    const fresh = await getSettings();
    freshDocument = { ...fresh, agentOverrides: next };
    await saveSettings(freshDocument);
  } catch (err) {
    // The ONLY thing this catch covers is the save. Publishing to the store lives
    // below it on purpose: a `setSettings` that throws while sitting in this try
    // would be logged as "Failed to save" for a save that LANDED.
    console.error("Failed to save agent overrides:", err);
    // Roll the optimistic publish back — but decide THAT at COMMIT, not here.
    // The rollback IS a publish, and its own `getSettings` round trip is the part
    // that can outlive a start-time check: a newer edit may publish while this read
    // is in flight. So the read runs unconditionally and `isStale()` is asked again
    // when the answer arrives. A still-fresh link's re-seed IS the rollback; a
    // stale link's re-seed is DISCARDED entirely, because newer optimistic state
    // owns the store now — publishing the file's OLDER map into it would leave the
    // store permanently behind the file (nothing later republishes over it), and the
    // next `patch` composes from that stale mirror and DELETES fields the file still
    // holds: the drop-a-write class this chain exists to prevent.
    //
    // `loadSettings()` is not used here because it publishes inside itself — the
    // same fetch with no commit-time check available to the caller. The store's own
    // `loadSettings` is live for the OTHER owner (`useSettingsDocument` adopted it);
    // this rollback deliberately cannot.
    //
    // DETACHED (`void`ed, never awaited by the link): the chain must keep moving
    // while a hung `get_settings` is outstanding — a failure arm that awaits would
    // strand every later write, which is the very poisoning the swallow exists to
    // prevent. The inner `catch` keeps this detached promise settled for the same
    // reason (an error handler that can throw is how the poisoning came back).
    void (async () => {
      try {
        const reseeded = await getSettings();
        if (isStale()) return;
        // Reported at COMMIT, next to the publish it describes: for a stale link
        // NOTHING was rolled back — the newer link's own write is what the file
        // holds — so the modal's suppression must survive.
        onRolledBack();
        useSettings.getState().setSettings(reseeded);
      } catch {
        // The re-seed itself failed: the store keeps the last optimistic value, and
        // no second log — the failure above is the save's, and stays the honest one.
      }
    })();
    return;
  }
  // The save LANDED, so the catalog the modal's `runs` columns came from is
  // resolved against a map that no longer exists — evict it.
  // Ahead of the store publish and OUTSIDE its outcome on purpose: eviction answers
  // "the file changed", which stays true even if mirroring the store is what fails.
  // The next fetch goes back to Rust instead of serving the settled promise this
  // edit invalidated. Clearing the WHOLE cache (not just this Space's key) is the
  // honest scope — the override map is global, so an edit changes the answer for
  // every Space's rows, not just the one on screen.
  clearAgentCatalogCache();
  // The store mirror is the ONLY thing the epoch guards. The chain's file writes
  // were already correctly ordered by the queue; this is the one step that could
  // still publish an older snapshot into a store a newer edit has moved on from.
  if (isStale()) return;
  useSettings.getState().setSettings(freshDocument);
}
