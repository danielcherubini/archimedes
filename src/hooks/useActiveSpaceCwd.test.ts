import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useActiveSpaceCwd } from "./useActiveSpaceCwd";
import { useSessions } from "../store/sessions";
import type { SessionInfo } from "../lib/tauri";

const session = (sessionId: string, cwd: string): SessionInfo => ({
  sessionId,
  cwd,
  capabilities: {},
  archived: false,
});

beforeEach(() => {
  useSessions.setState({
    sessions: [],
    historySessions: [],
    archivedSessions: [],
    activeSessionId: null,
    inTurn: {},
    messages: {},
  });
});

/**
 * The active **Space**'s folder is derived in ONE module, and BOTH consumers
 * read it from here: `ChatStream`'s `spacePath` (the `$`/`#`/`@`/`?` picker
 * catalogs) and `App`'s `SpaceCwdProvider` (what every External-open of a
 * relative path resolves against). These tests pin the derivation `ChatStream`
 * used to perform inline — live session first, then stored, and the stored
 * lookup must cover BOTH stored lists.
 */
describe("useActiveSpaceCwd (the one derivation of the Space folder)", () => {
  const of = () => renderHook(() => useActiveSpaceCwd()).result.current;

  it("a live active session → its cwd", () => {
    useSessions.setState({
      sessions: [session("s1", "/home/u/proj")],
      activeSessionId: "s1",
    });
    expect(of()).toBe("/home/u/proj");
  });

  it("the live session WINS over a stored row for the same id (and its cwd, not the stored one)", () => {
    // A resume can move a session between Spaces; the live row is the truth.
    useSessions.setState({
      sessions: [session("s1", "/live")],
      historySessions: [session("s1", "/stored")],
      activeSessionId: "s1",
    });
    expect(of()).toBe("/live");
  });

  it("a stored (non-live) active session → its cwd from `historySessions`", () => {
    useSessions.setState({
      historySessions: [session("s1", "/home/u/stored")],
      activeSessionId: "s1",
    });
    expect(of()).toBe("/home/u/stored");
  });

  it("a session living ONLY in `archivedSessions` still resolves", () => {
    // The half that is easy to miss: an archived session opened from the
    // Archived section is not in `historySessions`, so a `historySessions`-only
    // lookup would resolve `null` — and every relative path in its transcript
    // would then be unopenable (`external_open` refuses without a cwd).
    useSessions.setState({
      historySessions: [],
      archivedSessions: [session("s1", "/home/u/archived")],
      activeSessionId: "s1",
    });
    expect(of()).toBe("/home/u/archived");
  });

  it("no active session → null", () => {
    useSessions.setState({ sessions: [session("s1", "/home/u/proj")] });
    expect(of()).toBeNull();
  });

  it("an active session id in no list at all → null", () => {
    useSessions.setState({
      sessions: [session("other", "/home/u/proj")],
      activeSessionId: "s1",
    });
    expect(of()).toBeNull();
  });

  it("is a `string | null`, stable across a re-render (never a fresh object)", () => {
    // Selectors must return stable references or Zustand re-renders forever
    // (`ChatStream.tsx` states the rule; breaking it hangs the whole suite).
    useSessions.setState({
      sessions: [session("s1", "/home/u/proj")],
      activeSessionId: "s1",
    });
    const { result, rerender } = renderHook(() => useActiveSpaceCwd());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(typeof result.current).toBe("string");
  });
});
