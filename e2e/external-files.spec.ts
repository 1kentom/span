import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Explicit browser IPC fixture. It simulates watcher and buffer transport; it never reads or writes real files.
const properties = JSON.parse(readFileSync("crates/core/settings.schema.json", "utf8")).properties;
const defaultSettings = Object.fromEntries(Object.entries(properties as Record<string, { default?: unknown }>).filter(([key, value]) => !key.includes(".") && key !== "$schema" && "default" in value).map(([key, value]) => [key, value.default]));
const ROOT = "/fixture/external-files";
const PATH = "notes.txt";
type TextBuffer = { text: string; revision: number; savedRevision: number };
type CheckCall = { checks: { path: string; expectedRevision: number; allowReload: boolean }[]; sinceRevision: number | null; expectedWorkspaceRoot: string };
type ResolutionCall = { path: string; expectedRevision: number; reviewedDiskToken: string; resolution: "reload" | "overwrite"; expectedWorkspaceRoot: string };
type Trace = { calls: string[]; listings: string[]; opened: string[]; edits: { expectedRevision: number; changes: { from: number; to: number; insert: string }[] }[]; saves: string[]; checks: CheckCall[]; resolutions: ResolutionCall[]; diskText: string; baselineText: string; buffer: TextBuffer; watcherRevision: number; tokenRevision: number };

async function installFixture(page: Page) {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(({ defaults, root, path }) => {
    let callback = 0;
    let diskText = "saved\n";
    let baselineText = diskText;
    let watcherRevision = 0;
    let tokenRevision = 0;
    let buffer: TextBuffer = { text: "saved\n", revision: 0, savedRevision: 0 };
    const trace: Trace = { calls: [], listings: [], opened: [], edits: [], saves: [], checks: [], resolutions: [], diskText, baselineText, buffer, watcherRevision, tokenRevision };
    const token = () => `disk-${tokenRevision}-${diskText.length}`;
    const snapshot = () => ({ path, text: buffer.text, revision: buffer.revision, savedRevision: buffer.savedRevision, language: "text" });
    Object.assign(window, {
      isTauri: true,
      __externalFileFixture: trace,
      __changeExternalDisk: (text: string) => { diskText = text; watcherRevision += 1; tokenRevision += 1; trace.diskText = diskText; trace.watcherRevision = watcherRevision; trace.tokenRevision = tokenRevision; },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++callback,
        unregisterCallback: () => undefined,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          trace.calls.push(command);
          if (command === "take_startup_requests" || command === "recent_projects" || command === "get_settings_keys_for_scope" || command === "agent_installed" || command === "agent_registry" || command === "agent_presets" || command === "pending_run_approvals" || command === "sync_native_menu" || command === "lsp_status") return [];
          if (command === "get_settings" || command === "get_settings_for_scope") return { ...defaults, autoSave: "off" };
          if (command === "get_settings_jsonc" || command === "get_settings_jsonc_for_scope") return "{}";
          if (command === "get_session") return { workspaceRoot: root, groups: [{ paths: [path], activePath: path }], activeGroup: 0, markdownViews: {}, panels: { projectWidth: 230, assistantWidth: 350, terminalHeight: 260, projectCollapsed: false, assistantCollapsed: true, terminalCollapsed: true } };
          if (command === "workspace_trust_state") return { decision: "trusted", inherited: false, source: root, needsPrompt: false, reason: null, buildFiles: [] };
          if (command === "open_workspace") return { root, name: "External file fixture" };
          if (command === "file_index_status") return { workspaceRoot: root, generation: 1, status: "ready", scannedEntries: 1, indexedFiles: 1, errorCount: 0, lastError: null, watcherReady: true, watcherError: null };
          if (command === "git_context") return { workspaceRoot: root, enabled: false, repository: { id: "external-file-fixture", root, workspacePrefix: "", branch: "fixture", head: null, detached: false, unborn: true }, unavailableReason: null };
          if (command === "run_tools_enabled") return false;
          if (command === "run_configurations") return { workspaceRoot: root, configurations: [], detected: [] };
          if (command === "run_context") return { workspaceRoot: root, workspaceEpoch: 1, runs: [] };
          if (command === "list_directory") { const folder = String(args.path ?? ""); trace.listings.push(folder); return folder ? [] : [{ path, name: "notes.txt", isDir: false }]; }
          if (command === "list_files") return [{ path, name: "notes.txt", isDir: false }];
          if (command === "query_file") return { workspaceRoot: root, generation: 1, requestId: 1, results: [{ path, score: 1 }] };
          if (command === "open_buffer") { trace.opened.push(String(args.path)); return snapshot(); }
          if (command === "edit_buffer_delta") {
            const changes = args.changes as { from: number; to: number; insert: string }[];
            for (const change of [...changes].reverse()) buffer.text = buffer.text.slice(0, change.from) + change.insert + buffer.text.slice(change.to);
            buffer.revision = Number(args.expectedRevision) + 1;
            trace.edits.push({ expectedRevision: Number(args.expectedRevision), changes }); trace.buffer = { ...buffer };
            return { path: String(args.path), revision: buffer.revision, savedRevision: buffer.savedRevision };
          }
          if (command === "save_buffer") { trace.saves.push(String(args.path)); buffer.savedRevision = Number(args.expectedRevision); trace.buffer = { ...buffer }; return snapshot(); }
          if (command === "check_external_files") {
            const call: CheckCall = { checks: args.checks, sinceRevision: args.sinceRevision ?? null, expectedWorkspaceRoot: String(args.expectedWorkspaceRoot) };
            trace.checks.push(call);
            const changed = call.sinceRevision !== watcherRevision;
            const states: Record<string, unknown>[] = [];
            if (changed) for (const check of call.checks) {
              if (check.expectedRevision !== buffer.revision) { states.push({ path: check.path, revision: check.expectedRevision, kind: "stale", snapshot: null, disk: null, error: null }); continue; }
              if (diskText === baselineText) { states.push({ path: check.path, revision: check.expectedRevision, kind: "unchanged", snapshot: null, disk: null, error: null }); continue; }
              const disk = { token: token(), exists: true, text: diskText, truncated: false };
              if (check.allowReload && buffer.revision === buffer.savedRevision) {
                buffer = { text: diskText, revision: buffer.revision + 1, savedRevision: buffer.revision + 1 };
                baselineText = diskText; trace.buffer = { ...buffer }; trace.baselineText = baselineText;
                states.push({ path: check.path, revision: check.expectedRevision, kind: "reloaded", snapshot: snapshot(), disk, error: null });
              } else states.push({ path: check.path, revision: check.expectedRevision, kind: "conflict", snapshot: null, disk, error: null });
            }
            trace.diskText = diskText; trace.watcherRevision = watcherRevision;
            return { workspaceRoot: root, revision: watcherRevision, directoriesChanged: changed, states };
          }
          if (command === "resolve_external_file") {
            const call: ResolutionCall = { path: String(args.path), expectedRevision: Number(args.expectedRevision), reviewedDiskToken: String(args.reviewedDiskToken), resolution: args.resolution, expectedWorkspaceRoot: String(args.expectedWorkspaceRoot) };
            trace.resolutions.push(call);
            if (call.expectedWorkspaceRoot !== root || call.expectedRevision !== buffer.revision) throw new Error("Stale buffer revision");
            if (call.reviewedDiskToken !== token()) throw new Error("File changed on disk. Reload or compare before saving: notes.txt");
            if (call.resolution === "reload") {
              buffer = { text: diskText, revision: buffer.revision + 1, savedRevision: buffer.revision + 1 };
            } else {
              diskText = buffer.text; baselineText = diskText; buffer.savedRevision = buffer.revision; watcherRevision += 1; tokenRevision += 1;
            }
            trace.diskText = diskText; trace.baselineText = baselineText; trace.buffer = { ...buffer }; trace.watcherRevision = watcherRevision; trace.tokenRevision = tokenRevision;
            return snapshot();
          }
          if (command === "native_window_state") return { fullscreen: false, maximized: false, hasNativeTrafficLights: false };
          if (command === "plugin:event|listen") return ++callback;
          if (["plugin:event|unlisten", "plugin:webview|set_webview_zoom", "save_session", "buffer_released"].includes(command)) return null;
          throw new Error(`Unsupported external file IPC fixture command: ${command}`);
        },
      },
    });
  }, { defaults: defaultSettings, root: ROOT, path: PATH });
  return pageErrors;
}

type FixtureWindow = Window & { __externalFileFixture: Trace; __changeExternalDisk: (text: string) => void };
const trace = (page: Page) => page.evaluate(() => (window as FixtureWindow).__externalFileFixture);
const changeDisk = (page: Page, text: string) => page.evaluate(value => (window as FixtureWindow).__changeExternalDisk(value), text);
async function waitForExternalBanner(page: Page) {
  await expect(page.getByRole("status").filter({ hasText: "changed on disk" })).toBeVisible({ timeout: 8_000 });
}
async function waitForDiskVersionCheck(page: Page, version: number) {
  await expect.poll(async () => (await trace(page)).checks.some(call => call.sinceRevision === version - 1), { timeout: 8_000 }).toBe(true);
}

test("clean external change reloads the editor and refreshes the root listing without saving", async ({ page }) => {
  const pageErrors = await installFixture(page);
  await page.goto("/");
  const editor = page.locator(".source-view:visible .cm-content");
  await expect(editor).toHaveText("saved");
  await expect.poll(async () => (await trace(page)).listings.filter(path => path === "").length).toBeGreaterThan(0);
  const listingsBefore = (await trace(page)).listings.filter(path => path === "").length;
  await changeDisk(page, "changed outside editor\n");
  await expect(editor).toHaveText("changed outside editor", { timeout: 8_000 });
  await expect.poll(async () => (await trace(page)).listings.filter(path => path === "").length).toBeGreaterThan(listingsBefore);
  expect((await trace(page)).saves).toEqual([]);
  expect((await trace(page)).resolutions).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("dirty editor draft survives review and Keep Editing until the user explicitly overwrites disk", async ({ page }, testInfo) => {
  const pageErrors = await installFixture(page);
  await page.goto("/");
  const editor = page.locator(".source-view:visible .cm-content");
  await expect(editor).toHaveText("saved");
  await editor.click(); await editor.press("ControlOrMeta+End"); await page.keyboard.insertText("local draft\n");
  await expect.poll(async () => (await trace(page)).edits.length).toBeGreaterThan(0);
  await changeDisk(page, "disk version\n");
  await waitForExternalBanner(page);
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Compare external file changes", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("local draft");
  await expect(dialog).toContainText("disk version");
  await page.screenshot({ path: testInfo.outputPath("external-comparison-fixture.png") });
  await dialog.getByRole("button", { name: "Keep Editing", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await trace(page)).resolutions).toEqual([]);
  await expect(editor).toContainText("local draft");

  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const secondDialog = page.getByRole("dialog", { name: "Compare external file changes", exact: true });
  await secondDialog.getByRole("button", { name: "Overwrite Disk", exact: true }).click();
  await expect(secondDialog).toHaveCount(0);
  const state = await trace(page);
  expect(state.resolutions).toHaveLength(1);
  expect(state.resolutions[0].resolution).toBe("overwrite");
  expect(state.resolutions[0].reviewedDiskToken).toBe("disk-1-13");
  expect(state.diskText).toContain("local draft");
  expect(state.saves).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("disk changes during Compare keep the reviewed token frozen and reject stale overwrite without losing the draft", async ({ page }) => {
  const pageErrors = await installFixture(page);
  await page.goto("/");
  const editor = page.locator(".source-view:visible .cm-content");
  await expect(editor).toHaveText("saved");
  await editor.click(); await editor.press("ControlOrMeta+End"); await page.keyboard.insertText("preserve this draft\n");
  await expect.poll(async () => (await trace(page)).edits.length).toBeGreaterThan(0);
  await changeDisk(page, "reviewed disk version\n");
  await waitForExternalBanner(page);
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Compare external file changes", exact: true });
  await expect(dialog).toContainText("reviewed disk version");
  await changeDisk(page, "new disk version\n");
  await waitForDiskVersionCheck(page, 2);
  await expect(dialog).toContainText("reviewed disk version");
  await dialog.getByRole("button", { name: "Overwrite Disk", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("File changed on disk");
  expect((await trace(page)).resolutions).toHaveLength(1);
  expect((await trace(page)).resolutions[0].reviewedDiskToken).toBe("disk-1-22");
  expect((await trace(page)).resolutions[0].reviewedDiskToken).not.toBe("disk-2-17");
  await expect(editor).toContainText("preserve this draft");
  expect((await trace(page)).diskText).toBe("new disk version\n");

  await dialog.getByRole("button", { name: "Refresh comparison", exact: true }).click();
  await expect(dialog).toContainText("new disk version");
  expect((await trace(page)).resolutions).toHaveLength(1);
  await expect(editor).toContainText("preserve this draft");
  expect((await trace(page)).saves).toEqual([]);
  expect(pageErrors).toEqual([]);
});
