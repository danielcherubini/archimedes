---
status: committed
done-when: Selecting an ask question option keeps the Submit button fully visible, the chat area has zero horizontal scrolling with proper string wrapping, and a Space lists all its live and stored sessions in the sidebar.
---

# Chat Window Fixes & Multi-Session per Space Plan

**Goal:** Fix the Ask Question Card so selecting options does not push action buttons out of view, enforce zero horizontal scrolling across the chat transcript with proper wrapping/truncation, and support multiple coexisting live and stored sessions per Space in the sidebar and state model.

**Architecture:** Frontend UI and Zustand store refinement. `AskQuestionCard` gains targeted smooth auto-scrolling on layout expansion via a footer ref. `MessageList` and transcript bubbles gain strict `overflow-x-hidden`, `min-w-0`, and `break-words [overflow-wrap:anywhere]` styling while isolating horizontal scroll to standalone code panels and tables. `SpaceView` and `spaceViewFor` expand from a single `liveSessionId` to `liveSessionIds: string[]` (newest-first), and `SpacesList` renders all live sessions for the active Space at the top of the session list followed by stored sessions.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Zustand, Vitest, Testing Library.

---

### Task 1: Ask Question Card Auto-Scroll on Option Selection & Expansion

**Context:**
In `AskQuestionCard`, selecting an option renders an optional note input field (`<input placeholder="note (optional)" ... />`), which expands the card vertically by ~30–40px. The chat scroll container (`MessageList`) only auto-scrolls on new message tokens or gate counts, so when the card expands, its footer (`Cancel` and `Submit` buttons) is pushed below the scroll view cutoff. By introducing a ref on the card footer and smoothly scrolling it into view on option selection or draft expansion, the actions always remain visible.

**Files:**
- Modify: `src/components/AskQuestionCard.tsx`
- Test: `src/components/AskQuestionCard.test.tsx`

**What to implement:**
1. In `src/components/AskQuestionCard.tsx`:
   - Declare `const footerRef = useRef<HTMLDivElement>(null);` at the top of the component with the existing hooks, *above* `if (!request) return null;` (adhering strictly to Rules of Hooks).
   - Derive a throttled `layoutKey` that changes ONLY when option selections or "Other" toggles change, ignoring text typed in the note inputs:
     ```ts
     const rawQuestions = (request?.params as { questions?: AskQuestionDto[] } | undefined)?.questions ?? [];
     const hasSelection = rawQuestions.some((q) => {
       const d = drafts[q.id];
       return !!d && (d.selected.length > 0 || d.other);
     });
     const layoutKey = `${hasSelection ? 1 : 0}|` + rawQuestions
       .map((q) => {
         const d = drafts[q.id];
         return `${q.id}:${d ? d.selected.join(",") : ""}:${d?.other ? "other" : ""}`;
       })
       .join(";");
     ```
   - Add a `useEffect` that depends solely on `[layoutKey]`:
     ```ts
     useEffect(() => {
       if (!layoutKey.startsWith("1|")) return;
       const rafId = requestAnimationFrame(() => {
         const el = footerRef.current;
         if (el && typeof el.scrollIntoView === "function") {
           el.scrollIntoView({ block: "nearest", behavior: "smooth" });
         }
       });
       return () => cancelAnimationFrame(rafId);
     }, [layoutKey]);
     ```
   - Attach `ref={footerRef}` and `data-testid="ask-footer"` to the footer container:
     `<div ref={footerRef} data-testid="ask-footer" className="mt-3 flex items-center justify-between gap-2 px-3 pb-3">`
2. In `src/components/AskQuestionCard.test.tsx`:
   - Stub `Element.prototype.scrollIntoView = vi.fn()` in `beforeEach`.
   - Add a unit test verifying that selecting an option calls `scrollIntoView({ block: "nearest", behavior: "smooth" })` with the receiver context matching `screen.getByTestId("ask-footer")` using `await waitFor(...)`.
   - Add a unit test verifying that selecting "Other (type your own)" also calls `scrollIntoView`.
   - Add a test verifying that typing into the note input does NOT trigger additional `scrollIntoView` calls (reset mock after option click, fire input change, flush animation frame, assert `expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()`).

**Steps:**
- [ ] In `src/components/AskQuestionCard.test.tsx`, set up `Element.prototype.scrollIntoView = vi.fn()` and write failing tests for auto-scrolling on option selection and "Other" selection
- [ ] Run `pnpm test src/components/AskQuestionCard.test.tsx`
  - Did it fail with expected error (e.g. `scrollIntoView` not called)?
- [ ] Implement `footerRef`, `layoutKey`, and the layout effect in `src/components/AskQuestionCard.tsx` (above early returns)
- [ ] Run `pnpm test src/components/AskQuestionCard.test.tsx`
  - Did all tests in the file pass?
- [ ] Run `pnpm build`
  - Did type-check and bundle succeed?
- [ ] Commit with message: "fix(ui): auto-scroll ask question card footer into view on option selection"

**Acceptance criteria:**
- [ ] Selecting an option or expanding the custom note input calls `scrollIntoView({ block: "nearest", behavior: "smooth" })` targeting `data-testid="ask-footer"`.
- [ ] The Submit and Cancel buttons remain visible without getting pushed below the fold.
- [ ] `scrollIntoView` is guarded against missing implementation in test environments (`typeof el.scrollIntoView === "function"`).
- [ ] No re-scroll occurs on individual keystrokes in the note or other input fields.
- [ ] Existing `AskQuestionCard` keyboard navigation and submission tests pass.

---

### Task 2: Zero Horizontal Scrolling & Text Wrapping Across Chat Window

**Context:**
Unbroken text strings (long URLs, file paths, hashes, base64 data, long commands, inline code) can exceed the chat window's available width. Because flex child wrappers lack `min-w-0` and text containers lack word-breaking rules, the content forces the flex children to expand past the container width, resulting in unwanted horizontal scrolling across the entire transcript container. We need zero horizontal scrolling on the chat transcript while keeping isolated horizontal scrollbars inside standalone `<CodeBlock>` panels and GFM markdown tables.

**Files:**
- Modify: `src/components/chat/MessageList.tsx`
- Modify: `src/components/MessageBubble.tsx`
- Modify: `src/components/ToolCallCard.tsx`
- Modify: `src/components/FileSummaryCard.tsx`
- Modify: `src/components/PermissionPrompt.tsx`
- Modify: `src/components/AskQuestionCard.tsx`
- Test: `src/components/MessageBubble.test.tsx`
- Test: `src/components/MessageBubble.markdown.test.tsx`
- Test: `src/components/chat/MessageList.gap.test.tsx`

**What to implement:**
1. In `src/components/chat/MessageList.tsx`:
   - To the existing classes of `data-testid="transcript-scroll"` (`flex-1 flex flex-col gap-3 overflow-y-auto p-4`), add `overflow-x-hidden min-w-0 max-w-full`.
   - Update `wrap` to add `min-w-0 max-w-full` to both branches:
     ```tsx
     const wrap = (child: ReactNode) => (
       <div
         key={`${activeSessionId}:${i}`}
         className={
           breathes
             ? `flex min-w-0 max-w-full flex-col ${TRANSCRIPT_BREATHING_GAP}`
             : "flex min-w-0 max-w-full flex-col"
         }
       >
         {child}
       </div>
     );
     ```
2. In `src/components/MessageBubble.tsx`:
   - Under `case "user"`: add `break-words [overflow-wrap:anywhere]` to the container: `<div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-ui-base text-foreground">`.
   - In `AgentMarkdown`:
     - Update outer wrapper: ensure `break-words [overflow-wrap:anywhere] min-w-0 max-w-full`.
     - Update inline `code`: `<code className="rounded-md bg-markdown-inline-code/50 mx-0.5 px-1.5 py-0.5 font-mono text-ui-sm break-words [overflow-wrap:anywhere]">{children}</code>`.
3. In `src/components/ToolCallCard.tsx`:
   - On the output `<pre>`: `<pre className="font-mono max-h-80 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-ui-sm">`.
4. In `src/components/FileSummaryCard.tsx`:
   - Ensure the file entry row has `min-w-0`: `<div key={f.path} className="flex h-8 min-w-0 items-center gap-2 px-2">`.
   - Ensure the path `<span>` has `min-w-0 truncate`: `<span className="flex-1 min-w-0 truncate font-mono text-ui-base">{f.path}</span>`.
5. In `src/components/PermissionPrompt.tsx`:
   - Ensure `prompt.toolTitle` has `break-words [overflow-wrap:anywhere]`: `<p className="text-ui-base font-medium break-words [overflow-wrap:anywhere] text-interaction-confirmation-foreground">{prompt.toolTitle}</p>`.
6. In `src/components/AskQuestionCard.tsx`:
   - Add `break-words [overflow-wrap:anywhere]` to the question `<p>`, description `<p>`, option label `<span>` (also add `min-w-0`), "Other" label `<span>`, and review `<li>`.
7. Tests:
   - In `MessageList.gap.test.tsx`: assert that the `transcript-scroll` container includes `overflow-x-hidden` and that wrapper rows include `min-w-0`.
   - In `MessageBubble.test.tsx`: assert that a user message container has `break-words` and `[overflow-wrap:anywhere]`.
   - In `MessageBubble.markdown.test.tsx`: assert that markdown inline code elements include `break-words` and `[overflow-wrap:anywhere]`, and that tables retain `overflow-x-auto`.

**Steps:**
- [ ] Write failing tests in `MessageList.gap.test.tsx`, `MessageBubble.test.tsx`, and `MessageBubble.markdown.test.tsx`
- [ ] Run `pnpm test src/components/MessageBubble.test.tsx src/components/MessageBubble.markdown.test.tsx src/components/chat/MessageList.gap.test.tsx`
  - Did they fail?
- [ ] Apply CSS classes in `MessageList.tsx`, `MessageBubble.tsx`, `ToolCallCard.tsx`, `FileSummaryCard.tsx`, `PermissionPrompt.tsx`, and `AskQuestionCard.tsx`
- [ ] Run `pnpm test src/components/MessageBubble.test.tsx src/components/MessageBubble.markdown.test.tsx src/components/chat/MessageList.gap.test.tsx`
  - Did all tests pass?
- [ ] Run `pnpm build`
  - Did build pass?
- [ ] Commit with message: "fix(ui): enforce zero horizontal scroll and wrap unbroken text across chat transcript"

**Acceptance criteria:**
- [ ] `MessageList` transcript container has `overflow-x-hidden`.
- [ ] User messages, markdown inline code, and tool outputs wrap unbroken text instead of expanding horizontally.
- [ ] FileSummaryCard path row truncates with ellipsis without expanding container width.
- [ ] Isolated horizontal scrolling remains functional inside code block panels (`CodeBlock`) and markdown tables.

---

### Task 3: Support Multiple Live and Stored Sessions per Space in Store and Sidebar

**Context:**
The Rust backend already manages multiple coexisting live Worker sessions. However, `SpaceView` in `src/store/sessions.ts` only exposed a single `liveSessionId: string | null` via `mostRecentLiveInSpace`, and `SpacesList.tsx` only rendered that single `liveSessionId`. Consequently, creating or having multiple live sessions in the same Space hid all previous live sessions from the sidebar, making them impossible to view or switch to. We need `SpaceView` to expose `liveSessionIds: string[]` (ordered newest-first) and `SpacesList` to render all live sessions for the active Space at the top of the session list, followed by stored sessions. (Note: per-row closing of live sessions from the sidebar remains out of scope; live sessions close via tab close confirm or app exit.)

**Files:**
- Modify: `src/store/sessions.ts`
- Modify: `src/components/SpacesList.tsx`
- Test: `src/store/sessions.test.ts`
- Test: `src/components/SpacesList.test.tsx`

**What to implement:**
1. In `src/store/sessions.ts`:
   - Update `SpaceView`:
     ```ts
     export interface SpaceView {
       path: string;
       title: string;
       /** All live sessions in this space, newest-first (most recently started at index 0). */
       liveSessionIds: string[];
       /** The most recent live session in this space, or `null`. */
       liveSessionId: string | null;
       /** Stored sessions of this space, in history order (newest-first). */
       storedSessionIds: string[];
       archivedSessionIds: string[];
       trusted: boolean;
       lastReason: CloseReasonStr | undefined;
     }
     ```
   - In `spaceViewFor`:
     ```ts
     const spaceLive = sessions.filter((s) => s.cwd === space.path);
     // Reverse insertion order so the most-recently started live session is at index 0:
     const liveSessionIds = [...spaceLive].reverse().map((s) => s.sessionId);
     const liveSessionId = liveSessionIds[0] ?? null;
     const newestId = liveSessionId ?? storedSessionIds[0] ?? archivedSessionIds[0];
     return {
       path: space.path,
       title: basenameOfPath(space.path),
       liveSessionIds,
       liveSessionId,
       storedSessionIds,
       archivedSessionIds,
       trusted: space.trusted,
       lastReason: newestId === undefined ? undefined : closeReasons[newestId],
     };
     ```
   - Update comments that mention single live session assumptions.
2. In `src/components/SpacesList.tsx`:
   - In `railIds`:
     ```ts
     const railIds = useMemo(
       () =>
         activeView
           ? [
               ...activeView.liveSessionIds,
               ...activeView.storedSessionIds,
             ]
           : [],
       [activeView],
     );
     ```
   - In the session rows rendering section for `activeView`:
     ```tsx
     {activeView && (
       <div className="flex flex-col gap-0.5">
         {activeView.liveSessionIds.map((id) => (
           <SessionRow
             key={id}
             sessionId={id}
             spaceName={activeView.title !== "" ? activeView.title : activeView.path}
             active={activeSessionId === id}
             onOpen={openSession}
           />
         ))}
         {activeView.storedSessionIds.map((id) => (
           <SessionRow
             key={id}
             sessionId={id}
             spaceName={activeView.title !== "" ? activeView.title : activeView.path}
             active={activeSessionId === id}
             onOpen={openSession}
           />
         ))}
       </div>
     )}
     ```
   - Update comments in `SpacesList.tsx` around lines 359-360 and 518.
3. In `src/store/sessions.test.ts`:
   - Update existing `spaceViewFor` tests around lines 617, 633, 647:
     - Add `liveSessionIds: ["live-alpha"]` to the first test expected object.
     - Add `liveSessionIds: []` to the second and third tests expected objects.
     - In the test for two live sessions in a space (~line 668), assert `expect(view.liveSessionIds).toEqual(["second", "first"])` and `expect(view.liveSessionId).toBe("second")`.
     - Add assertion pinning invariant `expect(view.liveSessionId).toBe(view.liveSessionIds[0] ?? null)`.
4. In `src/components/SpacesList.test.tsx`:
   - Add a test setting up two live sessions in `/tmp/alpha` (`s1` and `s2`) using `useSessions.setState({ sessions: [s1, s2], activeSpacePath: "/tmp/alpha", activeSessionId: "s2" })` with distinct user messages (`s1` user text "Task 1", `s2` user text "Task 2").
   - Assert both "Task 2" and "Task 1" render as session rows, with "Task 2" (newest) rendered above "Task 1", and "Task 1" rendered above stored rows.
   - Assert clicking "Task 1" calls `openSession("s1")` / updates `activeSessionId` to `"s1"`.

**Steps:**
- [ ] Update `src/store/sessions.test.ts` with assertions for `liveSessionIds`
- [ ] Run `pnpm test src/store/sessions.test.ts`
  - Did it fail because `liveSessionIds` is not yet on `SpaceView`?
- [ ] Implement `liveSessionIds` in `src/store/sessions.ts`
- [ ] Run `pnpm test src/store/sessions.test.ts`
  - Did all tests in `sessions.test.ts` pass?
- [ ] Update `src/components/SpacesList.tsx` to render all `activeView.liveSessionIds` and include them in `railIds`
- [ ] Add failing test in `src/components/SpacesList.test.tsx` verifying multiple live sessions render distinctly in the sidebar
- [ ] Run `pnpm test src/components/SpacesList.test.tsx`
  - Did all tests in `SpacesList.test.tsx` pass?
- [ ] Run full test suite: `pnpm test`
- [ ] Run type-check and build: `pnpm build`
- [ ] Commit with message: "feat(sessions): support multiple live sessions per space in state and sidebar"

**Acceptance criteria:**
- [ ] `SpaceView` exposes `liveSessionIds: string[]` containing all live sessions in newest-first order.
- [ ] `liveSessionId` is preserved and matches `liveSessionIds[0] ?? null`.
- [ ] `SpacesList` displays all live sessions for the active Space at the top of the sidebar, followed by stored sessions.
- [ ] Starting a new session in an existing Space keeps all existing live sessions visible, selectable, and running.
- [ ] Clicking any session row in the sidebar switches the active view to that session.
- [ ] Full test suite (`pnpm test`) and type-check (`pnpm build`) pass cleanly.
