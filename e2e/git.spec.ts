import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Explicit IPC fixture: these browser tests never execute Git or change a repository.
const schema = JSON.parse(readFileSync("crates/core/settings.schema.json", "utf8")).properties;
const defaults = Object.fromEntries(Object.entries(schema as Record<string, { default?: unknown }>).filter(([key, value]) => !key.includes(".") && key !== "$schema" && "default" in value).map(([key, value]) => [key, value.default]));

async function fixture(page: Page, clean = false) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ settings, clean }) => {
    let callback = 0;
    let revision = 1;
    let enabled = false;
    const root = "/fixture/repository/project";
    const repo = { id: "git-fixture-session", root: "/fixture/repository", workspacePrefix: "project", branch: "feature/review", head: "b".repeat(40), detached: false, unborn: false };
    const trace = { baseline: [] as any[], blame: [] as any[], checkout: [] as any[], stashes: [] as any[], tags: [] as any[], worktrees: [] as any[], remotes: [] as any[], hunk: [] as any[], integration: [] as any[], enables: 0, statusReads: 0, stage: [] as any[], unstage: [] as any[], commits: [] as any[], diffs: [] as any[], history: [] as any[], diskSaves: 0, remoteConfigChanged: false };
    const text = "const value = 3;\nconst stable = true;\nconst other = 4;\nconst tail = true;\n";
    const indexText = "const value = 2;\nconst stable = true;\nconst other = 3;\nconst tail = true;\n";
    let operation: string | null = null;
    const stashes: { id: string; selector: string; subject: string }[] = [];
    const tags = [{ name: "v0.1.0", objectId: "d".repeat(40), targetId: repo.head, annotated: false }];
    const worktrees = [
      { path: repo.root, branch: repo.branch, head: repo.head, bare: false, locked: false, prunable: false },
      { path: "/fixture/review", branch: "feature/other", head: repo.head, bare: false, locked: false, prunable: false },
      { path: "/fixture/locked", branch: "feature/locked", head: repo.head, bare: false, locked: true, prunable: false },
    ];
    const buffer = { path: "src/file.ts", text, revision: 0, savedRevision: 0, language: "typescript" };
    const changes = [
      { id: "source", path: "project/src/file.ts", displayPath: "project/src/file.ts", oldPath: null, displayOldPath: null, indexStatus: "M", worktreeStatus: "M", untracked: false, conflicted: false, submodule: false, unsupportedReason: null },
      { id: "outside", path: "outside.md", displayPath: "outside.md", oldPath: null, displayOldPath: null, indexStatus: "A", worktreeStatus: ".", untracked: false, conflicted: false, submodule: false, unsupportedReason: null },
    ];
    if (clean) for (const entry of changes) { entry.indexStatus = "."; entry.worktreeStatus = "."; }
    const commit = { id: "a".repeat(40), parents: [repo.head], author: "Fixture author", authorEmail: "fixture@example.test", timestamp: 1700000000, subject: "Review staged changes", body: "Review staged changes\n\nFull commit details" };
    const status = () => ({ repository: structuredClone(repo), indexRevision: `index-${revision}`, stagedSnapshot: `tree-${revision}`, entries: structuredClone(changes.filter(entry => entry.indexStatus !== "." || entry.worktreeStatus !== ".")), operation, truncated: false });
    const patch = (path: string, side: string) => ({ repositoryId: repo.id, path, oldPath: null, side, indexRevision: `index-${revision}`, oldText: "before", newText: side === "staged" ? "index version" : "disk version", patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+${side === "staged" ? "index version" : side === "commit" ? "<script>fixture text only</script>" : "disk version"}\n`, binary: false, truncated: false, summary: null, commitId: side === "commit" ? commit.id : null });
    Object.assign(window, {
      isTauri: true,
      __gitFixture: trace,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++callback,
        unregisterCallback: () => undefined,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command.startsWith("git_") && !["git_context", "git_enable"].includes(command) && !enabled) throw new Error("Git read or mutation ran before activation");
          if (command === "git_file_baseline") { trace.baseline.push(args); return { repositoryId: repo.id, path: args.path, indexRevision: `index-${revision}`, headText: indexText, indexText, binary: false, truncated: false }; }
          if (command === "git_blame") { trace.blame.push(args); return { repositoryId: repo.id, path: args.path, head: repo.head, lines: [1, 2, 3, 4, 5].map(line => ({ line, originalLine: line, commitId: repo.head, author: "Fixture author", authorEmail: "fixture@example.test", timestamp: commit.timestamp, summary: "Initial fixture" })) }; }
          if (command === "git_branches") return [{ name: repo.branch, commitId: repo.head, remote: false, current: true, upstream: "origin/feature/review", ahead: 1, behind: 0 }, { name: "main", commitId: "c".repeat(40), remote: false, current: false, upstream: null, ahead: 0, behind: 0 }];
          if (command === "git_checkout") { trace.checkout.push(args); if (args.expectedIndexRevision !== `index-${revision}`) throw new Error("Index changed"); repo.branch = args.branch; revision++; return status(); }
          if (command === "git_tags") return structuredClone(tags);
          if (command === "git_create_tag") { trace.tags.push({ command, ...args }); tags.push({ name: args.name, objectId: args.targetId, targetId: args.targetId, annotated: false }); return structuredClone(tags); }
          if (command === "git_delete_tag") { trace.tags.push({ command, ...args }); const at = tags.findIndex(tag => tag.name === args.name && tag.objectId === args.expectedObjectId); if (at < 0) throw new Error("Tag changed"); tags.splice(at, 1); return structuredClone(tags); }
          if (command === "git_stashes") return structuredClone(stashes);
          if (command === "git_stash") { trace.stashes.push(args); if (args.expectedIndexRevision !== `index-${revision}`) throw new Error("Index changed"); if (args.action === "save") stashes.push({ id: "e".repeat(40), selector: "stash@{0}", subject: args.message || "Work in progress" }); else if (args.stashId !== stashes[0]?.id) throw new Error("Stash changed"); revision++; return { status: status(), output: args.action === "save" ? "Saved fixture stash." : "Applied fixture stash, kept stash." }; }
          if (command === "git_worktrees") return structuredClone(worktrees);
          if (command === "git_worktree_add") { trace.worktrees.push({ command, ...args }); worktrees.push({ path: args.path, branch: args.branch, head: repo.head, bare: false, locked: false, prunable: false }); return { status: status(), output: "Added fixture worktree." }; }
          if (command === "git_worktree_remove") { trace.worktrees.push({ command, ...args }); worktrees.splice(worktrees.findIndex(tree => tree.path === args.path), 1); return { status: status(), output: "Removed fixture worktree." }; }
          if (command === "git_remotes") return { remotes: [{ name: "origin", fetchUrl: "https://example.test/fixture/repo.git", pushUrl: "https://example.test/fixture/push.git", current: true }], configFingerprint: "reviewed-config-1" };
          if (command === "git_remote") { trace.remotes.push(args); if (args.expectedConfigFingerprint !== (trace.remoteConfigChanged ? "changed-config-2" : "reviewed-config-1")) throw new Error("Remote configuration changed. Review remotes again."); throw new Error("Fixture authentication failed. No remote operation ran."); }
          if (command === "git_hunk_diff") { const diff = patch(args.path, args.side); return { diff, worktreeSnapshot: `disk-${revision}`, hunks: [{ id: `hunk-${revision}`, header: "@@ -1 +1 @@", patch: diff.patch }] }; }
          if (command === "git_apply_hunk") { trace.hunk.push(args); if (args.expectedIndexRevision !== `index-${revision}` || args.expectedWorktreeSnapshot !== `disk-${revision}` || args.hunkId !== `hunk-${revision}`) throw new Error("Reviewed hunk changed"); revision++; return status(); }
          if (command === "git_integration_state") return { status: status(), worktreeSnapshot: `disk-${revision}` };
          if (command === "git_rebase") { trace.integration.push({ command, ...args }); operation = "rebase"; buffer.text = "<<<<<<< HEAD\nconst value = 2;\n=======\nconst value = 3;\n>>>>>>> fixture\n"; buffer.revision++; buffer.savedRevision = buffer.revision; Object.assign(changes[0], { indexStatus: "U", worktreeStatus: "U", conflicted: true }); revision++; return { state: { status: status(), worktreeSnapshot: `disk-${revision}` }, output: "Fixture rebase paused with conflicts.", completed: false }; }
          if (command === "git_mark_resolved" || command === "git_rebase_control") { trace.integration.push({ command, ...args }); if (args.expectedIndexRevision !== `index-${revision}` || args.expectedWorktreeSnapshot !== `disk-${revision}`) throw new Error("Conflict state changed"); if (command === "git_mark_resolved") { if (buffer.text.includes("<<<<<<<") || buffer.savedRevision !== buffer.revision) throw new Error("Save the fixture conflict resolution first"); Object.assign(changes[0], { indexStatus: "M", worktreeStatus: ".", conflicted: false }); revision++; return { status: status(), worktreeSnapshot: `disk-${revision}` }; } operation = null; revision++; return { state: { status: status(), worktreeSnapshot: `disk-${revision}` }, output: "Fixture rebase completed.", completed: true }; }
          if (command === "git_commit_details") return { commit, files: [{ path: "project/src/file.ts", oldPath: null, status: "M" }] };
          if (command === "git_context") return { workspaceRoot: root, repository: structuredClone(repo), enabled, unavailableReason: null };
          if (command === "git_enable") { enabled = true; trace.enables++; return status(); }
          if (command === "git_status") { trace.statusReads++; if (!enabled) throw new Error("Git status ran before activation"); return status(); }
          if (command === "git_diff") { trace.diffs.push(args); if (args.expectedIndexRevision !== `index-${revision}`) throw new Error("Git index changed. Refresh before reviewing."); return patch(args.path, args.side); }
          if (command === "git_stage" || command === "git_unstage") {
            if (args.expectedIndexRevision !== `index-${revision}`) throw new Error("Git index changed. Refresh before staging.");
            (command === "git_stage" ? trace.stage : trace.unstage).push(args);
            for (const path of args.paths) { const entry = changes.find(entry => entry.path === path)!; entry.indexStatus = command === "git_stage" ? "M" : "."; entry.worktreeStatus = command === "git_stage" ? "." : "M"; }
            revision += 1;
            return status();
          }
          if (command === "git_commit") {
            trace.commits.push(args);
            if (args.message === "fail hook") throw new Error("Commit hook failed. Nothing was committed.");
            if (args.expectedIndexRevision !== `index-${revision}` || args.expectedStagedSnapshot !== `tree-${revision}`) throw new Error("The reviewed staged snapshot changed.");
            for (const entry of changes) entry.indexStatus = ".";
            revision += 1; repo.head = commit.id;
            return { commitId: commit.id, commit, status: status(), warning: null };
          }
          if (command === "git_history") { trace.history.push(args); return { repositoryId: repo.id, anchor: commit.id, commits: [commit], nextSkip: null }; }
          if (command === "git_commit_diff") return patch(args.path || "project/src/file.ts", "commit");
          if (command === "get_session") return { workspaceRoot: root, groups: [{ paths: ["src/file.ts"], activePath: "src/file.ts" }], activeGroup: 0, markdownViews: {}, panels: { projectWidth: 320, assistantWidth: 350, terminalHeight: 230, projectCollapsed: false, assistantCollapsed: true, terminalCollapsed: true } };
          if (command === "open_workspace") return { root, name: "Project folder" };
          if (command === "get_settings" || command === "get_settings_for_scope") return { ...settings };
          if (command === "get_settings_jsonc" || command === "get_settings_jsonc_for_scope") return "{}";
          if (["take_startup_requests", "recent_projects", "get_settings_keys_for_scope", "agent_installed", "agent_registry", "agent_presets", "pending_run_approvals", "list_runs", "lsp_status", "sync_native_menu", "session_meta_list", "uploads_list"].includes(command)) return [];
          if (command === "agent_session_states") return { connectionId: null, sessions: [] };
          if (command === "run_tools_enabled") return false;
          if (command === "run_configurations") return { workspaceRoot: root, configurations: [], detected: [] };
          if (command === "run_context") return { workspaceRoot: root, workspaceEpoch: 1, runs: [] };
          if (command === "list_directory") return args.path ? [{ path: "src/file.ts", name: "file.ts", isDir: false }] : [{ path: "src", name: "src", isDir: true }];
          if (command === "check_external_files") return { workspaceRoot: root, revision: 0, directoriesChanged: false, states: [] };
          if (command === "file_index_status") return { workspaceRoot: root, generation: 1, status: "ready", scannedEntries: 1, indexedFiles: 1, errorCount: 0, lastError: null, watcherReady: true, watcherError: null };
          if (command === "query_file") return { workspaceRoot: root, generation: 1, requestId: 1, results: [{ path: "src/file.ts", score: 1 }] };
          if (command === "open_buffer" || command === "peek_buffer") return { ...buffer };
          if (command === "edit_buffer_delta") { if (args.expectedRevision !== buffer.revision) throw new Error("Stale buffer revision"); for (const change of [...args.changes].reverse()) buffer.text = buffer.text.slice(0, change.from) + change.insert + buffer.text.slice(change.to); buffer.revision += 1; if (buffer.text === text) buffer.savedRevision = buffer.revision; return { path: buffer.path, revision: buffer.revision, savedRevision: buffer.savedRevision }; }
          if (command === "save_buffer") { trace.diskSaves++; buffer.savedRevision = buffer.revision; if (operation) revision++; return { ...buffer }; }
          if (command === "native_window_state") return { fullscreen: false, maximized: false, hasNativeTrafficLights: false };
          if (command === "plugin:event|listen") return ++callback;
          if (["plugin:event|unlisten", "plugin:webview|set_webview_zoom", "save_session", "release_buffer"].includes(command)) return null;
          throw new Error(`Unsupported explicit Git fixture command: ${command}`);
        },
      },
    });
  }, { settings: defaults, clean });
  await page.goto("/");
  await expect(page.getByRole("main", { name: "span editor", exact: true })).toHaveAttribute("aria-busy", "false");
  return errors;
}
const trace = (page: Page) => page.evaluate(() => (window as unknown as { __gitFixture: { enables: number; statusReads: number; stage: any[]; unstage: any[]; commits: any[]; diffs: any[]; history: any[]; diskSaves: number; baseline: any[]; blame: any[]; checkout: any[]; stashes: any[]; tags: any[]; worktrees: any[]; remotes: any[]; hunk: any[]; integration: any[]; remoteConfigChanged: boolean } }).__gitFixture);

test("repository-wide saved/index diffs preserve a dirty editor and constrain outside-file opens", async ({ page }, info) => {
  const errors = await fixture(page);
  const editor = page.getByRole("textbox", { name: "Edit file.ts", exact: true });
  await editor.click(); await editor.press("ControlOrMeta+End"); await page.keyboard.insertText("// unsaved editor draft\n");
  await page.keyboard.press("Control+Shift+G");
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await expect(panel).toContainText("/fixture/repository");
  expect((await trace(page)).statusReads).toBe(0); expect((await trace(page)).enables).toBe(0);
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await expect(panel).toContainText("/fixture/repository"); await expect(panel).toContainText("whole repository");
  await panel.getByRole("button", { name: "Review staged changes in project/src/file.ts", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Git comparison", exact: true });
  await expect(comparison).toContainText("HEAD compared with index"); await expect(comparison).toContainText("+index version");
  await expect(comparison).not.toContainText("unsaved editor draft");
  await panel.getByRole("button", { name: "Review working changes in project/src/file.ts", exact: true }).click();
  await expect(comparison.filter({ hasText: "Index compared with working file" })).toContainText("+disk version");
  await panel.getByRole("button", { name: "Review staged changes in outside.md", exact: true }).click();
  const outside = comparison.filter({ hasText: "outside.md" });
  await expect(outside.getByRole("button", { name: "Open working file", exact: true })).toBeDisabled();
  await expect(outside).toContainText("outside the opened folder");
  await page.screenshot({ path: info.outputPath("git-repository-diff.png") });
  await page.getByRole("tab", { name: "file.ts", exact: true }).click();
  await expect(editor).toContainText("unsaved editor draft"); await editor.press("ControlOrMeta+z"); await expect(editor).not.toContainText("unsaved editor draft");
  expect((await trace(page)).diskSaves).toBe(0); expect(errors).toEqual([]);
});

test("explicit stage/unstage and staged-only commit preserve a failed message and editor draft", async ({ page }) => {
  const errors = await fixture(page);
  const editor = page.getByRole("textbox", { name: "Edit file.ts", exact: true });
  await editor.click(); await editor.press("ControlOrMeta+End"); await page.keyboard.insertText("// keep draft\n");
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await panel.getByRole("button", { name: "Unstage project/src/file.ts", exact: true }).click();
  await expect.poll(async () => (await trace(page)).unstage.length).toBe(1);
  await panel.getByRole("button", { name: "Stage project/src/file.ts", exact: true }).click();
  await expect.poll(async () => (await trace(page)).stage.length).toBe(1);
  const message = panel.getByRole("textbox", { name: "Git commit message", exact: true });
  await message.fill("fail hook"); await panel.getByRole("button", { name: "Commit 2 staged files", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Commit hook failed"); await expect(message).toHaveValue("fail hook");
  await message.fill("Review staged changes"); await message.press("ControlOrMeta+Enter");
  await expect(panel).toContainText("Committed aaaaaaaa"); await expect(message).toHaveValue("");
  await expect(editor).toContainText("keep draft");
  const result = await trace(page); expect(result.stage).toHaveLength(1); expect(result.unstage).toHaveLength(1); expect(result.diskSaves).toBe(0);
  expect(result.commits[1].expectedIndexRevision).toBe("index-3"); expect(result.commits[1].expectedStagedSnapshot).toBe("tree-3"); expect(errors).toEqual([]);
});

test("repository/file history opens safe read-only commit details and respects narrow themes", async ({ page }, info) => {
  const errors = await fixture(page);
  await expect(page.getByRole("button", { name: "History", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("tab", { name: "History", exact: true }).click();
  await expect(panel.getByRole("tab", { name: "History", exact: true })).toHaveAttribute("aria-selected", "true");
  const history = panel.getByRole("region", { name: "Git history", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await history.getByRole("radio", { name: "This file", exact: true }).click();
  await expect.poll(async () => (await trace(page)).history.at(-1)?.query.path).toBe("project/src/file.ts");
  await history.getByRole("button", { name: "Review commit aaaaaaaa: Review staged changes", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Git comparison", exact: true });
  await expect(comparison).toContainText("Commit changes"); await expect(comparison).toContainText("<script>fixture text only</script>");
  expect(await comparison.locator("script").count()).toBe(0); await comparison.locator("summary").click(); await expect(comparison).toContainText("Full commit details");
  for (const theme of ["light", "purple"]) {
    await page.locator(".ide").evaluate((node, value) => { node.classList.remove("theme-dark", "theme-light", "theme-purple"); node.classList.add(`theme-${value}`); }, theme);
    await page.screenshot({ path: info.outputPath(`git-history-${theme}.png`) });
  }
  await page.setViewportSize({ width: 720, height: 700 }); await expect(comparison).toBeVisible(); await page.screenshot({ path: info.outputPath("git-history-narrow.png") });
  expect((await trace(page)).commits).toHaveLength(0); expect(errors).toEqual([]);
});

test("browser preview exposes native Git unavailability without sample commits", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await expect(panel).toContainText("Browser preview does not run Git");
  await expect(panel.getByRole("textbox", { name: "Git commit message", exact: true })).toHaveCount(0);
});

test("consent gates explorer, tab, gutter and authorship decorations for live unsaved edits", async ({ page }, info) => {
  const errors = await fixture(page);
  const editor = page.getByRole("textbox", { name: "Edit file.ts", exact: true });
  await expect(page.locator(".cm-git-marker")).toHaveCount(0);
  await expect(page.locator(".file-tab[data-git-status]")).toHaveCount(0);
  expect((await trace(page)).baseline).toHaveLength(0); expect((await trace(page)).blame).toHaveLength(0);
  const layout = page.getByRole("radiogroup", { name: "Layout", exact: true });
  await layout.getByRole("radio", { name: "Agents", exact: true }).click();
  await expect(layout.getByRole("radio", { name: "Agents", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".agents-view-layer")).toBeVisible();
  await page.getByRole("button", { name: "Source control", exact: true }).click();
  await expect(layout.getByRole("radio", { name: "Editor", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".agents-view-layer")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Git source control", exact: true })).toBeVisible();
  await expect(editor).toBeVisible();
  await page.getByRole("button", { name: "Enable Git", exact: true }).click();
  await expect(page.getByRole("button", { name: "Source control", exact: true }).getByLabel("2 changed files", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("git-agent-mode-return.png") });
  await expect(page.locator(".file-tab[data-git-status='modified']")).toHaveCount(1);
  await expect(page.locator(".cm-git-marker.cm-git-modified")).toHaveCount(2);
  await editor.click(); await editor.press("ControlOrMeta+Home"); await editor.press("ArrowDown");
  await expect(page.getByRole("button", { name: "Git authorship: Fixture author. Open file history", exact: true })).toBeVisible();
  await editor.press("ControlOrMeta+End"); await page.keyboard.insertText("// unsaved decoration\n"); await editor.press("ArrowUp");
  await expect(page.locator(".cm-git-marker.cm-git-added")).not.toHaveCount(0);
  await expect(page.getByRole("button", { name: "Git authorship: Uncommitted changes. Open file history", exact: true })).toBeVisible();
  await expect(page.locator(".file-tab .git-path-badge")).toHaveAttribute("title", /unsaved changes/);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.locator("[role='treeitem'][data-git-status='modified']")).not.toHaveCount(0);
  await expect(page.locator(".tree-row .git-path-badge[title*='unsaved changes']")).toBeVisible();
  await page.getByRole("group", { name: "Git change navigation", exact: true }).getByRole("button", { name: "Next Git change", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Git change preview", exact: true });
  await expect(preview).toContainText("const value = 2;"); await expect(preview).toContainText("const value = 3;");
  await preview.getByRole("button", { name: "Next Git change", exact: true }).click();
  await expect(preview).toContainText("const other = 4;");
  await page.screenshot({ path: info.outputPath("git-live-decorations.png") });
  await preview.getByRole("button", { name: "Close Git change preview", exact: true }).click();
  await expect(preview).toHaveCount(0); await expect(editor).toContainText("unsaved decoration");
  const result = await trace(page); expect(result.baseline[0].path).toBe("project/src/file.ts"); expect(result.blame[0].path).toBe("project/src/file.ts"); expect(result.diskSaves).toBe(0); expect(errors).toEqual([]);
});

test("five keyboard subviews create a branch, manage local tags and save/apply a stable stash", async ({ page }, info) => {
  const errors = await fixture(page);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  const views = panel.getByRole("tablist", { name: "Source control view", exact: true });
  await expect(views.getByRole("tab")).toHaveCount(5);
  await views.getByRole("tab", { name: "Changes", exact: true }).focus();
  for (const label of ["History", "Branches", "Stash", "Worktrees", "Changes"]) {
    await page.keyboard.press("ArrowRight");
    await expect(views.getByRole("tab", { name: label, exact: true })).toBeFocused();
    await expect(views.getByRole("tab", { name: label, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("tabpanel", { name: label, exact: true })).toBeVisible();
  }
  await views.getByRole("tab", { name: "Branches", exact: true }).click();
  const branches = panel.getByRole("region", { name: "Git branches", exact: true });
  await branches.getByRole("button", { name: "New", exact: true }).click();
  await branches.getByLabel("New branch from HEAD", { exact: true }).fill("feature/browser-fixture");
  await branches.getByRole("button", { name: "Create branch", exact: true }).click();
  await expect(panel.locator(".git-repo-branch")).toContainText("feature/browser-fixture");
  expect((await trace(page)).checkout[0]).toMatchObject({ branch: "feature/browser-fixture", create: true, expectedIndexRevision: "index-1" });
  await branches.getByRole("button", { name: "Create local tag", exact: true }).click();
  await branches.getByLabel("Lightweight tag at HEAD", { exact: true }).fill("v0.2.0");
  await branches.getByRole("button", { name: "Create tag", exact: true }).click();
  await expect(branches).toContainText("Created local tag v0.2.0.");
  await branches.getByRole("button", { name: "Delete local tag v0.2.0", exact: true }).click();
  const deletion = branches.getByRole("group", { name: "Confirm deletion of local tag v0.2.0", exact: true });
  expect((await trace(page)).tags).toHaveLength(1);
  await deletion.getByRole("button", { name: "Delete local tag", exact: true }).click();
  await expect(branches.getByRole("button", { name: "Delete local tag v0.2.0", exact: true })).toHaveCount(0);
  expect((await trace(page)).tags[1]).toMatchObject({ command: "git_delete_tag", name: "v0.2.0", expectedObjectId: "b".repeat(40) });
  await views.getByRole("tab", { name: "Stash", exact: true }).click();
  const stashes = panel.getByRole("region", { name: "Git stashes", exact: true });
  await stashes.getByRole("button", { name: "Stash", exact: true }).click();
  await stashes.getByLabel("Stash message (optional)", { exact: true }).fill("Browser fixture work");
  await stashes.getByRole("button", { name: "Save stash", exact: true }).click();
  await expect(stashes).toContainText("Browser fixture work");
  await stashes.getByRole("button", { name: "Apply stash@{0}", exact: true }).click();
  await expect(stashes.getByRole("status")).toContainText("Applied stash eeeeeeee. Stash retained.");
  const output = stashes.getByLabel("Git command output", { exact: true });
  await expect(output).not.toBeVisible();
  await stashes.locator("summary").filter({ hasText: "Git output" }).click();
  await expect(output).toBeVisible(); await expect(output).toContainText("Applied fixture stash, kept stash.");
  await stashes.locator("summary").filter({ hasText: "Git output" }).click();
  await expect(output).not.toBeVisible();
  await expect(stashes.getByRole("button", { name: "Apply stash@{0}", exact: true })).toBeVisible();
  const result = await trace(page); expect(result.stashes).toHaveLength(2); expect(result.stashes[0]).toMatchObject({ action: "save", message: "Browser fixture work", stashId: null }); expect(result.stashes[1]).toMatchObject({ action: "apply", stashId: "e".repeat(40), expectedIndexRevision: "index-3" });
  await page.screenshot({ path: info.outputPath("git-branch-stash.png") }); expect(errors).toEqual([]);
});

test("worktree removal is explicit and remote failure retains message and unsaved editor draft", async ({ page }, info) => {
  const errors = await fixture(page);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await panel.getByRole("tab", { name: "Worktrees", exact: true }).click();
  const trees = panel.getByRole("region", { name: "Git worktrees", exact: true });
  await expect(trees.getByRole("button", { name: "Remove worktree /fixture/repository", exact: true })).toHaveCount(0);
  await expect(trees.getByRole("button", { name: "Remove worktree /fixture/locked", exact: true })).toBeDisabled();
  await trees.getByRole("button", { name: "Remove worktree /fixture/review", exact: true }).click();
  const confirmation = trees.getByRole("group", { name: "Confirm worktree removal", exact: true });
  await expect(confirmation).toContainText("/fixture/review"); expect((await trace(page)).worktrees).toHaveLength(0);
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await trace(page)).worktrees).toHaveLength(0);
  await trees.getByRole("button", { name: "Remove worktree /fixture/review", exact: true }).click();
  await confirmation.getByRole("button", { name: "Remove worktree", exact: true }).click();
  await expect(trees.getByRole("button", { name: "Remove worktree /fixture/review", exact: true })).toHaveCount(0);
  expect((await trace(page)).worktrees[0]).toMatchObject({ command: "git_worktree_remove", path: "/fixture/review" });
  await panel.getByRole("tab", { name: "Changes", exact: true }).click();
  const message = panel.getByRole("textbox", { name: "Git commit message", exact: true }); await message.fill("Keep this commit draft");
  const editor = page.getByRole("textbox", { name: "Edit file.ts", exact: true });
  await editor.click(); await editor.press("ControlOrMeta+End"); await page.keyboard.insertText("// keep after remote failure\n");
  await expect(panel.locator(".git-remote-target")).toContainText("https://example.test/fixture/repo.git");
  await expect(panel.locator(".git-remote-target")).toContainText("Push: https://example.test/fixture/push.git");
  await panel.getByRole("button", { name: "Fetch", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Fixture authentication failed");
  await expect(message).toHaveValue("Keep this commit draft"); await expect(editor).toContainText("keep after remote failure");
  expect((await trace(page)).remotes[0]).toMatchObject({ action: "fetch", expectedConfigFingerprint: "reviewed-config-1" }); expect((await trace(page)).diskSaves).toBe(0);
  await page.evaluate(() => { (window as unknown as { __gitFixture: { remoteConfigChanged: boolean } }).__gitFixture.remoteConfigChanged = true; });
  await panel.getByRole("button", { name: "Fetch", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Remote configuration changed. Review remotes again.");
  await expect(message).toHaveValue("Keep this commit draft"); await expect(editor).toContainText("keep after remote failure");
  expect((await trace(page)).remotes).toHaveLength(2);
  await page.screenshot({ path: info.outputPath("git-remote-failure.png") }); expect(errors).toEqual([]);
});

test("saved hunk staging uses reviewed index and disk snapshots while editor stays dirty", async ({ page }) => {
  const errors = await fixture(page);
  const editor = page.getByRole("textbox", { name: "Edit file.ts", exact: true });
  await editor.click(); await editor.press("ControlOrMeta+End"); await page.keyboard.insertText("// hunk excludes unsaved text\n");
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await panel.getByRole("button", { name: "Review working changes in project/src/file.ts", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Git comparison", exact: true });
  await comparison.getByRole("button", { name: "Stage hunk @@ -1 +1 @@", exact: true }).click();
  await expect(panel).toContainText("Staged hunk.");
  expect((await trace(page)).hunk[0]).toMatchObject({ path: "project/src/file.ts", side: "working", hunkId: "hunk-1", expectedIndexRevision: "index-1", expectedWorktreeSnapshot: "disk-1" });
  await expect(comparison).not.toContainText("hunk excludes unsaved text");
  await page.getByRole("tab", { name: "file.ts", exact: true }).click(); await expect(editor).toContainText("hunk excludes unsaved text");
  expect((await trace(page)).diskSaves).toBe(0); expect(errors).toEqual([]);
});

test("rebase conflict workflow requires resolution before continuing and sends fresh snapshots", async ({ page }, info) => {
  const errors = await fixture(page, true);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await panel.getByRole("tab", { name: "Branches", exact: true }).click();
  await panel.getByRole("button", { name: "Rebase onto main", exact: true }).click();
  expect((await trace(page)).integration).toHaveLength(0);
  await panel.getByRole("group", { name: "Confirm rebase onto main", exact: true }).getByRole("button", { name: "Start rebase", exact: true }).click();
  await panel.getByRole("tab", { name: "Changes", exact: true }).click();
  await expect(panel).toContainText("Rebase in progress");
  await expect(panel.getByRole("button", { name: "Continue rebase", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Commit 1 staged file", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Open conflict file project/src/file.ts", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Edit file.ts", exact: true });
  await expect(editor).toContainText("<<<<<<< HEAD");
  await page.screenshot({ path: info.outputPath("git-rebase-conflict.png") });
  await editor.click(); await editor.press("ControlOrMeta+a"); await page.keyboard.insertText("const value = 3; // resolved fixture conflict\n");
  await panel.getByRole("button", { name: "Mark project/src/file.ts resolved", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Save or close unsaved files" })).toBeVisible();
  expect((await trace(page)).integration).toHaveLength(1);
  await editor.click(); await editor.press("ControlOrMeta+s");
  await expect.poll(async () => (await trace(page)).diskSaves).toBe(1);
  await panel.getByRole("button", { name: "Mark project/src/file.ts resolved", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Continue rebase", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Continue rebase", exact: true }).click();
  await expect(panel).toContainText("Fixture rebase completed."); await expect(panel).not.toContainText("Rebase in progress");
  const actions = (await trace(page)).integration;
  expect(actions).toHaveLength(3); expect(actions[0]).toMatchObject({ command: "git_rebase", targetId: "c".repeat(40), expectedIndexRevision: "index-1" });
  expect(actions[1]).toMatchObject({ command: "git_mark_resolved", expectedIndexRevision: "index-3", expectedWorktreeSnapshot: "disk-3" });
  expect(actions[2]).toMatchObject({ command: "git_rebase_control", action: "continue", expectedIndexRevision: "index-4", expectedWorktreeSnapshot: "disk-4" }); expect(errors).toEqual([]);
});
