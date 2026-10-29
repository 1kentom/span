import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Explicit browser IPC fixture. It never starts Java or executes a command.
const properties = JSON.parse(readFileSync("crates/core/settings.schema.json", "utf8")).properties;
const settings = Object.fromEntries(Object.entries(properties as Record<string, { default?: unknown }>).filter(([key, value]) => !key.includes(".") && key !== "$schema" && "default" in value).map(([key, value]) => [key, value.default]));
const root = "/fixture/workspace";
const sourcePath = "src/main/java/com/kentom/todo/new-file.java";
const configuration = { id: "current-file", name: "Run new-file.java", executable: "java", args: ["./src/main/java/com/kentom/todo/new-file.java"], cwd: ".", env: {} };
type Trace = { calls: string[]; opened: string[]; edits: { path: string; revision: number; changes: unknown[] }[]; saves: { path: string; revision: number; text: string }[]; runs: { path: string; expectedWorkspaceRoot: string }[]; output: { kind: string; text?: string; stream?: string }[]; text: string; revision: number; savedRevision: number; javaAvailable: boolean };

async function fixture(page: Page, javaAvailable = true) {
  await page.addInitScript(({ settings, javaAvailable, root, sourcePath, configuration }) => {
    let callback = 0;
    const trace: Trace = { calls: [], opened: [], edits: [], saves: [], runs: [], output: [], text: "class Test {\n  public static void main(String[] args) {\n    System.out.println(\"Hello World\");\n  }\n}\n", revision: 0, savedRevision: 0, javaAvailable };
    const tools = javaAvailable ? [
      { id: "java", name: "Java", program: "java", path: "/jdk/bin/java", version: 'openjdk version "21.0.2"', available: true, kind: "java" },
      { id: "javac", name: "Java compiler", program: "javac", path: "/jdk/bin/javac", version: "21.0.2", available: true, kind: "javac" },
    ] : [];
    Object.assign(window, { isTauri: true, __javaRunFixture: trace, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++callback, unregisterCallback: () => undefined,
      invoke: async (command: string, args: Record<string, any> = {}) => {
        trace.calls.push(command);
        if (command === "get_session") return { workspaceRoot: root, groups: [{ paths: [sourcePath], activePath: sourcePath }], activeGroup: 0, markdownViews: {}, panels: { projectWidth: 230, assistantWidth: 350, terminalHeight: 260, projectCollapsed: false, assistantCollapsed: true, terminalCollapsed: true } };
        if (["take_startup_requests", "recent_projects", "get_settings_keys_for_scope", "agent_installed", "agent_registry", "agent_presets", "pending_run_approvals", "sync_native_menu", "lsp_status"].includes(command)) return [];
        if (command === "get_settings" || command === "get_settings_for_scope") return settings;
        if (command === "get_settings_jsonc" || command === "get_settings_jsonc_for_scope") return "{}";
        if (command === "run_tools_enabled") return false;
        if (command === "open_workspace") return { root, name: "Java run fixture" };
        if (command === "file_index_status") return { workspaceRoot: root, generation: 1, status: "ready", scannedEntries: 1, indexedFiles: 1, errorCount: 0, lastError: null, watcherReady: true, watcherError: null };
        if (command === "query_file") return { workspaceRoot: root, generation: 1, requestId: 1, results: [{ path: sourcePath, name: "new-file.java", isDir: false }] };
        if (command === "git_context") return { workspaceRoot: root, enabled: false, repository: { id: "java-run-fixture", root, workspacePrefix: "", branch: "fixture", head: null, detached: false, unborn: true }, unavailableReason: null };
        if (command === "list_tools") return tools;
        if (command === "run_configurations") return { workspaceRoot: root, configurations: [], detected: [] };
        if (command === "current_file_run") return { path: sourcePath, configuration: javaAvailable ? configuration : null, reason: javaAvailable ? null : "JDK required" };
        if (command === "run_context") return { workspaceRoot: root, workspaceEpoch: 1, runs: [] };
        if (command === "list_directory") return args.path ? [] : [{ path: "src", name: "src", isDir: true }];
        if (command === "list_files") return [{ path: sourcePath, name: "new-file.java", isDir: false }];
        if (command === "open_buffer") { trace.opened.push(String(args.path)); return { path: sourcePath, text: trace.text, revision: trace.revision, savedRevision: trace.savedRevision, language: "java" }; }
        if (command === "edit_buffer_delta") {
          const changes = args.changes as { from: number; to: number; insert: string }[];
          for (const change of [...changes].reverse()) trace.text = trace.text.slice(0, change.from) + change.insert + trace.text.slice(change.to);
          trace.revision = Number(args.expectedRevision) + 1;
          trace.edits.push({ path: String(args.path), revision: trace.revision, changes });
          return { path: String(args.path), revision: trace.revision, savedRevision: trace.savedRevision };
        }
        if (command === "save_buffer") {
          trace.savedRevision = Number(args.expectedRevision);
          trace.saves.push({ path: String(args.path), revision: trace.savedRevision, text: trace.text });
          return { path: String(args.path), text: trace.text, revision: trace.revision, savedRevision: trace.savedRevision, language: "java" };
        }
        if (command === "start_current_file_run") {
          trace.runs.push({ path: String(args.path), expectedWorkspaceRoot: String(args.expectedWorkspaceRoot) });
          const id = `fixture-run-${trace.runs.length}`;
          const event = { kind: "output", id, sequence: 1, workspaceEpoch: 1, stream: "stdout", text: "Hello World\n" };
          trace.output.push(event);
          args.onEvent?.onmessage?.(event);
          return { id, configurationId: configuration.id, workspaceEpoch: 1, name: configuration.name, status: "running", exitCode: null, error: null };
        }
        if (command === "acknowledge_run") return null;
        if (command === "native_window_state") return { fullscreen: false, maximized: false, hasNativeTrafficLights: false };
        if (["plugin:event|listen", "plugin:event|unlisten", "plugin:webview|set_webview_zoom", "save_session"].includes(command)) return ++callback;
        throw new Error(`Unsupported explicit Java run fixture command: ${command}`);
      },
    } });
  }, { settings, javaAvailable, root, sourcePath, configuration });
}

const trace = (page: Page) => page.evaluate(() => (window as unknown as { __javaRunFixture: Trace }).__javaRunFixture);

test("Java main gutter button runs only on user action through the shared current-file runner", async ({ page }, testInfo) => {
  await fixture(page);
  await page.goto("/");
  const run = page.getByRole("button", { name: "Run Java main", exact: true });
  await expect(run).toBeVisible();
  await expect.poll(async () => (await trace(page)).calls).toContain("list_tools");
  expect((await trace(page)).runs).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("java-gutter-standalone-fixture.png") });
  await run.focus();
  await expect(run).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await trace(page)).runs.length).toBe(1);
  expect((await trace(page)).runs[0]).toEqual({ path: sourcePath, expectedWorkspaceRoot: root });
  const output = page.getByRole("region", { name: "Run output", exact: true });
  await expect(output).toBeVisible();
  await expect(output).toContainText("Hello World");
  await expect.poll(async () => (await trace(page)).output.length).toBeGreaterThan(0);
  expect((await trace(page)).runs).toHaveLength(1);
});

test("dirty Java source prompts before run, Cancel preserves it, Save and Run saves before dispatch", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Edit new-file.java", exact: true });
  await expect(editor).toBeVisible();
  await editor.click(); await editor.press("ControlOrMeta+End"); await page.keyboard.insertText("// local change\n");
  await expect.poll(async () => (await trace(page)).edits.length).toBeGreaterThan(0);
  const run = page.getByRole("button", { name: "Run Java main", exact: true });
  await run.click();
  const dialog = page.getByRole("dialog", { name: "Save Java source before running", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await trace(page)).runs).toEqual([]);
  expect((await trace(page)).saves).toEqual([]);
  await run.click();
  await dialog.getByRole("button", { name: "Save and Run", exact: true }).click();
  await expect.poll(async () => (await trace(page)).runs.length).toBe(1);
  const state = await trace(page);
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0].path).toBe(sourcePath);
  expect(state.saves[0].text).toContain("// local change");
  expect(state.runs[0]).toEqual({ path: sourcePath, expectedWorkspaceRoot: root });
  expect(state.calls.lastIndexOf("save_buffer")).toBeLessThan(state.calls.lastIndexOf("start_current_file_run"));
  await expect(page.getByRole("region", { name: "Run output", exact: true })).toContainText("Hello World");
});

test("Java gutter stays inert without detected JDK tools", async ({ page }) => {
  await fixture(page, false);
  await page.goto("/");
  await expect.poll(async () => (await trace(page)).calls).toContain("list_tools");
  await expect(page.getByRole("button", { name: "Run Java main", exact: true })).toHaveCount(0);
  expect((await trace(page)).runs).toEqual([]);
});
