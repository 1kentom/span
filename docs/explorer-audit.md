# Explorer and drag and drop audit

"Before" was judged by reading the source at origin/main 030b667, not by running it. "After" names the evidence.
Browser preview cannot run file mutations (the backend commands are desktop only), so create, rename, move and paste
are verified at the state and component level with a fake workbench, not end to end against the disk.
The native app and Finder drops were not exercised.

| Behaviour | Before | After | Evidence |
| --- | --- | --- | --- |
| Cmd/Ctrl+N creates a file, Cmd/Ctrl+Shift+N a folder (rebindable) | FAIL | PASS (row shown) | e2e `explorer-drop-zones`, Rust settings tests |
| Inline name row, validation, Escape cancels | FAIL (modal dialog) | PASS | e2e, `Explorer.test.tsx`, `explorer-ops.test.ts` |
| `a/b/c.ts` creates intermediate folders | FAIL | UNVERIFIED on disk | code in `explorer-state.ts`, validation tested |
| New from template popup (Alt+Insert) | FAIL | PASS (popup, filter); templates create empty files | e2e |
| Rename inline, F2 / Enter on macOS, stem selected | FAIL (modal) | PASS (selection rule); commit UNVERIFIED on disk | `Explorer.test.tsx` |
| Delete / Cmd+Backspace with confirm | PARTIAL (modal, menu only) | UNVERIFIED (needs desktop) | code only |
| Cut, copy, paste, duplicate with "copy" names | PARTIAL (dialog based) | name logic PASS; operations UNVERIFIED on disk | `explorer-ops.test.ts` |
| Multi select (Cmd click, Shift click, Shift arrows) | FAIL | PASS (arrows, range, escape); click paths UNVERIFIED | `Explorer.test.tsx` |
| Arrow, Home, End, Left/Right, type to jump | PARTIAL | PASS (arrows, Escape); others code only | `Explorer.test.tsx` |
| Collapse all, refresh buttons | FAIL | added, not exercised | code only |
| Auto reveal of the active file | FAIL | added (browser-local preference), not exercised | code only |
| Undo (Cmd+Z) of the last file operation | FAIL | UNVERIFIED on disk | code only |
| Context menu order and shortcut hints | PARTIAL | follows the design; not asserted by a test | code only |
| Drag a file or folder onto a folder moves it | FAIL | highlight, pill, 700 ms expand PASS; the move itself UNVERIFIED on disk | e2e |
| Conflict dialog Cancel / Keep Both / Replace | FAIL | UNVERIFIED (dialog code only) | code only |
| Escape cancels an Explorer drag | PASS | PASS | e2e |
| Drop zones left, right, top, bottom, centre | FAIL (centre only) | PASS, dark and light | e2e, `drop-zones.test.ts` |
| Drag a file to open at the bottom or side | FAIL | PASS | e2e |
| Tab dragged to an edge splits | FAIL | PASS | e2e, `workbench.test.ts` |
| Stacked (vertical) layout with divider | FAIL | PASS | e2e, store tests |
| Stacked layout saved in the session | FAIL | PASS | store tests, `cargo test -p span-core --test preferences` |
| Split Down action (Mod+Alt+\\) | FAIL | action defined; handler wired; context menu items added | store tests |
| Drop on the terminal panel | FAIL | PASS (no zone, not-allowed cursor) | e2e |
| Finder file drop opens only that file | FAIL (opened the parent as the project) | PASS in logic; native drop UNVERIFIED | Rust `startup.rs` tests, `startup-plan.test.ts` |
| Files outside the open project ask first | FAIL | PASS in logic; dialog not exercised | `startup-plan.test.ts` |
| Issue 69 hidden files, `explorer.exclude` | not started | not done | |
| Issue 70 external modification handling | not started | not done | |

Known gaps: the light theme screenshots switch the app class at runtime, so the editor syntax colours stay dark.
