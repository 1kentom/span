import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const properties = JSON.parse(readFileSync("crates/core/settings.schema.json", "utf8")).properties;
const settings = Object.fromEntries(Object.entries(properties as Record<string, { default?: unknown }>).filter(([key, value]) => !key.includes(".") && key !== "$schema" && "default" in value).map(([key, value]) => [key, value.default]));
// Explicit browser IPC fixture only. No subprocess or shell is started by this suite.
async function fixture(page: Page) {
  await page.addInitScript(settings => {
    let next = 1; let callback = 0; let allowed = false;
    const callbacks = new Map<number, (value: any) => void>(); const listeners = new Map<string, number[]>();
    const root = "/fixture/run-workspace";
    const saved = [{ id: "application", name: "Application", executable: "node", args: ["app.js"], cwd: ".", env: { PORT: "3000" } }];
    const detected = [{ configuration: { id: "detected:test", name: "npm test", executable: "npm", args: ["test"], cwd: ".", env: {} }, source: "package.json" }];
    const runs: any[] = []; const channels = new Map<string, any>(); const output = new Map<string, string>();
    const trace = { starts: [] as any[], stops: [] as string[], saves: [] as any[], approvals: [] as any[], enabled: [] as boolean[] };
    const emit = (name: string, payload: any) => (listeners.get(name) || []).forEach(id => callbacks.get(id)?.({ event: name, id: 1, payload }));
    const state = (run: any) => channels.get(run.id)?.onmessage({ kind: "state", run });
    Object.assign(window, { isTauri: true, __runFixture: { trace, emit, request: (pending: any[]) => emit("run-approvals-changed", { pending }) }, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: (fn: (value: any) => void) => { const id = ++callback; callbacks.set(id, fn); return id; }, unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === "get_session") return { workspaceRoot: root, groups: [{ paths: ["README.md"], activePath: "README.md" }], activeGroup: 0, markdownViews: {}, panels: { projectWidth: 230, assistantWidth: 350, terminalHeight: 250, projectCollapsed: false, assistantCollapsed: true, terminalCollapsed: true } };
        if (command === "get_settings" || command === "get_settings_for_scope") return { ...settings };
        if (command === "get_settings_jsonc" || command === "get_settings_jsonc_for_scope") return "{}";
        if (["take_startup_requests", "recent_projects", "get_settings_keys_for_scope", "agent_installed", "sync_native_menu", "pending_run_approvals"].includes(command)) return [];
        if (command === "run_tools_enabled") return allowed;
        if (command === "run_tools_set_enabled") { allowed = args.enabled; trace.enabled.push(allowed); return null; }
        if (command === "run_configurations") return { workspaceRoot: root, configurations: structuredClone(saved), detected: structuredClone(detected) };
        if (command === "run_context") return { workspaceRoot: root, workspaceEpoch: 1, runs: structuredClone(runs) };
        if (command === "save_run_configuration") { if (args.expectedWorkspaceRoot !== root) throw new Error("Workspace changed"); const value = structuredClone(args.configuration); if (value.cwd === "../outside") throw new Error("Working directory is outside workspace"); if (!value.id) value.id = `new-${++next}`; const index = saved.findIndex(entry => entry.id === value.id); if (index >= 0) saved[index] = value; else saved.push(value); trace.saves.push(value); return value; }
        if (command === "duplicate_run_configuration") { const value = [...saved, ...detected.map(task => task.configuration)].find(value => value.id === args.id)!; const copy = { ...value, id: `copy-${++next}`, name: `${value.name} copy` }; saved.push(copy); return copy; }
        if (command === "delete_run_configuration") { const index = saved.findIndex(value => value.id === args.id); if (index >= 0) saved.splice(index, 1); return null; }
        if (command === "start_run" || command === "restart_run") { const configuration = command === "start_run" ? args.configuration : saved.find(value => value.id === runs.find(run => run.id === args.id)?.configurationId)!; if (configuration.executable === "missing") throw new Error("Executable was not found"); const run = { id: `run-${++next}`, workspaceEpoch: 1, configurationId: configuration.id, name: configuration.name, status: "running", exitCode: null, error: null }; runs.push(run); channels.set(run.id, args.onEvent); trace.starts.push(structuredClone(configuration)); const text = "Explicit fixture output. No command executed.\n"; output.set(run.id, text); setTimeout(() => args.onEvent.onmessage({ kind: "output", workspaceEpoch: 1, id: run.id, sequence: 1, stream: "stdout", text }), 0); return { ...run }; }
        if (command === "stop_run") { trace.stops.push(args.id); const run = runs.find(run => run.id === args.id)!; run.status = "stopped"; state(run); return { ...run }; }
        if (command === "run_output") return { id: args.id, text: output.get(args.id) || "", truncated: false };
        if (command === "acknowledge_run") return null;
        if (command === "current_file_run") return { path: "README.md", configuration: null, reason: "No runner for .md files." };
        if (command === "resolve_run_approval") { trace.approvals.push(args); emit("run-approvals-changed", { pending: [] }); return null; }
        if (command === "open_workspace") return { root, name: "Run IPC fixture" };
        if (command === "list_directory" || command === "list_files") return [{ path: "README.md", name: "README.md", isDir: false }];
        if (command === "open_buffer") return { path: "README.md", text: "# Run configurations fixture\n\nThis browser test does not execute processes.", revision: 0, savedRevision: 0, language: "markdown" };
        if (command === "native_window_state") return { fullscreen: false, maximized: false, hasNativeTrafficLights: false };
        if (command === "plugin:event|listen") { const id = ++callback; listeners.set(args.event, [...listeners.get(args.event) || [], args.handler]); return id; }
        if (["plugin:event|unlisten", "plugin:webview|set_webview_zoom", "save_session"].includes(command)) return null;
        if (command === "terminal_create") return { id: "unused-terminal", cwd: root, shell: "fixture", cols: 80, rows: 24, processId: null, exited: false, exitCode: null };
        if (["terminal_resize", "terminal_close", "terminal_acknowledge"].includes(command)) return null;
        throw new Error(`Unhandled explicit run fixture command: ${command}`);
      },
    } });
  }, settings);
  await page.goto("/"); await expect(page.getByRole("button", { name: "Run selected configuration", exact: true })).toBeEnabled();
}
async function openManager(page: Page) {
  await page.getByRole("button", { name: "Run configuration", exact: true }).click(); await page.getByRole("button", { name: "Edit configurations…", exact: true }).click();
  return page.getByRole("dialog", { name: "Run configurations", exact: true });
}
test("manager validates, saves, duplicates detected tasks and deletes configurations without executing", async ({ page }, testInfo) => {
  await fixture(page); const manager = await openManager(page);
  await manager.getByRole("button", { name: "New configuration", exact: true }).click();
  await manager.getByRole("textbox", { name: "Configuration name", exact: true }).fill("Fixture task"); await manager.getByRole("textbox", { name: "Executable", exact: true }).fill("node");
  await manager.getByRole("textbox", { name: "Arguments JSON", exact: true }).fill("invalid"); await manager.getByRole("button", { name: "Apply", exact: true }).click(); await expect(manager.getByRole("alert")).toContainText("JSON array");
  await manager.getByRole("textbox", { name: "Arguments JSON", exact: true }).fill('["file with spaces.js"]'); await manager.getByRole("textbox", { name: "Working directory", exact: true }).fill("../outside"); await manager.getByRole("button", { name: "Apply", exact: true }).click(); await expect(manager.getByRole("alert")).toContainText("outside workspace");
  await manager.getByRole("textbox", { name: "Working directory", exact: true }).fill("."); await manager.getByRole("button", { name: "Apply", exact: true }).click(); await expect(manager.getByRole("status")).toContainText("Configuration saved");
  await manager.screenshot({ path: testInfo.outputPath("run-manager.png") });
  await manager.getByRole("option").filter({ hasText: "npm test" }).click(); await expect(manager.getByRole("textbox", { name: "Executable", exact: true })).toBeDisabled(); await manager.getByRole("button", { name: "Save an editable copy", exact: true }).click(); await expect(manager.getByRole("textbox", { name: "Executable", exact: true })).toBeEnabled();
  await manager.getByRole("button", { name: "Delete configuration", exact: true }).click(); await page.getByRole("dialog", { name: "Delete run configuration", exact: true }).getByRole("button", { name: "Delete configuration", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__runFixture.trace.starts)).toEqual([]);
});
test("Run, Stop and Restart use live state and preserve workspace selection on reload", async ({ page }, testInfo) => {
  await fixture(page); await expect(page.getByRole("tab", { name: "Run", exact: true })).toHaveCount(0); await page.getByRole("button", { name: "Run selected configuration", exact: true }).click(); const panel = page.getByRole("region", { name: "Run output", exact: true });
  await expect(panel.getByRole("log")).toContainText("No command executed"); await expect(panel.getByRole("status")).toContainText("Running");
  await panel.getByRole("button", { name: "Stop selected run", exact: true }).click(); await expect(panel.getByRole("status")).toContainText("Stopped"); await expect(panel.getByRole("tab", { name: "Run", exact: true })).toBeVisible(); await panel.getByRole("button", { name: "Restart selected run", exact: true }).click(); await expect(panel.getByRole("status")).toContainText("Running");
  await panel.screenshot({ path: testInfo.outputPath("run-output.png") });
  await panel.getByRole("button", { name: "Stop selected run", exact: true }).click(); await page.getByRole("button", { name: "Run configuration", exact: true }).click(); await page.getByRole("option").filter({ hasText: "npm test" }).click();
  await page.reload(); await expect(page.getByRole("button", { name: "Run configuration", exact: true })).toContainText("npm test");
});
test("agent opt-in and concealed environment review require explicit approval", async ({ page }, testInfo) => {
  await fixture(page); const manager = await openManager(page); const optin = manager.getByRole("switch", { name: "Allow agents to request run tools", exact: true });
  await optin.click(); await expect(optin).toHaveAttribute("aria-checked", "true"); await manager.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => (window as any).__runFixture.request([{ id: "request", action: "save", lead: { connectionId: "connection", sessionId: "lead" }, agentName: "Fixture agent", name: "Application", executable: "node", args: ["app.js"], cwd: ".", envKeys: ["PORT"], envReferences: {}, envChanges: { PORT: "proposed-private-value" }, executionResolved: false, expiresAt: 1999999999, configRevision: "revision" }]));
  const approval = page.getByRole("dialog", { name: "Agent run tool approval", exact: true }); await expect(approval.getByRole("button", { name: "Reject", exact: true })).toBeFocused(); await expect(approval).not.toContainText("proposed-private-value"); await approval.getByRole("button", { name: "Reveal proposed environment value for PORT", exact: true }).click(); await expect(approval).toContainText("proposed-private-value");
  await approval.screenshot({ path: testInfo.outputPath("run-approval.png") }); expect(await page.evaluate(() => (window as any).__runFixture.trace.approvals)).toEqual([]);
  await approval.getByRole("button", { name: "Reject", exact: true }).click(); await expect(approval).toHaveCount(0); expect(await page.evaluate(() => (window as any).__runFixture.trace.approvals)).toEqual([{ id: "request", allow: false }]);
});
test("Cancel retains or discards unapplied fields explicitly and the manager fits a narrow themed workspace", async ({ page }, testInfo) => {
  await fixture(page); let manager = await openManager(page);
  await manager.getByRole("textbox", { name: "Configuration name", exact: true }).fill("Unapplied fixture"); await manager.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog", { name: "Unapplied configuration changes", exact: true }).getByRole("button", { name: "Keep editing", exact: true }).click(); await expect(manager.getByRole("textbox", { name: "Configuration name", exact: true })).toHaveValue("Unapplied fixture");
  await manager.getByRole("button", { name: "Cancel", exact: true }).click(); await page.getByRole("button", { name: "Discard changes", exact: true }).click(); manager = await openManager(page); await expect(manager.getByRole("textbox", { name: "Configuration name", exact: true })).toHaveValue("Application");
  for (const theme of ["light", "purple"] as const) { await page.locator(".ide").evaluate((node, theme) => { node.classList.remove("theme-dark", "theme-light", "theme-purple"); node.classList.add(`theme-${theme}`); }, theme); await manager.screenshot({ path: testInfo.outputPath(`run-manager-${theme}.png`) }); }
  await page.setViewportSize({ width: 560, height: 700 }); const box = await manager.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(560); await expect(manager.getByRole("button", { name: "OK", exact: true })).toBeVisible(); await manager.screenshot({ path: testInfo.outputPath("run-manager-narrow.png") });
  expect(await page.evaluate(() => (window as any).__runFixture.trace.saves)).toEqual([]);
});
test("a failed launch reports the error, keeps configuration and retries after an edit", async ({ page }) => {
  await fixture(page); let manager = await openManager(page);
  await manager.getByRole("textbox", { name: "Executable", exact: true }).fill("missing"); await manager.getByRole("button", { name: "OK", exact: true }).click();
  await page.getByRole("button", { name: "Run selected configuration", exact: true }).click(); await expect(page.getByRole("region", { name: "Run output", exact: true }).getByRole("alert")).toContainText("Executable was not found");
  manager = await openManager(page); await expect(manager.getByRole("textbox", { name: "Executable", exact: true })).toHaveValue("missing"); await manager.getByRole("textbox", { name: "Executable", exact: true }).fill("node"); await manager.getByRole("button", { name: "OK", exact: true }).click();
  await page.getByRole("button", { name: "Run selected configuration", exact: true }).click(); await expect(page.getByRole("region", { name: "Run output", exact: true }).getByRole("status")).toContainText("Running");
});
