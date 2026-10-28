import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

// Explicit browser IPC fixture. This test never starts a shell or executes a command.
const properties = JSON.parse(readFileSync("crates/core/settings.schema.json", "utf8")).properties;
const settings = Object.fromEntries(Object.entries(properties as Record<string, { default?: unknown }>).filter(([key, value]) => !key.includes(".") && key !== "$schema" && "default" in value).map(([key, value]) => [key, value.default]));
type Trace = { writes: { id: string; text: string }[]; creates: string[]; closes: string[]; resizes: { id: string; cols: number; rows: number }[]; acknowledgements: number; warnings: string[] };

test("native IPC fixture exercises xterm input, resize, tabs and Markdown Run versus staged Send", async ({ page }, testInfo) => {
  await page.addInitScript(settings => {
    let callback = 0; let next = 0;
    const trace = { writes: [], creates: [], closes: [], resizes: [], acknowledgements: 0, warnings: [] } as Trace;
    const warn = console.warn.bind(console);
    console.warn = (...messages) => { if (String(messages[0]).includes("computations created outside")) trace.warnings.push(new Error(String(messages[0])).stack || "Unknown reactive owner warning"); warn(...messages); };
    const sessions = new Map<string, { channel: { onmessage: (event: unknown) => void }; queue: string[]; sequence: number; waiting: boolean }>();
    const root = "/fixture/workspace";
    const markdown = "# Terminal fixture\n\n```bash\nprintf 'explicit Run'\n```\n\n```\nnpm run fixture-only\n```\n";
    const output = (id: string, text?: string) => {
      const session = sessions.get(id); if (!session) return;
      if (text !== undefined) session.queue.push(text);
      if (session.waiting || !session.queue.length) return;
      session.waiting = true;
      session.channel.onmessage({ kind: "output", id, sequence: ++session.sequence, data: Array.from(new TextEncoder().encode(session.queue.shift()!)) });
    };
    Object.assign(window, { isTauri: true, __terminalFixture: trace, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++callback, unregisterCallback: () => undefined,
      invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === "get_session") return { workspaceRoot: root, groups: [{ paths: ["README.md"], activePath: "README.md" }], activeGroup: 0, markdownViews: {}, panels: { projectWidth: 230, assistantWidth: 350, terminalHeight: 260, projectCollapsed: false, assistantCollapsed: true, terminalCollapsed: false } };
        if (command === "get_settings" || command === "get_settings_for_scope") return settings;
        if (command === "get_settings_jsonc" || command === "get_settings_jsonc_for_scope") return "{}";
        if (["take_startup_requests", "recent_projects", "get_settings_keys_for_scope", "agent_installed", "sync_native_menu"].includes(command)) return [];
        if (command === "open_workspace") return { root, name: "Native transport fixture" };
        if (command === "list_directory" || command === "list_files") return [{ path: "README.md", name: "README.md", isDir: false }];
        if (command === "open_buffer") return { path: "README.md", text: markdown, revision: 0, savedRevision: 0, language: "markdown" };
        if (command === "native_window_state") return { fullscreen: false, maximized: false, hasNativeTrafficLights: false };
        if (command === "plugin:event|listen") return ++callback;
        if (["plugin:event|unlisten", "plugin:webview|set_webview_zoom", "save_session"].includes(command)) return null;
        if (command === "terminal_create") {
          const id = `fixture:${++next}`; trace.creates.push(id);
          sessions.set(id, { channel: args.onEvent, queue: [], sequence: 0, waiting: false });
          setTimeout(() => output(id, "Explicit fixture transport, no commands execute here\r\n"), 0);
          return { id, cwd: root, shell: "fixture-only", cols: args.cols, rows: args.rows, processId: null, exitCode: null, exited: false };
        }
        if (command === "terminal_write") { const text = new TextDecoder().decode(Uint8Array.from(args.data)); trace.writes.push({ id: args.id, text }); output(args.id, text); return null; }
        if (command === "terminal_resize") { trace.resizes.push({ id: args.id, cols: args.cols, rows: args.rows }); return null; }
        if (command === "terminal_acknowledge") { trace.acknowledgements++; const session = sessions.get(args.id); if (session) session.waiting = false; output(args.id); return null; }
        if (command === "terminal_close") { trace.closes.push(args.id); sessions.delete(args.id); return null; }
        if (command === "terminal_interrupt") return null;
        throw new Error(`Unsupported explicit terminal fixture command: ${command}`);
      },
    } });
  }, settings);
  const trace = () => page.evaluate(() => (window as unknown as { __terminalFixture: Trace }).__terminalFixture);
  await page.goto("/");
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal.getByRole("tab", { name: "Shell 1", exact: true })).toBeVisible();
  const input = terminal.locator(".xterm-helper-textarea:visible");
  await expect(input).toBeVisible(); await input.focus(); await page.keyboard.insertText("typed 日本語");
  await expect.poll(async () => (await trace()).writes.map(value => value.text).join("")).toContain("typed 日本語");
  await expect.poll(async () => (await trace()).acknowledgements).toBeGreaterThan(0);
  const initialResize = (await trace()).resizes.length; await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await trace()).resizes.length).toBeGreaterThan(initialResize);
  await terminal.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect.poll(async () => (await trace()).creates.length).toBe(2);
  await terminal.getByRole("button", { name: "Hide terminal", exact: true }).click();
  await page.getByRole("button", { name: "Toggle terminal panel", exact: true }).click();
  expect((await trace()).creates).toHaveLength(2);
  await terminal.getByRole("button", { name: "Close shell 2", exact: true }).click();
  await expect.poll(async () => (await trace()).closes).toContain("fixture:2");
  await page.getByRole("button", { name: "Run code in terminal", exact: true }).click();
  await expect.poll(async () => (await trace()).writes.some(value => value.id === "fixture:3" && value.text === "printf 'explicit Run'\r")).toBe(true);
  const writeCount = (await trace()).writes.length;
  await page.getByRole("button", { name: "Send code to terminal for review", exact: true }).click();
  const draft = terminal.getByRole("textbox", { name: "Terminal command draft", exact: true });
  await expect(draft).toHaveValue("npm run fixture-only"); expect((await trace()).writes).toHaveLength(writeCount);
  await page.screenshot({ path: testInfo.outputPath("terminal-ipc-fixture.png") });
  await terminal.getByRole("button", { name: "Run draft", exact: true }).click();
  await expect.poll(async () => (await trace()).writes.some(value => value.id === "fixture:4" && value.text === "npm run fixture-only\r")).toBe(true);
  expect((await trace()).warnings).toEqual([]);
});

test("ordinary browser preview exposes an unavailable terminal without a fake shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Browser preview does not execute commands.", { exact: false })).toBeVisible();
  await expect(page.locator(".xterm")).toHaveCount(0);
});
