import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const properties = JSON.parse(readFileSync("crates/core/settings.schema.json", "utf8")).properties;
const settings = Object.fromEntries(Object.entries(properties as Record<string, { default?: unknown }>).filter(([key, value]) => !key.includes(".") && key !== "$schema" && "default" in value).map(([key, value]) => [key, value.default]));

type Trace = {
  calls: string[];
  listings: string[];
  queries: { root: string; query: string }[];
  opened: string[];
  saves: string[];
  edits: string[];
  delayed: Record<string, (value: { results: { path: string; score: number }[] }) => void>;
};

async function nativeFixture(page: Page) {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(settings => {
    const rootA = "/fixture/workspace-a";
    const rootB = "/fixture/workspace-b";
    let root = rootA;
    let generation = 1;
    let callback = 0;
    let nextDialog = rootB;
    let statusCalls = 0;
    const trace: Trace = { calls: [], listings: [], queries: [], opened: [], saves: [], edits: [], delayed: {} };
    const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}, content`).join("\n");
    const response = (query: string) => {
      const paths = query === "zt" || query === "src/zebra.ts" || query === "src/zebra.ts:9:2"
        ? [{ path: "src/zebra.ts", score: 99 }, { path: "src/alpha.ts", score: 25 }]
        : query === "fresh" ? [{ path: "src/fresh.ts", score: 80 }]
          : query === "oldroot" ? [{ path: "old-root-only.ts", score: 40 }]
            : query === "slow" ? [{ path: "slow-result.ts", score: 50 }]
              : [{ path: "src/alpha.ts", score: 10 }];
      return { workspaceRoot: root, generation, requestId: trace.queries.length, results: paths };
    };
    Object.assign(window, {
      isTauri: true,
      __indexFixture: trace,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++callback,
        unregisterCallback: () => undefined,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          trace.calls.push(command);
          if (command === "get_session") return { workspaceRoot: root, groups: [], activeGroup: 0, markdownViews: {}, panels: { projectWidth: 230, assistantWidth: 350, terminalHeight: 260, projectCollapsed: false, assistantCollapsed: true, terminalCollapsed: true } };
          if (command === "take_startup_requests" || command === "recent_projects" || command === "get_settings_keys_for_scope" || command === "agent_installed" || command === "agent_registry" || command === "agent_presets" || command === "pending_run_approvals" || command === "lsp_status" || command === "sync_native_menu") return [];
          if (command === "run_tools_enabled") return false;
          if (command === "run_configurations") return { workspaceRoot: root, configurations: [], detected: [] };
          if (command === "run_context") return { workspaceRoot: root, workspaceEpoch: generation, runs: [] };
          if (command === "get_settings" || command === "get_settings_for_scope") return settings;
          if (command === "get_settings_jsonc" || command === "get_settings_jsonc_for_scope") return "{}";
          if (command === "open_workspace") { root = args.path as string; generation += 1; statusCalls = 0; return { root, name: root.split("/").at(-1) }; }
          if (command === "check_external_files") return { workspaceRoot: root, revision: 0, directoriesChanged: false, states: [] };
          if (command === "file_index_status") {
            statusCalls += 1;
            return { workspaceRoot: root, generation, status: "scanning", scannedEntries: 20 + statusCalls * 10, indexedFiles: 2 + statusCalls, errorCount: 0, lastError: null, watcherReady: true, watcherError: null };
          }
          if (command === "query_file") {
            const query = String(args.query ?? "");
            trace.queries.push({ root, query });
            if (query === "slow" || query === "stale-query" || (query === "oldroot" && root === rootA)) {
              const requestRoot = root; const requestGeneration = generation;
              return new Promise(resolve => { trace.delayed[query] = value => resolve({ workspaceRoot: requestRoot, generation: requestGeneration, requestId: trace.queries.length, results: value.results }); });
            }
            return response(query);
          }
          if (command === "list_files") { return []; }
          if (command === "list_directory") {
            const path = String(args.path ?? ""); trace.listings.push(path);
            if (!path) return [{ path: "src", name: "src", isDir: true }, { path: "README.md", name: "README.md", isDir: false }];
            if (path === "src") return [{ path: "src/zebra.ts", name: "zebra.ts", isDir: false }, { path: "src/alpha.ts", name: "alpha.ts", isDir: false }];
            return [];
          }
          if (command === "peek_buffer") return { path: String(args.path), text, revision: 0, savedRevision: 0, language: "typescript" };
          if (command === "open_buffer") { const path = String(args.path); trace.opened.push(path); return { path, text, revision: 0, savedRevision: 0, language: "typescript" }; }
          if (command === "edit_buffer_delta") { const path = String(args.path); trace.edits.push(path); return { path, revision: Number(args.expectedRevision) + 1, savedRevision: Number(args.expectedRevision) }; }
          if (command === "save_buffer") { const path = String(args.path); trace.saves.push(path); const revision = Number(args.expectedRevision); return { path, text, revision, savedRevision: revision, language: "typescript" }; }
          if (command === "native_window_state") return { fullscreen: false, maximized: false, hasNativeTrafficLights: false };
          if (command === "plugin:dialog|open") return nextDialog;
          if (["plugin:event|listen", "plugin:event|unlisten", "plugin:webview|set_webview_zoom", "save_session"].includes(command)) return ++callback;
          throw new Error(`Unsupported explicit index fixture command: ${command}`);
        },
      },
      __setNextIndexDialog: (path: string) => { nextDialog = path; },
    });
  }, settings);
  return pageErrors;
}

const trace = (page: Page) => page.evaluate(() => (window as unknown as { __indexFixture: Trace }).__indexFixture);

test("native IPC shows root/progress before full scan, preserves fuzzy order, completes Tab and navigates to line:column without save rescans", async ({ page }) => {
  const pageErrors = await nativeFixture(page);
  await page.goto("/");
  await expect(page.getByRole("main", { name: "span editor", exact: true })).toHaveAttribute("aria-busy", "false");
  expect(pageErrors).toEqual([]);
  const tree = page.getByRole("tree", { name: "Workspace files", exact: true });
  await expect(tree.getByRole("treeitem", { name: /src/ })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: /README\.md/ })).toBeVisible();
  await expect(page.locator(".file-index-status")).toContainText("Indexing files…");
  expect((await trace(page)).calls).not.toContain("list_files");

  await page.getByRole("button", { name: "Open quick open", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Goto", exact: true });
  const input = dialog.getByRole("combobox", { name: "Find a file", exact: true });
  await input.fill("zt");
  const options = dialog.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("zebra.ts");
  await expect(options.nth(1)).toContainText("alpha.ts");
  await input.press("Tab");
  await expect(input).toHaveValue("src/zebra.ts");

  await input.fill("src/zebra.ts:9:2");
  await expect(options.first()).toContainText("zebra.ts");
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("footer.statusbar .status-right > span").first()).toHaveText("9:2");
  expect((await trace(page)).opened).toContain("src/zebra.ts");

  const before = await trace(page);
  const listingCount = before.listings.length;
  const fullScanCount = before.calls.filter(call => call === "list_files").length;
  const editor = page.getByRole("textbox", { name: "Edit zebra.ts", exact: true });
  await editor.click(); await editor.press("ControlOrMeta+End"); await page.keyboard.insertText("\n// save without rescanning");
  await expect.poll(async () => (await trace(page)).edits).toContain("src/zebra.ts");
  await editor.press("ControlOrMeta+s");
  await expect.poll(async () => (await trace(page)).saves).toContain("src/zebra.ts");
  const after = await trace(page);
  expect(after.calls.filter(call => call === "list_files")).toHaveLength(fullScanCount);
  expect(after.listings).toHaveLength(listingCount);
  expect(pageErrors).toEqual([]);
});

test("slow indexed queries survive progress updates and stale query/workspace results are discarded", async ({ page }) => {
  const pageErrors = await nativeFixture(page);
  await page.goto("/");
  await expect(page.getByRole("main", { name: "span editor", exact: true })).toHaveAttribute("aria-busy", "false");
  expect(pageErrors).toEqual([]);
  await page.getByRole("button", { name: "Open quick open", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Goto", exact: true });
  const input = dialog.getByRole("combobox", { name: "Find a file", exact: true });

  await input.fill("slow");
  await expect.poll(async () => (await trace(page)).queries.filter(item => item.query === "slow").length).toBe(1);
  await expect.poll(async () => page.locator(".goto-index-status").textContent()).toContain("entries scanned");
  const sampledStatusCalls = (await trace(page)).calls.filter(call => call === "file_index_status").length;
  await expect.poll(async () => (await trace(page)).calls.filter(call => call === "file_index_status").length).toBeGreaterThan(sampledStatusCalls);
  expect((await trace(page)).queries.filter(item => item.query === "slow")).toHaveLength(1);
  await page.evaluate(() => (window as unknown as { __indexFixture: Trace }).__indexFixture.delayed.slow({ results: [{ path: "slow-result.ts", score: 50 }] }));
  await expect(dialog.getByRole("option").first()).toContainText("slow-result.ts");

  await input.fill("stale-query");
  await expect.poll(async () => (await trace(page)).queries.filter(item => item.query === "stale-query").length).toBe(1);
  await input.fill("fresh");
  await expect(dialog.getByRole("option").first()).toContainText("fresh.ts");
  await page.evaluate(() => (window as unknown as { __indexFixture: Trace }).__indexFixture.delayed["stale-query"]({ results: [{ path: "stale-query-only.ts", score: 99 }] }));
  await expect(dialog.getByRole("option").filter({ hasText: "stale-query-only.ts" })).toHaveCount(0);
  await expect(dialog.getByRole("option").first()).toContainText("fresh.ts");

  await input.fill("oldroot");
  await expect.poll(async () => (await trace(page)).queries.filter(item => item.query === "oldroot").length).toBe(1);
  await page.evaluate(() => (window as unknown as { __setNextIndexDialog: (path: string) => void }).__setNextIndexDialog("/fixture/workspace-b"));
  await dialog.getByRole("button", { name: "Open folder…", exact: true }).click();
  await expect.poll(async () => page.locator(".file-index-status").textContent()).toContain("Indexing files…");
  await expect(page.locator(".tree-root strong")).toHaveText("workspace-b");
  await page.getByRole("button", { name: "Open quick open", exact: true }).click();
  await input.fill("oldroot");
  await expect(dialog.getByRole("option").first()).toContainText("old-root-only.ts");
  await page.evaluate(() => (window as unknown as { __indexFixture: Trace }).__indexFixture.delayed.oldroot({ results: [{ path: "stale-old-root.ts", score: 99 }] }));
  await expect(dialog.getByRole("option").filter({ hasText: "stale-old-root.ts" })).toHaveCount(0);
  await expect(dialog.getByRole("option").first()).toContainText("old-root-only.ts");
  expect((await trace(page)).queries.filter(item => item.query === "oldroot")[0].root).toBe("/fixture/workspace-a");
  expect((await trace(page)).calls).toContain("plugin:event|unlisten");
  expect((await trace(page)).calls).not.toContain("list_files");
  expect(pageErrors).toEqual([]);
});
