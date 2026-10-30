import { expect, test, type Page, type Locator } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";

// Explicit IPC fixture: browser tests never execute Git, change a repository, or contact hosting services.
const schema = JSON.parse(readFileSync("crates/core/settings.schema.json", "utf8")).properties;
const defaults = Object.fromEntries(Object.entries(schema as Record<string, { default?: unknown }>).filter(([key, value]) => !key.includes(".") && key !== "$schema" && "default" in value).map(([key, value]) => [key, value.default]));

async function fixture(page: Page, clean = false, noRoot = false) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ settings, clean, noRoot }) => {
    let callback = 0;
    let currentSettings = { ...settings };
    let revision = 1;
    let enabled = false;
    let root = noRoot ? null : "/fixture/repository/project";
    const repo = { id: "git-fixture-session", root: "/fixture/repository", workspacePrefix: "project", branch: "feature/review", head: "b".repeat(40), detached: false, unborn: false };
    const trace = { phase3: [] as any[], noRemotes: false, stagedBaseline: false, folds: false, noUpstream: false, changeHead: false, failLines: false, failClone: true, baseline: [] as any[], blame: [] as any[], checkout: [] as any[], stashes: [] as any[], tags: [] as any[], worktrees: [] as any[], remotes: [] as any[], hunk: [] as any[], integration: [] as any[], enables: 0, statusReads: 0, stage: [] as any[], unstage: [] as any[], commits: [] as any[], diffs: [] as any[], history: [] as any[], diskSaves: 0, remoteConfigChanged: false, hosting: [] as any[], conflictReads: [] as any[], conflictSaves: [] as any[], failCreate: true, failReview: true, failDetail: false };
    let treeRevision = 1;
    const text = "const value = 3;\nconst stable = true;\nconst other = 4;\nconst tail = true;\n";
    const indexText = "const value = 2;\nconst stable = true;\nconst other = 3;\nconst tail = true;\n";
    let operation: string | null = null;
    const stashes: { id: string; selector: string; subject: string }[] = [];
    const tags = [{ name: "v0.1.0", objectId: "d".repeat(40), targetId: repo.head, annotated: false }];
    const worktrees = [
      { path: repo.root, branch: repo.branch, head: repo.head, main: true, bare: false, locked: false, prunable: false },
      { path: "/fixture/review", branch: "feature/other", head: repo.head, main: false, bare: false, locked: false, prunable: false },
      { path: "/fixture/locked", branch: "feature/locked", head: repo.head, main: false, bare: false, locked: true, prunable: false },
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
          if ((command.startsWith("github_") || command.startsWith("git_")) && !["git_context", "git_enable", "git_clone_repository"].includes(command) && !enabled) throw new Error("Git read or mutation ran before activation");
          if (command.startsWith("github_")) {
            trace.hosting.push({ command, ...args });
            const repository = { host: "github.com", owner: "fixture", name: "project", remoteName: "origin" };
            if (command !== "github_repositories" && (args.expectedRepository?.host !== repository.host || args.expectedRepository?.owner !== repository.owner || args.expectedRepository?.name !== repository.name || args.expectedRepository?.remoteName !== repository.remoteName)) throw new Error("Reviewed GitHub repository changed");
            const item = { number: 42, title: "Fixture pull request", body: "Review this literal <script>fixture</script> body.", state: "OPEN", url: "https://github.com/fixture/project/pull/42", author: { login: "fixture-author" }, baseRefName: "main", headRefName: "feature/review", headRefOid: "f".repeat(40), isDraft: false, reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ name: "Fixture CI", context: "", status: "COMPLETED", conclusion: "SUCCESS", state: "", detailsUrl: "https://example.test/check", targetUrl: "" }], reviews: [], comments: [], files: [], changedFiles: 1, additions: 1, deletions: 1, nameWithOwner: "fixture/project", description: null, isPrivate: true, filename: "", patch: null, previous_filename: null };
            if (command === "github_repositories") return [repository];
            if (command === "github_status") return { available: true, authenticated: true, message: "Authenticated fixture CLI. No hosted requests are executed.", repository };
            if (command === "github_create_pull_request") { if (trace.failCreate) throw new Error("Fixture create failed. Pull request draft retained."); return "https://github.com/fixture/project/pull/43"; }
            if (command === "github_review_pull_request") { if (trace.failReview) throw new Error("Fixture review failed. No review published."); return "Fixture review submitted."; }
            if (command === "github_read") {
              if (args.request.kind === "pullRequest" && trace.failDetail) throw new Error("Fixture detail read failed. No detail data available.");
              return { items: args.request.kind === "pullRequestFiles" ? [{ ...item, filename: "project/src/file.ts", patch: "@@ -1 +1 @@\n-before\n+<script>literal patch</script>" }] : args.request.kind === "pullRequests" ? [{ ...item, body: "", statusCheckRollup: [], reviews: [], comments: [], changedFiles: 0, additions: 0, deletions: 0 }] : [item] };
            }
          }
          if (command === "git_checkout_pull_request") { trace.checkout.push({ command, ...args }); if (args.expectedHead !== "f".repeat(40) || args.expectedConfigFingerprint !== "reviewed-config-1" || args.expectedIndexRevision !== `index-${revision}`) throw new Error("Reviewed PR snapshot changed"); repo.branch = args.localBranch; repo.head = args.expectedHead; revision++; return { status: status(), output: "Checked out pinned fixture PR." }; }
          if (command === "git_worktree_create") { trace.worktrees.push({ command, ...args }); if (args.expectedHead !== repo.head) throw new Error("HEAD changed"); worktrees.push({ path: args.path, branch: args.mode === "newBranch" ? args.branch : null, head: repo.head, main: false, bare: false, locked: false, prunable: false }); treeRevision++; return { status: status(), output: "Created fixture worktree." }; }
          if (command === "git_worktree_prune_review") { trace.worktrees.push({ command, ...args }); return { snapshot: `worktrees-${treeRevision}`, output: "Fixture stale metadata: /fixture/stale. No working directories will be removed." }; }
          if (command === "git_worktree_set_locked" || command === "git_worktree_prune") { trace.worktrees.push({ command, ...args }); if (args.expectedSnapshot !== `worktrees-${treeRevision}`) throw new Error("Worktree review changed"); if (command === "git_worktree_set_locked") worktrees.find(tree => tree.path === args.path)!.locked = args.locked; treeRevision++; return { status: status(), output: "Updated fixture worktree metadata." }; }
          if (command === "git_conflict_resource") { trace.conflictReads.push(args); if (args.expectedIndexRevision !== `index-${revision}`) throw new Error("Conflict index changed"); return { path: args.path, base: "const value = 1;\n", ours: "const value = 2;\n", theirs: "const value = 3;\n", working: buffer.text, state: { status: status(), worktreeSnapshot: `disk-${revision}` } }; }
          if (command === "git_save_conflict_resolution") { trace.conflictSaves.push(args); if (args.expectedIndexRevision !== `index-${revision}` || args.expectedWorktreeSnapshot !== `disk-${revision}`) throw new Error("Reviewed conflict changed"); buffer.text = args.content; buffer.revision++; buffer.savedRevision = buffer.revision; revision++; return { status: status(), worktreeSnapshot: `disk-${revision}` }; }
          if (command === "git_file_baseline") { trace.baseline.push(args); return { repositoryId: repo.id, path: args.path, indexRevision: `index-${revision}`, headText: trace.stagedBaseline ? indexText.replace("stable = true", "stable = false") : clean ? text : indexText, indexText: clean ? text : indexText, binary: false, truncated: false }; }
          if (command === "git_blame") { trace.blame.push(args); return { repositoryId: repo.id, path: args.path, head: repo.head, lines: [1, 2, 3, 4, 5].map(line => ({ line, originalLine: line, commitId: repo.head, author: "Fixture author", authorEmail: "fixture@example.test", timestamp: commit.timestamp, summary: "Initial fixture" })) }; }
          if (command === "git_branches") return [{ name: repo.branch, commitId: repo.head, remote: false, current: true, upstream: trace.noUpstream ? null : "origin/feature/review", ahead: 1, behind: 0 }, { name: "main", commitId: "c".repeat(40), remote: false, current: false, upstream: null, ahead: 0, behind: 0 }];
          if (command === "git_checkout") { trace.checkout.push(args); if (args.expectedIndexRevision !== `index-${revision}`) throw new Error("Index changed"); repo.branch = args.branch; revision++; return status(); }
          if (command === "git_tags") return structuredClone(tags);
          if (command === "git_create_tag") { trace.tags.push({ command, ...args }); tags.push({ name: args.name, objectId: args.targetId, targetId: args.targetId, annotated: false }); return structuredClone(tags); }
          if (command === "git_delete_tag") { trace.tags.push({ command, ...args }); const at = tags.findIndex(tag => tag.name === args.name && tag.objectId === args.expectedObjectId); if (at < 0) throw new Error("Tag changed"); tags.splice(at, 1); return structuredClone(tags); }
          if (command === "git_stashes") return structuredClone(stashes);
          if (command === "git_stash") { trace.stashes.push(args); if (args.expectedIndexRevision !== `index-${revision}`) throw new Error("Index changed"); if (args.action === "save") stashes.push({ id: "e".repeat(40), selector: "stash@{0}", subject: args.message || "Work in progress" }); else if (args.stashId !== stashes[0]?.id) throw new Error("Stash changed"); revision++; return { status: status(), output: args.action === "save" ? "Saved fixture stash." : "Applied fixture stash, kept stash." }; }
          if (command === "git_worktrees") return structuredClone(worktrees);
          if (command === "git_worktree_add") { trace.worktrees.push({ command, ...args }); worktrees.push({ path: args.path, branch: args.branch, head: repo.head, main: false, bare: false, locked: false, prunable: false }); return { status: status(), output: "Added fixture worktree." }; }
          if (command === "git_worktree_remove") { trace.worktrees.push({ command, ...args }); worktrees.splice(worktrees.findIndex(tree => tree.path === args.path), 1); return { status: status(), output: "Removed fixture worktree." }; }
          if (command === "git_remotes") return { remotes: trace.noRemotes ? [] : [{ name: "origin", fetchUrl: "https://example.test/fixture/repo.git", pushUrl: "https://example.test/fixture/push.git", current: true }], configFingerprint: "reviewed-config-1" };
          if (command === "git_remote") { trace.remotes.push(args); if (args.expectedConfigFingerprint !== (trace.remoteConfigChanged ? "changed-config-2" : "reviewed-config-1")) throw new Error("Remote configuration changed. Review remotes again."); throw new Error("Fixture authentication failed. No remote operation ran."); }
          if (command === "git_hunk_diff") { const diff = patch(args.path, args.side); return { diff, worktreeSnapshot: `disk-${revision}`, hunks: [{ id: `hunk-${revision}`, header: "@@ -1 +1 @@", patch: diff.patch }] }; }
          if (command === "git_apply_hunk") { trace.hunk.push(args); if (args.expectedIndexRevision !== `index-${revision}` || args.expectedWorktreeSnapshot !== `disk-${revision}` || args.hunkId !== `hunk-${revision}`) throw new Error("Reviewed hunk changed"); revision++; return status(); }
          if (command === "git_integration_state") return { status: status(), worktreeSnapshot: `disk-${revision}` };
          if (command === "git_rebase") { trace.integration.push({ command, ...args }); operation = "rebase"; buffer.text = "<<<<<<< HEAD\nconst value = 2;\n=======\nconst value = 3;\n>>>>>>> fixture\n"; buffer.revision++; buffer.savedRevision = buffer.revision; Object.assign(changes[0], { indexStatus: "U", worktreeStatus: "U", conflicted: true }); revision++; return { state: { status: status(), worktreeSnapshot: `disk-${revision}` }, output: "Fixture rebase paused with conflicts.", completed: false }; }
          if (command === "git_mark_resolved" || command === "git_rebase_control") { trace.integration.push({ command, ...args }); if (args.expectedIndexRevision !== `index-${revision}` || args.expectedWorktreeSnapshot !== `disk-${revision}`) throw new Error("Conflict state changed"); if (command === "git_mark_resolved") { if (buffer.text.includes("<<<<<<<") || buffer.savedRevision !== buffer.revision) throw new Error("Save the fixture conflict resolution first"); Object.assign(changes[0], { indexStatus: "M", worktreeStatus: ".", conflicted: false }); revision++; return { status: status(), worktreeSnapshot: `disk-${revision}` }; } operation = null; revision++; return { state: { status: status(), worktreeSnapshot: `disk-${revision}` }, output: "Fixture rebase completed.", completed: true }; }
          if (command === "git_commit_details") return { commit, files: [{ path: "project/src/file.ts", oldPath: null, status: "M" }] };
          if (command === "git_clone_repository") { trace.phase3.push({ command, ...args }); if (trace.failClone) throw new Error("Fixture clone failed. Destination was not created."); return { path: args.destination, output: "Fixture cloned." }; }
          if (command === "git_worktree_window_path") { trace.phase3.push({ command, ...args }); if (!worktrees.some(tree => tree.path === args.path)) throw new Error("Unknown worktree"); return args.path; }
          if (command === "git_open_worktree_window") { trace.phase3.push({ command, ...args }); return null; }
          if (command === "git_history_tools") { trace.phase3.push({ command, ...args }); return { heads: [commit.id], refs: [{ name: "refs/heads/feature/review", commitId: commit.id }], commits: [commit], nextSkip: null }; }
          if (command === "git_reflog_page") { trace.phase3.push({ command, ...args }); return { entries: [{ commitId: commit.id, selector: "HEAD@{0}", subject: "commit: Fixture movement" }], nextSkip: null }; }
          if (command === "git_revision_content") { trace.phase3.push({ command, ...args }); return { revision: commit.id, path: args.path, text: "<script>literal revision</script>", binary: false, truncated: false }; }
          if (command === "git_revision_diff") { trace.phase3.push({ command, ...args }); return { from: commit.id, to: null, path: args.path, patch: patch(args.path, "commit").patch, truncated: false }; }
          if (command === "git_line_history") { trace.phase3.push({ command, ...args }); return { repositoryId: repo.id, anchor: commit.id, commits: [commit], nextSkip: null }; }
          if (command === "git_review_lines") { trace.phase3.push({ command, ...args }); return { diff: patch(args.path, args.side), worktreeSnapshot: `disk-${revision}`, metadata: [], hunks: [{ id: `hunk-${revision}`, header: "@@ -1 +1 @@", lines: [{ id: `opaque-remove-${revision}`, kind: "delete", text: "before\n", oldLine: 1, newLine: null }, { id: `opaque-add-${revision}`, kind: "insert", text: args.side === "staged" ? "index version\n" : "disk version\n", oldLine: null, newLine: 1 }] }] }; }
          if (command === "git_apply_lines") { trace.phase3.push({ command, ...args }); if (trace.failLines || args.expectedIndexRevision !== `index-${revision}` || args.expectedWorktreeSnapshot !== `disk-${revision}` || args.lineIds.some((id: string) => ![`opaque-remove-${revision}`, `opaque-add-${revision}`].includes(id))) throw new Error("Reviewed selected lines changed"); revision++; return status(); }
          if (command === "git_remote_selected") { trace.remotes.push(args); if (args.expectedIndexRevision !== `index-${revision}` || args.remoteName !== "origin") throw new Error("Remote review changed"); if (args.expectedConfigFingerprint !== (trace.remoteConfigChanged ? "changed-config-2" : "reviewed-config-1")) throw new Error("Remote configuration changed. Review remotes again."); if (args.action !== "push") throw new Error("Fixture authentication failed. No remote operation ran."); return { operation: { status: status(), output: "Published fixture branch." }, remoteSucceeded: true, upstreamConfigured: args.setUpstream, warning: null }; }
          if (command === "git_amend") { trace.phase3.push({ command, ...args }); if (args.expectedHead !== repo.head || args.expectedIndexRevision !== `index-${revision}` || args.expectedStagedSnapshot !== `tree-${revision}`) throw new Error("Reviewed amend changed"); return { commitId: commit.id, commit, status: status(), warning: null }; }
          if (command === "git_context") return { workspaceRoot: root, repository: !root ? null : structuredClone(repo), enabled, unavailableReason: null };
          if (command === "git_enable") { enabled = true; trace.enables++; return status(); }
          if (command === "git_status") { trace.statusReads++; if (trace.changeHead) { repo.head = "c".repeat(40); trace.changeHead = false; } if (!enabled) throw new Error("Git status ran before activation"); return status(); }
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
          if (command === "get_session") return { workspaceRoot: root, groups: noRoot ? [] : [{ paths: ["src/file.ts"], activePath: "src/file.ts" }], activeGroup: 0, markdownViews: {}, panels: { projectWidth: 320, assistantWidth: 350, terminalHeight: 230, projectCollapsed: false, assistantCollapsed: true, terminalCollapsed: true } };
          if (command === "open_workspace") { if (noRoot) { trace.phase3.push({ command, ...args }); root = args.path; } return { root, name: "Project folder" }; }
          if (command === "get_settings" || command === "get_settings_for_scope") return { ...currentSettings };
          if (command === "update_setting") { currentSettings = { ...currentSettings, [args.key]: JSON.parse(args.valueJson) }; return { ...currentSettings }; }
          if (command === "syntax") return { revision: buffer.revision, language: "typescript", highlights: [], folds: trace.folds && buffer.text.startsWith("function") ? [{ from: buffer.text.indexOf("{") + 1, to: buffer.text.lastIndexOf("}") }] : [], indentGuides: [], truncated: false };
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
  }, { settings: defaults, clean, noRoot });
  await page.goto("/");
  await expect(page.getByRole("main", { name: "span editor", exact: true })).toHaveAttribute("aria-busy", "false");
  return errors;
}
const trace = (page: Page) => page.evaluate(() => (window as unknown as { __gitFixture: { phase3: any[]; enables: number; statusReads: number; stage: any[]; unstage: any[]; commits: any[]; diffs: any[]; history: any[]; diskSaves: number; baseline: any[]; blame: any[]; checkout: any[]; stashes: any[]; tags: any[]; worktrees: any[]; remotes: any[]; hunk: any[]; integration: any[]; remoteConfigChanged: boolean; hosting: any[]; conflictReads: any[]; conflictSaves: any[]; failCreate: boolean; failReview: boolean; failDetail: boolean } }).__gitFixture);

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
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-repository-diff.png") });
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
    await page.screenshot({ animations: "disabled", path: info.outputPath(`git-history-${theme}.png`) });
  }
  await page.setViewportSize({ width: 720, height: 700 }); await expect(comparison).toBeVisible(); await page.screenshot({ animations: "disabled", path: info.outputPath("git-history-narrow.png") });
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
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-agent-mode-return.png") });
  await expect(page.locator(".file-tab[data-git-status='modified']")).toHaveCount(1);
  await expect(page.locator(".cm-git-marker.cm-git-modified")).toHaveCount(2);
  await editor.click(); await editor.press("ControlOrMeta+Home"); await editor.press("ArrowDown");
  await expect(page.getByRole("button", { name: "Git authorship: Fixture author. Open file blame", exact: true })).toBeVisible();
  await editor.press("ControlOrMeta+End"); await page.keyboard.insertText("// unsaved decoration\n"); await editor.press("ArrowUp");
  await expect(page.locator(".cm-git-marker.cm-git-added")).not.toHaveCount(0);
  await expect(page.getByRole("button", { name: "Git authorship: Uncommitted changes. Open file blame", exact: true })).toBeVisible();
  await expect(page.locator(".file-tab .git-path-badge")).toHaveAttribute("title", /unsaved changes/);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.locator("[role='treeitem'][data-git-status='modified']")).not.toHaveCount(0);
  await expect(page.locator(".tree-row .git-path-badge[title*='unsaved changes']")).toBeVisible();
  await page.getByRole("group", { name: "Git change navigation", exact: true }).getByRole("button", { name: "Next Git change", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Git change preview", exact: true });
  await expect(preview).toContainText("const value = 2;"); await expect(preview).toContainText("const value = 3;");
  await preview.getByRole("button", { name: "Next Git change", exact: true }).click();
  await expect(preview).toContainText("const other = 4;");
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-live-decorations.png") });
  await preview.getByRole("button", { name: "Close Git change preview", exact: true }).click();
  await expect(preview).toHaveCount(0); await expect(editor).toContainText("unsaved decoration");
  const result = await trace(page); expect(result.baseline[0].path).toBe("project/src/file.ts"); expect(result.blame[0].path).toBe("project/src/file.ts"); expect(result.diskSaves).toBe(0); expect(errors).toEqual([]);
});

test("six keyboard subviews create a branch, manage local tags and save/apply a stable stash", async ({ page }, info) => {
  const errors = await fixture(page);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  const views = panel.getByRole("tablist", { name: "Source control view", exact: true });
  await expect(views.getByRole("tab")).toHaveCount(6);
  await views.getByRole("tab", { name: "Changes", exact: true }).focus();
  for (const label of ["History", "Branches", "Stash", "Worktrees", "GitHub", "Changes"]) {
    await page.keyboard.press("ArrowRight");
    await expect(views.getByRole("tab", { name: label, exact: true })).toBeFocused();
    await expect(views.getByRole("tab", { name: label, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("tabpanel", { name: label, exact: true })).toBeVisible();
  }
  await page.keyboard.press("End"); await expect(views.getByRole("tab", { name: "GitHub", exact: true })).toBeFocused();
  await page.keyboard.press("Home"); await expect(views.getByRole("tab", { name: "Changes", exact: true })).toBeFocused();
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
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-branch-stash.png") }); expect(errors).toEqual([]);
});

test("worktree removal is explicit and remote failure retains message and unsaved editor draft", async ({ page }, info) => {
  const errors = await fixture(page);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await panel.getByRole("tab", { name: "Worktrees", exact: true }).click();
  const trees = panel.getByRole("region", { name: "Git worktrees", exact: true });
  await expect(trees.getByRole("button", { name: "Remove worktree /fixture/repository", exact: true })).toHaveCount(0);
  await expect(trees.getByRole("button", { name: "Remove worktree /fixture/locked", exact: true })).toHaveCount(0);
  await expect(trees.getByRole("button", { name: "Lock worktree /fixture/repository", exact: true })).toHaveCount(0);
  await expect(trees.locator(".git-worktree-entry").filter({ hasText: "/fixture/repository" })).toContainText("Main");
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
  await expect(panel.locator(".git-network-actions")).not.toHaveAttribute("open", "");
  await panel.locator("summary").filter({ hasText: /^Remote actions$/ }).click();
  await expect(panel.locator("[aria-label=\"Selected remote operations\"]")).toContainText("https://example.test/fixture/repo.git");
  await expect(panel.locator("[aria-label=\"Selected remote operations\"]")).toContainText("Push: https://example.test/fixture/push.git");
  await panel.getByRole("checkbox", { name: "I reviewed this remote and target", exact: true }).check();
  await panel.getByRole("button", { name: "Fetch", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Fixture authentication failed");
  await expect(message).toHaveValue("Keep this commit draft"); await expect(editor).toContainText("keep after remote failure");
  expect((await trace(page)).remotes[0]).toMatchObject({ action: "fetch", expectedConfigFingerprint: "reviewed-config-1" }); expect((await trace(page)).diskSaves).toBe(0);
  await page.evaluate(() => { (window as unknown as { __gitFixture: { remoteConfigChanged: boolean; hosting: any[]; conflictReads: any[]; conflictSaves: any[]; failCreate: boolean; failReview: boolean; failDetail: boolean } }).__gitFixture.remoteConfigChanged = true; });
  await panel.getByRole("checkbox", { name: "I reviewed this remote and target", exact: true }).check();
  await panel.getByRole("button", { name: "Fetch", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Remote configuration changed. Review remotes again.");
  await expect(message).toHaveValue("Keep this commit draft"); await expect(editor).toContainText("keep after remote failure");
  expect((await trace(page)).remotes).toHaveLength(2);
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-remote-failure.png") }); expect(errors).toEqual([]);
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
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-rebase-conflict.png") });
  await editor.click(); await editor.press("ControlOrMeta+a"); await page.keyboard.insertText("const value = 3; // resolved fixture conflict\n");
  await panel.getByRole("button", { name: "Mark project/src/file.ts resolved", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Save or close unsaved files" })).toBeVisible();
  expect((await trace(page)).integration).toHaveLength(1);
  await editor.click(); await editor.press("ControlOrMeta+s");
  await expect.poll(async () => (await trace(page)).diskSaves).toBe(1);
  await panel.getByRole("button", { name: "Mark project/src/file.ts resolved", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Conflict state changed");
  await expect(panel.getByRole("button", { name: "Continue rebase", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Refresh conflict state", exact: true }).click();
  await panel.getByRole("button", { name: "Mark project/src/file.ts resolved", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Continue rebase", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Continue rebase", exact: true }).click();
  await expect(panel).toContainText("Fixture rebase completed."); await expect(panel).not.toContainText("Rebase in progress");
  const actions = (await trace(page)).integration;
  expect(actions).toHaveLength(4); expect(actions[0]).toMatchObject({ command: "git_rebase", targetId: "c".repeat(40), expectedIndexRevision: "index-1" });
  expect(actions[1]).toMatchObject({ command: "git_mark_resolved", expectedIndexRevision: "index-2", expectedWorktreeSnapshot: "disk-2" });
  expect(actions[2]).toMatchObject({ command: "git_mark_resolved", expectedIndexRevision: "index-3", expectedWorktreeSnapshot: "disk-3" });
  expect(actions[3]).toMatchObject({ command: "git_rebase_control", action: "continue", expectedIndexRevision: "index-4", expectedWorktreeSnapshot: "disk-4" }); expect(errors).toEqual([]);
});

test("GitHub forms retain failed drafts, review literal PR patches and check out the pinned head", async ({ page }, info) => {
  const errors = await fixture(page, true);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("tab", { name: "GitHub", exact: true }).click();
  const hosting = panel.getByRole("region", { name: "GitHub", exact: true });
  await expect(hosting).toContainText("Enable Git for this repository"); expect((await trace(page)).hosting).toHaveLength(0);
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await expect(hosting.getByRole("combobox", { name: "GitHub repository", exact: true })).toHaveValue("origin");
  await hosting.getByRole("button", { name: "New pull request", exact: true }).click();
  await hosting.getByLabel("Title", { exact: true }).fill("Keep this pull request draft");
  await hosting.getByLabel("Description", { exact: true }).fill("Unsaved hosted description");
  await hosting.getByRole("button", { name: "Create pull request", exact: true }).click();
  await expect(hosting.getByRole("alert")).toContainText("Fixture create failed");
  await expect(hosting.getByLabel("Title", { exact: true })).toHaveValue("Keep this pull request draft");
  await expect(hosting.getByLabel("Description", { exact: true })).toHaveValue("Unsaved hosted description");
  await expect(hosting.getByRole("checkbox", { name: "Create as draft", exact: true })).toBeChecked();
  expect((await trace(page)).hosting.filter(call => call.command === "github_create_pull_request")).toHaveLength(1);
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-github-create-failure.png") });
  await page.evaluate(() => { (window as any).__gitFixture.failCreate = false; });
  await hosting.getByRole("button", { name: "Create pull request", exact: true }).click();
  await expect(hosting.getByLabel("Title", { exact: true })).toHaveCount(0);
  await hosting.getByRole("button", { name: /Fixture pull request/ }).click();
  await expect(hosting).toContainText("Fixture CI"); await expect(hosting).toContainText("success");
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-github-checks.png") });
  await expect(hosting).toContainText("<script>fixture</script>"); expect(await hosting.locator("script").count()).toBe(0);
  await hosting.locator("summary").filter({ hasText: "Changed files (1)" }).click();
  await hosting.getByRole("button", { name: "Load file patches", exact: true }).click();
  await hosting.locator("summary").filter({ hasText: "project/src/file.ts" }).click();
  await expect(hosting).toContainText("+<script>literal patch</script>"); expect(await hosting.locator("script").count()).toBe(0);
  await hosting.getByLabel("Review message", { exact: true }).fill("Keep this review draft");
  await hosting.getByRole("button", { name: "Review submission", exact: true }).click();
  expect((await trace(page)).hosting.filter(call => call.command === "github_review_pull_request")).toHaveLength(0);
  await hosting.getByRole("button", { name: "Submit review", exact: true }).click();
  await expect(hosting.getByRole("alert")).toContainText("Fixture review failed");
  await expect(hosting.getByLabel("Review message", { exact: true })).toHaveValue("Keep this review draft");
  const beforePoll = (await trace(page)).statusReads;
  await expect.poll(async () => (await trace(page)).statusReads, { timeout: 7000 }).toBeGreaterThan(beforePoll);
  await expect(hosting.getByLabel("Review message", { exact: true })).toHaveValue("Keep this review draft");
  await expect(hosting.getByRole("heading", { name: "Fixture pull request", exact: true })).toBeVisible();
  const calls = (await trace(page)).hosting;
  expect(calls.find(call => call.command === "github_create_pull_request").request).toMatchObject({ title: "Keep this pull request draft", body: "Unsaved hosted description", base: "main", head: "feature/review", draft: true });
  expect(calls.find(call => call.command === "github_review_pull_request").expectedRepository).toEqual({ host: "github.com", owner: "fixture", name: "project", remoteName: "origin" });
  expect(calls.find(call => call.command === "github_review_pull_request").request).toMatchObject({ number: 42, event: "comment", body: "Keep this review draft", expectedHead: "f".repeat(40) });
  expect(calls.find(call => call.request?.kind === "pullRequestFiles").request).toMatchObject({ number: 42, page: 1, expectedHead: "f".repeat(40) });
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-github-review-failure.png") });
  await hosting.getByRole("button", { name: "Check out pull request", exact: true }).click();
  await expect(hosting.getByLabel("New local branch", { exact: true })).toHaveValue("pr/42");
  await hosting.getByRole("button", { name: "Fetch and check out", exact: true }).click();
  await expect(panel.locator(".git-repo-branch")).toContainText("pr/42");
  expect((await trace(page)).checkout[0]).toMatchObject({ command: "git_checkout_pull_request", remoteName: "origin", number: 42, expectedHead: "f".repeat(40), localBranch: "pr/42", expectedIndexRevision: "index-1", expectedConfigFingerprint: "reviewed-config-1" });
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-github-pinned-checkout.png") }); expect(errors).toEqual([]);
});

test("Changes opens the three-way conflict editor and saves its reviewed resolution before Continue", async ({ page }, info) => {
  const errors = await fixture(page, true);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await panel.getByRole("tab", { name: "Branches", exact: true }).click();
  await panel.getByRole("button", { name: "Rebase onto main", exact: true }).click();
  await panel.getByRole("button", { name: "Start rebase", exact: true }).click();
  await panel.getByRole("tab", { name: "Changes", exact: true }).click();
  await panel.getByRole("region", { name: "Working changes", exact: true }).getByRole("button", { name: "Resolve project/src/file.ts", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Resolve conflict: project/src/file.ts", exact: true });
  await expect(dialog.getByLabel("Base source", { exact: true })).toContainText("const value = 1;");
  await expect(dialog.getByLabel("Current (ours) source", { exact: true })).toContainText("const value = 2;");
  await expect(dialog.getByLabel("Incoming (theirs) source", { exact: true })).toContainText("const value = 3;");
  await expect(dialog.getByRole("button", { name: "Mark resolved", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Accept current", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: /Result/ })).toHaveValue("const value = 2;\n");
  await expect(dialog.getByRole("button", { name: "Mark resolved", exact: true })).toBeDisabled();
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-three-way-resolution-draft.png") });
  await dialog.getByRole("button", { name: "Save resolution", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Mark resolved", exact: true })).toBeEnabled();
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-three-way-saved-resolution.png") });
  expect((await trace(page)).conflictSaves[0]).toMatchObject({ path: "project/src/file.ts", content: "const value = 2;\n", expectedIndexRevision: "index-2", expectedWorktreeSnapshot: "disk-2" });
  await dialog.getByRole("button", { name: "Mark resolved", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await trace(page)).integration.at(-1)).toMatchObject({ command: "git_mark_resolved", expectedIndexRevision: "index-3", expectedWorktreeSnapshot: "disk-3" });
  await panel.getByRole("button", { name: "Continue rebase", exact: true }).click();
  await expect(panel).toContainText("Fixture rebase completed.");
  expect((await trace(page)).integration.at(-1)).toMatchObject({ command: "git_rebase_control", action: "continue", expectedIndexRevision: "index-4", expectedWorktreeSnapshot: "disk-4" }); expect(errors).toEqual([]);
});

test("status authorship opens full-file blame with age mapping and commit navigation", async ({ page }, info) => {
  const errors = await fixture(page);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("button", { name: "Enable Git", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Edit file.ts", exact: true });
  await editor.click(); await editor.press("ControlOrMeta+Home"); await editor.press("ArrowDown");
  await page.getByRole("button", { name: "Git authorship: Fixture author. Open file blame", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "File blame", exact: true });
  await expect(dialog).toContainText("Current buffer mapped to HEAD"); await expect(dialog).toContainText("Uncommitted changes");
  await expect(dialog.getByRole("button", { name: "Review commit bbbbbbbb for line 2", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Age heatmap", exact: true }).click();
  await expect(dialog.locator("tr[data-age]")).not.toHaveCount(0);
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-full-file-blame.png") });
  await dialog.getByRole("button", { name: "Review commit bbbbbbbb for line 2", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Git comparison", exact: true })).toContainText("Commit changes");
  expect((await trace(page)).diskSaves).toBe(0); expect(errors).toEqual([]);
});

test("worktrees create a new branch and bind lock and prune actions to metadata reviews", async ({ page }, info) => {
  const errors = await fixture(page, true);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await panel.getByRole("tab", { name: "Worktrees", exact: true }).click();
  const trees = panel.getByRole("region", { name: "Git worktrees", exact: true });
  await trees.getByRole("button", { name: "New", exact: true }).click();
  await trees.getByLabel("Checkout mode", { exact: true }).selectOption("newBranch");
  await trees.getByLabel("New branch name", { exact: true }).fill("feature/fixture-worktree");
  await trees.getByLabel("Absolute folder path", { exact: true }).fill("/fixture/new-worktree");
  await trees.getByRole("button", { name: "Add worktree", exact: true }).click();
  const entry = trees.locator(".git-worktree-entry").filter({ hasText: "/fixture/new-worktree" });
  await expect(entry).toContainText("feature/fixture-worktree");
  expect((await trace(page)).worktrees.find(call => call.command === "git_worktree_create")).toMatchObject({ path: "/fixture/new-worktree", mode: "newBranch", branch: "feature/fixture-worktree", expectedHead: "b".repeat(40) });
  await entry.getByRole("button", { name: "Lock worktree /fixture/new-worktree", exact: true }).click();
  await expect(entry).toContainText("Locked");
  await expect(entry.getByRole("button", { name: "Remove worktree /fixture/new-worktree", exact: true })).toHaveCount(0);
  await expect(entry.getByRole("button", { name: "Unlock worktree /fixture/new-worktree", exact: true })).toBeVisible();
  expect((await trace(page)).worktrees.find(call => call.command === "git_worktree_set_locked")).toMatchObject({ path: "/fixture/new-worktree", locked: true, expectedSnapshot: "worktrees-2" });
  await trees.getByRole("button", { name: "Review stale worktree metadata", exact: true }).click();
  await expect(trees).toContainText("Fixture stale metadata: /fixture/stale");
  expect((await trace(page)).worktrees.filter(call => call.command === "git_worktree_prune")).toHaveLength(0);
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-worktree-prune-review.png") });
  await trees.getByRole("button", { name: "Prune reviewed metadata", exact: true }).click();
  expect((await trace(page)).worktrees.find(call => call.command === "git_worktree_prune")).toMatchObject({ expectedSnapshot: "worktrees-3" });
  await expect(entry).toBeVisible(); expect(errors).toEqual([]);
});

test("GitHub detail failures hide unknown counts and retry the selected PR while retaining review drafts", async ({ page }, info) => {
  const errors = await fixture(page, true);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await panel.getByRole("tab", { name: "GitHub", exact: true }).click();
  const hosting = panel.getByRole("region", { name: "GitHub", exact: true });
  await expect(hosting.getByRole("button", { name: /Fixture pull request/ })).toBeVisible();
  await page.evaluate(() => { (window as any).__gitFixture.failDetail = true; });
  await hosting.getByRole("button", { name: /Fixture pull request/ }).click();
  await expect(hosting.getByRole("alert")).toContainText("Fixture detail read failed");
  await expect(hosting).toContainText("Details are unavailable");
  await expect(hosting.getByRole("heading", { name: "Fixture pull request", exact: true })).toBeVisible();
  await expect(hosting.locator("summary").filter({ hasText: /Checks|Reviews|Conversation|Changed files/ })).toHaveCount(0);
  await expect(hosting).not.toContainText("No checks reported.");
  await expect(hosting.getByRole("button", { name: "Check out pull request", exact: true })).toHaveCount(0);
  await expect(hosting.getByLabel("Review message", { exact: true })).toHaveCount(0);
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-github-details-unavailable.png") });
  await page.evaluate(() => { (window as any).__gitFixture.failDetail = false; });
  await hosting.getByRole("button", { name: "Retry read", exact: true }).click();
  await expect(hosting).toContainText("Fixture CI"); await expect(hosting).toContainText("success");
  expect((await trace(page)).hosting.filter(call => call.command === "github_read").at(-1).request).toEqual({ kind: "pullRequest", number: 42 });
  await expect(hosting.getByRole("button", { name: "Check out pull request", exact: true })).toBeEnabled();
  await hosting.getByLabel("Review the displayed commit", { exact: true }).selectOption("requestChanges");
  await hosting.getByLabel("Review message", { exact: true }).fill("Preserve this draft across failed detail refresh");
  await page.evaluate(() => { (window as any).__gitFixture.failDetail = true; });
  await hosting.getByRole("button", { name: "Refresh GitHub", exact: true }).click();
  await expect(hosting).toContainText("Details are unavailable");
  await expect(hosting.getByLabel("Review message", { exact: true })).toHaveCount(0);
  await expect(hosting.getByRole("button", { name: "Check out pull request", exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__gitFixture.failDetail = false; });
  await hosting.getByRole("button", { name: "Retry read", exact: true }).click();
  await expect(hosting.getByLabel("Review message", { exact: true })).toHaveValue("Preserve this draft across failed detail refresh");
  await expect(hosting.getByLabel("Review the displayed commit", { exact: true })).toHaveValue("requestChanges");
  await expect(hosting.locator("summary").filter({ hasText: "Checks (1)" })).toBeVisible();
  const calls = (await trace(page)).hosting;
  expect(calls.filter(call => call.request?.kind === "pullRequest")).toHaveLength(4);
  expect(calls.filter(call => ["github_create_pull_request", "github_review_pull_request"].includes(call.command))).toHaveLength(0);
  expect((await trace(page)).checkout).toHaveLength(0);
  await hosting.getByLabel("Review message", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-github-detail-retry-draft.png") }); expect(errors).toEqual([]);
});

test("selected remote first push requires review and invalidates it when the target changes", async ({ page }, info) => {
  const errors = await fixture(page, true);
  await page.evaluate(() => { (window as any).__gitFixture.noUpstream = true; });
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await expect(panel.locator(".git-network-actions")).not.toHaveAttribute("open", "");
  await overhaulScreenshot(page, "remote-compact-after");
  await panel.locator("summary").filter({ hasText: /^Remote actions$/ }).click();
  const push = panel.getByRole("button", { name: "Push", exact: true });
  await expect(push).toBeDisabled();
  await panel.getByLabel("Remote", { exact: true }).selectOption("origin");
  await panel.getByLabel("Remote branch (pull or push)", { exact: true }).fill("first-push");
  await panel.getByLabel("I reviewed this remote and target", { exact: true }).check();
  await panel.getByLabel("Remote branch (pull or push)", { exact: true }).fill("published-branch");
  await expect(push).toBeDisabled();
  await page.screenshot({ animations: "disabled", path: info.outputPath("git-first-push-target-review.png") });
  mkdirSync("artifacts/git-overhaul-browser", { recursive: true });
  await page.screenshot({ animations: "disabled", path: "artifacts/git-overhaul-browser/remote-after.png" });
  expect((await trace(page)).remotes).toHaveLength(0);
  await panel.getByLabel("I reviewed this remote and target", { exact: true }).check();
  await push.click();
  await expect(panel).toContainText("Published fixture branch.");
  if (!await panel.locator(".git-network-actions").evaluate(node => (node as HTMLDetailsElement).open)) await panel.locator("summary").filter({ hasText: /^Remote actions$/ }).click();
  await expect(push).toBeDisabled();
  expect((await trace(page)).remotes).toEqual([expect.objectContaining({ action: "push", remoteName: "origin", targetBranch: "published-branch", setUpstream: true, expectedConfigFingerprint: "reviewed-config-1", expectedIndexRevision: "index-1" })]);
  expect(errors).toEqual([]);
});

test("selected lines submit opaque review IDs and preserve a failed selection", async ({ page }) => {
  const errors = await fixture(page);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("button", { name: "Enable Git", exact: true }).click();
  await page.getByRole("button", { name: "Review working changes in project/src/file.ts", exact: true }).click();
  const selection = page.getByRole("region", { name: "Select reviewed Git lines", exact: true });
  await expect(selection.getByRole("button", { name: "Stage selected (0)", exact: true })).toBeDisabled();
  await selection.getByRole("checkbox", { name: "Select added line 1", exact: true }).click();
  await page.evaluate(() => { (window as any).__gitFixture.failLines = true; });
  await selection.getByRole("button", { name: "Stage selected (1)", exact: true }).click();
  await expect(selection.getByRole("alert").filter({ hasText: "Reviewed selected lines changed" })).toBeVisible();
  await expect(selection.getByRole("checkbox", { name: "Select added line 1", exact: true })).toBeChecked();
  expect((await trace(page)).phase3.filter(call => call.command === "git_apply_lines")[0]).toMatchObject({ lineIds: ["opaque-add-1"], includeMetadata: false, expectedIndexRevision: "index-1", expectedWorktreeSnapshot: "disk-1" });
  await page.evaluate(() => { (window as any).__gitFixture.failLines = false; });
  await selection.getByRole("button", { name: "Stage selected (1)", exact: true }).click();
  await expect.poll(async () => (await trace(page)).phase3.filter(call => call.command === "git_apply_lines").length).toBe(2);
  await expect(page.getByRole("region", { name: "Git source control", exact: true })).toContainText("Staged selected changes.");
  await expect(selection.getByRole("button", { name: "Stage selected (0)", exact: true })).toBeDisabled();
  expect((await trace(page)).diskSaves).toBe(0); expect(errors).toEqual([]);
});

test("amend captures HEAD and blocks submission after an external HEAD change", async ({ page }) => {
  const errors = await fixture(page, true);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await panel.getByRole("textbox", { name: "Git commit message", exact: true }).fill("Amended message only");
  await panel.getByLabel("Amend last commit", { exact: true }).check();
  await expect(panel.getByRole("button", { name: "Amend bbbbbbbb", exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).__gitFixture.changeHead = true; });
  await expect(panel.getByRole("alert").filter({ hasText: "HEAD changed after amend was selected" })).toBeVisible({ timeout: 8000 });
  await expect(panel.getByRole("button", { name: "Amend bbbbbbbb", exact: true })).toBeDisabled();
  expect((await trace(page)).phase3.filter(call => call.command === "git_amend")).toHaveLength(0);
  await panel.getByLabel("Amend last commit", { exact: true }).uncheck();
  await panel.getByLabel("Amend last commit", { exact: true }).check();
  await panel.getByRole("button", { name: "Amend cccccccc", exact: true }).click();
  await expect.poll(async () => (await trace(page)).phase3.filter(call => call.command === "git_amend").length).toBe(1);
  expect((await trace(page)).phase3.find(call => call.command === "git_amend")).toMatchObject({ expectedHead: "c".repeat(40), expectedIndexRevision: "index-1", expectedStagedSnapshot: "tree-1", message: "Amended message only" });
  expect(errors).toEqual([]);
});

test("advanced history filters, reflog and revision reads stay read only", async ({ page }) => {
  const errors = await fixture(page);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await panel.getByRole("tab", { name: "History", exact: true }).click();
  await panel.getByRole("button", { name: "Advanced history", exact: true }).click();
  const history = panel.getByRole("region", { name: "Git history", exact: true });
  await history.getByLabel("Author", { exact: true }).fill("Fixture author");
  await history.getByLabel("Message", { exact: true }).fill("Review staged");
  await history.getByLabel("Repository path", { exact: true }).fill("project/src/file.ts");
  await history.getByRole("button", { name: "Search history", exact: true }).click();
  await expect.poll(async () => (await trace(page)).phase3.filter(call => call.command === "git_history_tools").at(-1)?.query.author).toBe("Fixture author");
  expect((await trace(page)).phase3.filter(call => call.command === "git_history_tools").at(-1).query).toMatchObject({ author: "Fixture author", message: "Review staged", path: "project/src/file.ts", heads: [], skip: 0 });
  await history.getByRole("button", { name: "Show HEAD reflog", exact: true }).click();
  await expect(history).toContainText("HEAD@{0}");
  await history.getByRole("button", { name: "aaaaaaaa · Use revision", exact: true }).click();
  await history.locator("summary").filter({ hasText: "Revision content and comparison" }).click();
  await expect(history.getByLabel("Revision", { exact: true })).toHaveValue("a".repeat(40));
  await history.getByRole("button", { name: "Read revision file", exact: true }).click();
  await expect(history.getByLabel("Read-only revision content", { exact: true })).toHaveText("<script>literal revision</script>");
  expect(await history.locator("script").count()).toBe(0);
  await history.getByRole("button", { name: "Compare revisions", exact: true }).click();
  await expect(history).toContainText("Revision comparison");
  expect((await trace(page)).phase3.find(call => call.command === "git_revision_diff")).toMatchObject({ from: "a".repeat(40), to: null, path: "project/src/file.ts" });
  expect((await trace(page)).diskSaves).toBe(0); expect((await trace(page)).commits).toHaveLength(0); expect(errors).toEqual([]);
});

test("no-workspace clone retains failed input without activating repository access", async ({ page }) => {
  const errors = await fixture(page, false, true);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Clone repository", exact: true }).click();
  await panel.getByLabel("Repository URL or local path", { exact: true }).fill("https://example.test/new.git");
  await panel.getByLabel("Absolute destination folder", { exact: true }).fill("/fixture/clone");
  await panel.getByRole("button", { name: "Clone", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Fixture clone failed");
  await expect(panel.getByLabel("Repository URL or local path", { exact: true })).toHaveValue("https://example.test/new.git");
  await expect(panel.getByLabel("Absolute destination folder", { exact: true })).toHaveValue("/fixture/clone");
  expect((await trace(page)).phase3).toEqual([{ command: "git_clone_repository", source: "https://example.test/new.git", destination: "/fixture/clone" }]);
  expect((await trace(page)).enables).toBe(0); expect((await trace(page)).statusReads).toBe(0);
  await page.evaluate(() => { (window as any).__gitFixture.failClone = false; });
  await panel.getByRole("button", { name: "Clone", exact: true }).click();
  await expect.poll(async () => (await trace(page)).phase3.some(call => call.command === "open_workspace" && call.path === "/fixture/clone")).toBe(true);
  await expect(panel.getByRole("button", { name: "Enable Git", exact: true })).toBeVisible();
  expect((await trace(page)).enables).toBe(0); expect(errors).toEqual([]);
});

test("worktree new-window callback uses the backend-validated path without changing this workspace", async ({ page }) => {
  const errors = await fixture(page, true);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  await panel.getByRole("tab", { name: "Worktrees", exact: true }).click();
  await panel.locator(".git-worktree-entry").filter({ hasText: "/fixture/review" }).getByRole("button", { name: "Open in new window", exact: true }).click();
  await expect.poll(async () => (await trace(page)).phase3.length).toBe(2);
  expect((await trace(page)).phase3.map(call => ({ command: call.command, path: call.path }))).toEqual([{ command: "git_worktree_window_path", path: "/fixture/review" }, { command: "git_open_worktree_window", path: "/fixture/review" }]);
  await expect(page.getByRole("textbox", { name: "Edit file.ts", exact: true })).toBeVisible();
  await expect(panel.locator(".git-repo-branch")).toContainText("feature/review"); expect(errors).toEqual([]);
});

async function expectWorkingRailGeometry(marker: Locator, codeLine?: Locator) {
  const geometry = await marker.evaluate(node => {
    const rail = node.querySelector(".cm-git-rail")!;
    const box = node.getBoundingClientRect(), railBox = rail.getBoundingClientRect();
    const row = node.parentElement!.getBoundingClientRect();
    return { tag: node.tagName, width: box.width, height: box.height, railWidth: railBox.width, rowHeight: row.height, top: box.top, rowTop: row.top };
  });
  expect(geometry.tag).toBe("BUTTON");
  expect(geometry.width).toBeCloseTo(12, 1);
  expect(geometry.railWidth).toBeCloseTo(3, 1);
  expect(geometry.height).toBeGreaterThanOrEqual(geometry.rowHeight - 1);
  expect(Math.abs(geometry.top - geometry.rowTop)).toBeLessThanOrEqual(1);
  if (codeLine) {
    const line = (await codeLine.boundingBox())!;
    expect(Math.abs(geometry.top - line.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.height - line.height)).toBeLessThanOrEqual(1);
  }
  await marker.hover();
  expect((await marker.boundingBox())!.width).toBeCloseTo(geometry.width, 1);
}

async function expectAccessibleGitMarker(marker: Locator) {
  await expect(marker).toHaveAccessibleName(/change/);
  expect(await marker.evaluate(node => {
    for (let current: Element | null = node; current; current = current.parentElement) if (current.getAttribute("aria-hidden") === "true") return true;
    return false;
  })).toBe(false);
}

async function overhaulScreenshot(page: Page, name: string) {
  mkdirSync("artifacts/git-overhaul-browser", { recursive: true });
  await page.screenshot({ animations: "disabled", path: `artifacts/git-overhaul-browser/${name}.png` });
}

test("rendered working rails keep their full hit lane and keyboard previews distinguish live and saved changes", async ({ page }) => {
  const errors = await fixture(page);
  const editor = page.getByRole("textbox", { name: "Edit file.ts", exact: true });
  await editor.click(); await editor.press("ControlOrMeta+End"); await page.keyboard.insertText("// unsaved review stays in buffer\n");
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("button", { name: "Enable Git", exact: true }).click();
  const markers = page.locator(".cm-git-gutter:not(.cm-git-staged-gutter) button.cm-git-marker");
  await expect(markers.first()).toBeVisible();
  await expectWorkingRailGeometry(markers.first(), page.locator(".cm-line").first());
  await expect(markers.first()).toHaveAccessibleName(/modified.*Click to review change/);
  await expectAccessibleGitMarker(markers.first());
  await markers.first().focus(); await markers.first().press("Enter");
  const preview = page.getByRole("dialog", { name: "Git change preview", exact: true });
  await expect(preview).toContainText("Index compared with live buffer, including unsaved edits.");
  await expect(preview.locator(".cm-git-preview-before .cm-git-preview-caption")).toHaveText("Index: line 1");
  await expect(preview.locator(".cm-git-preview-after .cm-git-preview-caption")).toHaveText("Live buffer: line 1");
  await expect(preview.locator(".cm-git-preview-number")).toHaveText(["1", "1"]);
  await expect(preview.locator(".cm-git-preview-sign")).toHaveText(["−", "+"]);
  await expect(preview.locator(".cm-git-preview-code")).toHaveText(["const value = 2;", "const value = 3;"]);
  await expect(markers.first()).toHaveAttribute("aria-expanded", "true");
  await expect(markers.first()).toHaveClass(/cm-git-selected/);
  await overhaulScreenshot(page, "working-preview-dark-after");
  await preview.getByRole("button", { name: "Close Git change preview", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0); await expect(editor).toBeFocused();
  await expect(markers.first()).toHaveAttribute("aria-expanded", "false");
  await markers.first().focus(); await markers.first().press("Space");
  await expect(preview).toBeVisible();
  await editor.click({ position: { x: 700, y: 300 } });
  await expect(preview).toHaveCount(0); await expect(editor).toBeFocused();
  await markers.first().focus(); await markers.first().press("Enter");
  await expect(preview).toContainText("Saved comparison excludes unsaved buffer edits.");
  await expect(preview.getByRole("button", { name: /stage/i })).toHaveCount(0);
  await preview.getByRole("button", { name: "Review saved changes", exact: true }).click();
  const comparison = page.getByRole("region", { name: "Git comparison", exact: true });
  await expect(comparison).toContainText("Index compared with working file");
  await expect(comparison).not.toContainText("unsaved review stays in buffer");
  await page.getByRole("tab", { name: "file.ts", exact: true }).click();
  await expect(editor).toContainText("unsaved review stays in buffer");
  expect((await trace(page)).diskSaves).toBe(0); expect((await trace(page)).stage).toHaveLength(0); expect(errors).toEqual([]);
});

test("rendered staged rails review HEAD against index without changing the dirty working buffer", async ({ page }) => {
  const errors = await fixture(page);
  await page.evaluate(() => { (window as any).__gitFixture.stagedBaseline = true; });
  const editor = page.getByRole("textbox", { name: "Edit file.ts", exact: true });
  await editor.click(); await editor.press("ControlOrMeta+End"); await page.keyboard.insertText("// staged review keeps draft\n");
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("button", { name: "Enable Git", exact: true }).click();
  const marker = page.locator("button.cm-git-staged-marker").first();
  await expect(marker).toBeEnabled();
  await expect(marker).toHaveAccessibleName(/Staged modified change, HEAD compared with index/);
  await expectAccessibleGitMarker(marker);
  await expect(marker.locator(".cm-git-rail")).toHaveCount(1);
  await overhaulScreenshot(page, "staged-rail-after");
  await marker.focus(); await marker.press("Enter");
  const comparison = page.getByRole("region", { name: "Git comparison", exact: true });
  await expect(comparison).toContainText("HEAD compared with index");
  await expect(comparison).toContainText("index version");
  await expect(comparison).not.toContainText("staged review keeps draft");
  expect((await trace(page)).diffs.at(-1)).toMatchObject({ path: "project/src/file.ts", side: "staged", expectedIndexRevision: "index-1" });
  await page.getByRole("tab", { name: "file.ts", exact: true }).click();
  await expect(editor).toContainText("staged review keeps draft");
  expect((await trace(page)).diskSaves).toBe(0); expect(errors).toEqual([]);
});

test("working rail geometry follows real light theme, font, wrapping and folding settings at narrow width", async ({ page }) => {
  const errors = await fixture(page);
  await page.evaluate(() => { (window as any).__gitFixture.folds = true; });
  const editor = page.getByRole("textbox", { name: "Edit file.ts", exact: true });
  await editor.click(); await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`function changed() {\n  const longValue = "${"wrapped-content ".repeat(20)}";\n${Array.from({ length: 20 }, (_, index) => `  const extra${index} = ${index};`).join("\n")}\n  return longValue;\n}\n`);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByRole("button", { name: "Enable Git", exact: true }).click();
  const markers = page.locator(".cm-git-gutter:not(.cm-git-staged-gutter) button.cm-git-marker");
  await expect(markers.first()).toBeVisible();
  await expectWorkingRailGeometry(markers.first(), page.locator(".cm-line").first());
  await overhaulScreenshot(page, "geometry-dark-before-settings");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search settings", exact: true });
  await search.fill("theme");
  await page.getByRole("radio", { name: "Light theme", exact: true }).click();
  await expect(page.locator(".ide")).toHaveClass(/theme-light/);
  await search.fill("Editor font size");
  const font = page.getByRole("spinbutton", { name: "Editor font size", exact: true });
  await font.fill("20"); await font.press("Tab");
  await search.fill("Word wrap");
  await page.getByRole("switch", { name: "Word wrap", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Word wrap", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("tab", { name: "file.ts", exact: true }).click();
  await expect(editor).toHaveCSS("font-size", "20px");
  await page.getByRole("button", { name: "Toggle project panel", exact: true }).click();
  await page.setViewportSize({ width: 720, height: 700 });
  await expect(page.locator(".cm-content")).toHaveClass(/cm-lineWrapping/);
  await expectWorkingRailGeometry(markers.first(), page.locator(".cm-line").first());
  const wrappedLine = page.locator(".cm-line").filter({ hasText: "const longValue" });
  expect((await wrappedLine.boundingBox())!.height).toBeGreaterThan(40);
  await expectWorkingRailGeometry(markers.nth(1), wrappedLine);
  await markers.first().click();
  const preview = page.getByRole("dialog", { name: "Git change preview", exact: true });
  await expect(preview).toBeVisible();
  const box = (await preview.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(721);
  await overhaulScreenshot(page, "geometry-light-font20-wrap-narrow-after");
  await preview.getByRole("button", { name: "Close Git change preview", exact: true }).click();
  const scroller = page.locator(".cm-scroller").first();
  await scroller.hover(); await page.mouse.wheel(0, 500);
  await expect.poll(async () => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  await expectAccessibleGitMarker(markers.first());
  await page.mouse.wheel(0, -2000);
  await expect.poll(async () => scroller.evaluate(node => node.scrollTop)).toBe(0);
  const fold = page.locator(".cm-foldGutter .cm-gutterElement").filter({ has: page.locator(".cm-fold-chevron.is-open") }).first();
  await expect(fold).toBeVisible(); await fold.click();
  await expect(page.locator(".cm-foldPlaceholder")).toBeVisible();
  await expectWorkingRailGeometry(markers.first(), page.locator(".cm-line").first());
  await expectAccessibleGitMarker(markers.first());
  await overhaulScreenshot(page, "geometry-light-font20-folded-after");
  await page.locator(".cm-foldPlaceholder").click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(0);
  await expectWorkingRailGeometry(markers.nth(1), wrappedLine);
  await expectAccessibleGitMarker(markers.first());
  expect((await trace(page)).diskSaves).toBe(0); expect(errors).toEqual([]);
});

test("no-remotes summary keeps changes visible and opens management only after Add remote", async ({ page }) => {
  const errors = await fixture(page);
  await page.evaluate(() => { (window as any).__gitFixture.noRemotes = true; });
  await page.getByRole("button", { name: "Git", exact: true }).click();
  const panel = page.getByRole("region", { name: "Git source control", exact: true });
  await panel.getByRole("button", { name: "Enable Git", exact: true }).click();
  const remotes = panel.getByRole("region", { name: "Remotes", exact: true });
  await expect(remotes).toContainText("No remotes configured");
  await expect(remotes.locator(".git-network-actions")).toHaveCount(0);
  await expect(remotes.getByLabel("URL", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "Git commit message", exact: true })).toBeVisible();
  await expect(panel.getByRole("region", { name: "Working changes", exact: true })).toBeVisible();
  await overhaulScreenshot(page, "remote-empty-compact-after");
  await remotes.getByRole("button", { name: "Add remote", exact: true }).click();
  await expect(remotes.getByLabel("Name", { exact: true })).toBeVisible();
  await expect(remotes.getByLabel("URL", { exact: true })).toBeVisible();
  await expect(remotes.locator(".git-network-management")).toHaveAttribute("open", "");
  expect((await trace(page)).remotes).toHaveLength(0); expect(errors).toEqual([]);
});
