import { useCallback, useEffect, useRef } from "react";

import { applySettingsToDocument } from "../lib/settings";
import { saveSettings } from "../lib/tauri";
import { useSettings } from "../store/settings";
import type { AppSettings } from "../lib/tauri";

/**
 * The ONE owner of the settings document for a component that holds and edits it
 * (finding 13a).
 *
 * WHY THIS EXISTS. `SettingsPage` kept a second copy of the document in
 * `useState<AppSettings | null>`, hand-rolled its own `getSettings()` on mount,
 * and then wrote the SAME document into `useSettings` imperatively at two places
 * — so inside one screen there were two owners of one document and only the page
 * knew which was authoritative, while every other consumer (`ChatStream`,
 * `MessageBubble`, `SessionConfigSelect`, `SpacesList`) read the store
 * reactively. This hook removes the second copy: the store owns the document, the
 * page reads it like everyone else, and the write seam (`compose → publish →
 * save → re-theme`) exists once.
 *
 * THE OTHER OWNER, surveyed before designing this (the audit named only
 * `SettingsPage`). `SpacesList.tsx` read the document and wrote it at four places
 * — but those writes are NOT this shape. They are
 * a READ-MODIFY-WRITE of ONE field (`agentOverrides`) against the FILE, because
 * Rust writes `settings.json` on its own, so composing from the store would
 * clobber a concurrent change; and they carry an optimistic publish, a serialized
 * write queue, a publish EPOCH, and a rollback-on-failure that re-seeds the store
 * from the file. This hook does the opposite of every one of those properties: it
 * composes from the store, writes the whole document, never re-reads, and has no
 * rollback. One hook cannot serve both without becoming a union of two contracts,
 * so the Agents modal's chain lives in `useAgentOverridesWrites` (its own file,
 * its own tests). Two hooks over two genuinely different write contracts, rather
 * than one hook over a shape neither owner has.
 *
 * WHAT THE HOOK DOES **NOT** OWN, deliberately:
 *  - The page's catalog fetches (`listModels`, `listTools`, `listKnownProviders`,
 *    `getAppInfo`, `shellSandboxAvailable`). They are per-section picker data, not
 *    the document; folding them in would produce a hook returning eight fields.
 *    That is a judgement about shape, not a cited rule: `useMentionCatalogs.ts`
 *    returns four and stays testable with `renderHook`, and eight inputs plus
 *    eight outputs starts to look like the prop list it was meant to replace.
 *  - The section nav, the MCP dialog draft, the picker selection. Component state.
 *  - `applySettingsToDocument` on LOAD. The boot path (`lib/settings.ts
 *    loadAndApplySettings`) already applied the loaded document to `<html>`; the
 *    page only re-applies on an EDIT, which is what `patch` does.
 */
export interface UseSettingsDocument {
  /** The document, straight from the store (`null` until the load lands). */
  settings: AppSettings | null;
  /**
   * The immediate-save pattern: compose `patch` over the document, publish the
   * result to the store, save the COMPLETE document, and re-apply theme + font to
   * the document element. A no-op while the document is `null` (there is nothing
   * complete to save). Never rejects — `saveSettings`' rejection is not observed
   * by any caller today, and adding a rejection would turn every `patch` call
   * into an unhandled rejection in the webview.
   */
  patch: (patch: Partial<AppSettings>) => void;
}

export function useSettingsDocument(): UseSettingsDocument {
  // The store IS the state. No local mirror, so the page and the working-indicator
  // spinner style cannot disagree about what the document says.
  const settings = useSettings((s) => s.settings);

  // The theme cleanup, REPLACED on each apply — discarding it would leak a
  // `matchMedia` listener per control change, because `applySettingsTheme`
  // subscribes one for a `"system"` theme.
  const themeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // The store's OWN loader, adopted rather than re-implemented (finding 17's
    // drift: `loadSettings` had zero production callers while both previous owners
    // hand-rolled the same fetch). It fetches, publishes, marks `loaded`, and
    // swallows + logs a failure — so a hung or failed `get_settings` leaves the
    // boot-seeded document standing instead of blanking the page.
    //
    // Re-fetched on EVERY mount, which is what both owners did: the boot seed is
    // not the freshest answer (Rust writes `settings.json` itself), and the page
    // must show what the file holds.
    void useSettings.getState().loadSettings();
    return () => {
      themeCleanupRef.current?.();
    };
  }, []);

  const patch = useCallback(
    (changes: Partial<AppSettings>): void => {
      // Reads the RENDERED `settings`, exactly as `update()` did — so two patches
      // delivered inside one batch both compose from the SAME document and the
      // second save drops the first. A `getState()` read would be strictly better
      // and is a BEHAVIOUR CHANGE, so it stays a decision for its own commit; the
      // pair is pinned in `useSettingsDocument.test.ts`.
      if (settings === null) return;
      const next = { ...settings, ...changes };
      // The app-wide store (the working indicator reads `spinnerStyle` from it —
      // a settings change must take effect without a reload).
      useSettings.getState().setSettings(next);
      void saveSettings(next); // the complete document
      themeCleanupRef.current?.(); // drop the previous theme listener
      themeCleanupRef.current = applySettingsToDocument(next); // live theme/font
    },
    [settings],
  );

  return { settings, patch };
}
