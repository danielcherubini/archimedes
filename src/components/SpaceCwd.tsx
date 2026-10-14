import { createContext, useContext } from "react";
import type { ReactElement, ReactNode } from "react";

const SpaceCwdContext = createContext<string | null>(null);

/** The active Session's `cwd` (= its **Space**'s folder) for everything that
 * External-opens a relative path.
 *
 * It is a provider rather than a prop because the three surfaces that open
 * things (prose anchors, linkified tool output, settled thinking) each need
 * it, and none of them should thread it through the six components in between.
 * `useSpaceCwd` deliberately returns `null` rather than throwing when no
 * provider is mounted: a surface outside the provider then resolves NO
 * relative path, and `external_open` refuses it — the safe direction, and it
 * keeps every component renderable in isolation. */
export function SpaceCwdProvider({
  cwd,
  children,
}: {
  cwd: string | null;
  children: ReactNode;
}): ReactElement {
  return (
    <SpaceCwdContext.Provider value={cwd}>{children}</SpaceCwdContext.Provider>
  );
}

/** The cwd to resolve a relative path against, or `null` when there is no
 * active **Space** (and so no relative path may be opened). */
export function useSpaceCwd(): string | null {
  return useContext(SpaceCwdContext);
}
