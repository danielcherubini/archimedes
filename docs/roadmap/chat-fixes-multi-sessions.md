---
status: approved
done-when: Selecting an ask question option keeps the Submit button fully visible, the chat area has zero horizontal scrolling with proper string wrapping, and a Space lists all its live and stored sessions in the sidebar.
---

# Chat Window Fixes & Multi-Session per Space Spec

This specification addresses three cohesive UX and functional improvements:
1. Ensuring the **Ask Question Card** footer (`Cancel` and `Submit` buttons) is never pushed below the visible scroll area when options or notes expand.
2. Enforcing zero horizontal scrolling across the chat window by wrapping or truncating long strings, while preserving isolated horizontal scrolling inside code blocks and tables.
3. Enabling multiple live sessions to coexist and be listed/switched within a single Space.

---

## 1. Ask Question Card Scroll & Visibility

### Problem
In `AskQuestionCard`, selecting an option mounts the optional note input field (`note (optional)`), expanding the card's vertical height by ~30–40px. Because the parent scroll container (`MessageList`) only auto-scrolls on new message tokens or gate counts, the expanded card footer containing `Cancel` and `Submit` is pushed below the scroll view cutoff.

### Design
1. **Footer Ref & Scroll Target**:
   - Add a ref (`footerRef = useRef<HTMLDivElement>(null)`) attached to the card's footer action container (`Cancel` and `Submit` buttons).
2. **Auto-Scroll on Option Selection / Expansion**:
   - When an option is selected, toggled, or "Other" is expanded, run an effect after DOM layout (`requestAnimationFrame`) calling:
     ```ts
     footerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
     ```
   - This smoothly pulls the bottom of the card and its action buttons into view if they were pushed below the container's bottom edge.
3. **Resize Observer**:
   - Add a `ResizeObserver` on `cardRef` to ensure that any dynamic expansion of the card (e.g. typing multi-line notes or toggling other) keeps the footer visible if the user is already at the bottom of the transcript.

---

## 2. Zero Horizontal Scrolling & String Wrapping

### Problem
Unbroken strings (e.g. long URLs, file paths, base64 strings, long bash commands, inline code) can exceed the chat window's available width. Because transcript wrappers lack `min-w-0` and text elements lack word-breaking rules, the content forces the flex children to expand past the container width, resulting in unwanted horizontal scrolling on the entire transcript container.

### Design
1. **Container Overflow Clamping**:
   - In `MessageList.tsx`, update the scroll container to explicitly enforce `overflow-x-hidden overflow-y-auto` so the transcript area itself can never scroll horizontally.
   - On the message `wrap` container in `MessageList.tsx`, add `min-w-0 max-w-full` to prevent flex items from calculating `min-width: auto` based on wide content.
2. **User Message Bubble**:
   - In `MessageBubble.tsx` (`case "user"`), add `break-words [overflow-wrap:anywhere]` to ensure long unbroken strings wrap onto new lines rather than stretching the container.
3. **Agent Markdown & Inline Code**:
   - In `AgentMarkdown` (`MessageBubble.tsx`), update the inline `code` component with `break-words [overflow-wrap:anywhere]` so inline code tokens wrap at container boundaries.
   - Ensure the outer markdown wrapper keeps `break-words [overflow-wrap:anywhere] max-w-full min-w-0`.
4. **Tool Call Cards & Headers**:
   - In `ToolCallCard.tsx`: add `min-w-0 break-words [overflow-wrap:anywhere]` to raw output `<pre>` blocks.
   - In `FileSummaryCard.tsx`: ensure the flex row has `min-w-0` and the file path `<span>` has `min-w-0 truncate` so paths never overflow the card.
   - In `PermissionPrompt.tsx`: add `break-words [overflow-wrap:anywhere]` to `prompt.toolTitle`.
   - In `AskQuestionCard.tsx`: add `break-words [overflow-wrap:anywhere]` to question titles, descriptions, and option labels.
5. **Preserving Isolated Code Block Scrolling**:
   - Maintain `overflow-x-auto` strictly inside standalone fenced `<CodeBlock>` panels and Markdown GFM `<table>` containers, while the outer chat column stays completely locked at 0 horizontal scroll.

---

## 3. Multiple Live and Stored Sessions per Space

### Problem
The Rust backend already supports multiple live sessions coexisting, and `useSessions.sessions` tracks all live sessions. However, `SpaceView` in `src/store/sessions.ts` only exposed a single `liveSessionId: string | null` (the most recent one), and `SpacesList.tsx` only rendered that single `liveSessionId`. Consequently, starting or having a second live session in the same Space caused older live sessions in that Space to become invisible in the sidebar and inaccessible.

### Design
1. **Store Data Model (`src/store/sessions.ts`)**:
   - Update `SpaceView`:
     ```ts
     export interface SpaceView {
       path: string;
       title: string;
       /** All live sessions in this space, newest-first (most recently started at index 0). */
       liveSessionIds: string[];
       /** The most recent live session (backward compatibility). */
       liveSessionId: string | null;
       /** Stored sessions of this space, in history order (newest-first). */
       storedSessionIds: string[];
       archivedSessionIds: string[];
       trusted: boolean;
       lastReason: CloseReasonStr | undefined;
     }
     ```
   - In `spaceViewFor(...)`:
     ```ts
     const spaceLiveSessions = sessions.filter((s) => s.cwd === space.path);
     // reverse insertion order so newest started is first:
     const liveSessionIds = [...spaceLiveSessions].reverse().map((s) => s.sessionId);
     const liveSessionId = liveSessionIds[0] ?? null;
     ```
   - `newestId` remains `liveSessionIds[0] ?? storedSessionIds[0] ?? archivedSessionIds[0]`.
2. **Sidebar Rendering (`src/components/SpacesList.tsx`)**:
   - Render each session in `activeView.liveSessionIds` via `SessionRow` (live sessions grouped at the top, newest first), followed by `activeView.storedSessionIds` (newest first).
   - Update `railIds` memo to include all `activeView.liveSessionIds` + `storedSessionIds`.
3. **Session Switching & Resuming**:
   - Clicking any session row in the sidebar calls `openSession(id)`: it switches `activeSessionId` to that session, updates `activeSpacePath`, and displays the session's conversation.
   - Live sessions immediately connect to their existing Worker processes. Stored sessions auto-resume upon sending a prompt.
   - Multiple live sessions in the same space can now coexist, run concurrently, and be switched between at will.

---

## 4. Testing & Verification Strategy

### Frontend Unit Tests (`pnpm test`):
1. **Ask Question Card Scroll (`AskQuestionCard.test.tsx`)**:
   - Verify selecting an option triggers `scrollIntoView` on the footer container.
   - Verify expanding "Other" or note inputs also ensures footer visibility.
2. **Zero Horizontal Scroll & Wrapping (`MessageBubble.test.tsx`, `ToolCallCard.test.tsx`, `FileSummaryCard.test.tsx`)**:
   - Verify long unbroken text in user messages and markdown inline code contains `break-words [overflow-wrap:anywhere]`.
   - Verify `MessageList` enforces `overflow-x-hidden`.
   - Verify `FileSummaryCard` truncates long paths without breaking layout.
3. **Multiple Sessions per Space (`sessions.test.ts`, `SpacesList.test.tsx`)**:
   - Verify `spaceViewFor` populates `liveSessionIds` with all live sessions for the Space in newest-first order.
   - Verify `SpacesList` renders all live sessions under the active Space header at the top, followed by stored sessions.
   - Verify `railIds` includes all live session IDs.

### Full Validation Pipeline:
- `pnpm test`
- `pnpm build`
- `cargo test` (`src-tauri/`)
- `cargo clippy --all-targets` (`src-tauri/`, 0 warnings)
- `cargo fmt --check` (`src-tauri/`)
