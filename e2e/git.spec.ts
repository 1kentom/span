import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Explicit IPC fixture: these browser tests never execute Git or change a repository.
const schema = JSON.parse(readFileSync("crates/core/settings.schema.json", "utf8")).properties;
const defaults = Object.fromEntries(Object.entries(schema as Record<string, { default?: unknown }>).filter(([key, value]) => !key.includes(".") && key !== "$schema" && "default" in value).map(([key, value]) => [key, value.default]));

async function fixture(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(settings => {
    let callback = 0;
    let revision = 1;
    let enabled = false;
    const root = "/fixture/repository/project";
    const repo = { id: "git-fixture-session", root: "/fixture/repository", workspacePrefix: "project", branch: "feature/review", head: "b".repeat(40), detached: false, unborn: false };
    const trace = { enables: 0, statusReads: 0, stage: [] as any[], unstage: [] as any[], commits: [] as any[], diffs: [] as any[], history: [] as any[], diskSaves: 0 };
    const text = "const value = 3;\n";
    const buffer = { path: "src/file.ts", text, revision: 0, savedRevision: 0, language: "typescript" };
    const changes = [
      { id: "source", path: "project/src/file.ts", displayPath: "project/src/file.ts", oldPath: null, displayOldPath: null, indexStatus: "M", worktreeStatus: "M", untracked: false, conflicted: false, submodule: false, unsupportedReason: null },
      { id: "outside", path: "outside.md", displayPath: "outside.md", oldPath: null, displayOldPath: null, indexStatus: "A", worktreeStatus: ".", untracked: false, conflicted: false, submodule: false, unsupportedReason: null },
    ];
    const commit = { id: "a".repeat(40), parents: [repo.head], author: "Fixture author", authorEmail: "fixture@example.test", timestamp: 1700000000, subject: "Review staged changes", body: "Review staged changes\n\nFull commit details" };
    const status = () => ({ repository: repo, indexRevision: `index-${revision}`, stagedSnapshot: `tree-${revision}`, entries: structuredClone(changes.filter(entry => entry.indexStatus !== "." || entry.worktreeStatus !== ".")), operation: null, truncated: false });
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
          if (command === "git_context") return { workspaceRoot: root, repository: repo, enabled, unavailableReason: null };
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
          if (command === "file_index_status") return { workspaceRoot: root, generation: 1, status: "ready", scannedEntries: 1, indexedFiles: 1, errorCount: 0, lastError: null, watcherReady: true, watcherError: null };
          if (command === "query_file") return { workspaceRoot: root, generation: 1, requestId: 1, results: [{ path: "src/file.ts", score: 1 }] };
          if (command === "open_buffer" || command === "peek_buffer") return { ...buffer };
          if (command === "edit_buffer_delta") { if (args.expectedRevision !== buffer.revision) throw new Error("Stale buffer revision"); for (const change of [...args.changes].reverse()) buffer.text = buffer.text.slice(0, change.from) + change.insert + buffer.text.slice(change.to); buffer.revision += 1; if (buffer.text === text) buffer.savedRevision = buffer.revision; return { path: buffer.path, revision: buffer.revision, savedRevision: buffer.savedRevision }; }
          if (command === "save_buffer") { trace.diskSaves++; buffer.savedRevision = buffer.revision; return { ...buffer }; }
          if (command === "native_window_state") return { fullscreen: false, maximized: false, hasNativeTrafficLights: false };
          if (command === "plugin:event|listen") return ++callback;
          if (["plugin:event|unlisten", "plugin:webview|set_webview_zoom", "save_session", "release_buffer"].includes(command)) return null;
          throw new Error(`Unsupported explicit Git fixture command: ${command}`);
        },
      },
    });
  }, defaults);
  await page.goto("/");
  await expect(page.getByRole("main", { name: "span editor", exact: true })).toHaveAttribute("aria-busy", "false");
  return errors;
}
const trace = (page: Page) => page.evaluate(() => (window as unknown as { __gitFixture: { enables: number; statusReads: number; stage: any[]; unstage: any[]; commits: any[]; diffs: any[]; history: any[]; diskSaves: number } }).__gitFixture);

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
