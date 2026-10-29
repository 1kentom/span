import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

// Explicit browser IPC fixture. This test never starts a shell or executes a command.
const properties = JSON.parse(readFileSync("crates/core/settings.schema.json", "utf8")).properties;
const settings = Object.fromEntries(Object.entries(properties as Record<string, { default?: unknown }>).filter(([key, value]) => !key.includes(".") && key !== "$schema" && "default" in value).map(([key, value]) => [key, value.default]));
type Trace = { dimensions: Record<string, { cols: number; rows: number }>; commands: { language: string; code: string; root: string }[]; writes: { id: string; text: string }[]; creates: string[]; closes: string[]; resizes: { id: string; cols: number; rows: number }[]; acknowledgements: number; warnings: string[]; menus: Record<string, string[]>[] };

test("native IPC fixture exercises xterm input, resize, tabs and Markdown Run versus staged Send", async ({ page }, testInfo) => {
  await page.addInitScript(settings => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    let callback = 0; let next = 0;
    const trace = { dimensions: {}, commands: [], writes: [], creates: [], closes: [], resizes: [], acknowledgements: 0, warnings: [], menus: [] } as Trace;
    const warn = console.warn.bind(console);
    console.warn = (...messages) => { if (String(messages[0]).includes("computations created outside")) trace.warnings.push(new Error(String(messages[0])).stack || "Unknown reactive owner warning"); warn(...messages); };
    const sessions = new Map<string, { channel: { onmessage: (event: unknown) => void }; queue: string[]; sequence: number; waiting: boolean; exitCode?: number }>();
    const root = "/fixture/workspace";
    const markdown = "# Terminal fixture\n\n```bash\nprintf 'explicit Run'\n```\n\n```\nnpm run fixture-only\n```\n";
    const output = (id: string, text?: string) => {
      const session = sessions.get(id); if (!session) return;
      if (text !== undefined) session.queue.push(text);
      if (session.waiting || !session.queue.length) return;
      session.waiting = true;
      session.channel.onmessage({ kind: "output", id, sequence: ++session.sequence, data: Array.from(new TextEncoder().encode(session.queue.shift()!)) });
    };
    Object.assign(window, { isTauri: true, __terminalFixture: trace, __terminalFixtureOutput: output, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++callback, unregisterCallback: () => undefined,
      invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === "sync_native_menu") { trace.menus.push(args.bindings); return []; }
        if (command === "get_session") return { workspaceRoot: root, groups: [{ paths: ["README.md"], activePath: "README.md" }], activeGroup: 0, markdownViews: {}, panels: { projectWidth: 230, assistantWidth: 350, terminalHeight: 260, projectCollapsed: false, assistantCollapsed: true, terminalCollapsed: false } };
        if (command === "get_settings" || command === "get_settings_for_scope") return { ...settings, editorFontFamily: "Inter" };
        if (command === "update_setting") { settings[String(args.key)] = JSON.parse(String(args.valueJson)); return { ...settings }; }
        if (command === "get_settings_jsonc" || command === "get_settings_jsonc_for_scope") return "{}";
        if (["take_startup_requests", "recent_projects", "get_settings_keys_for_scope", "agent_installed", "sync_native_menu", "pending_run_approvals", "list_runs"].includes(command)) return [];
        if (command === "lsp_status") return [];
        if (command === "file_index_status") return { workspaceRoot: root, generation: 1, status: "ready", scannedEntries: 1, indexedFiles: 1, errorCount: 0, lastError: null, watcherReady: true, watcherError: null };
        if (command === "query_file") return { workspaceRoot: root, generation: 1, requestId: 1, results: [{ path: "README.md", name: "README.md", isDir: false }] };
        if (command === "git_context") return { workspaceRoot: root, enabled: false, repository: { id: "terminal-git-fixture", root, workspacePrefix: "", branch: "fixture", head: null, detached: false, unborn: true }, unavailableReason: null };
        if (command === "run_tools_enabled") return false;
        if (command === "run_configurations") return { workspaceRoot: root, configurations: [], detected: [] };
        if (command === "run_context") return { workspaceRoot: root, workspaceEpoch: 1, runs: [] };
        if (command === "open_workspace") return { root, name: "Native transport fixture" };
        if (command === "list_directory" || command === "list_files") return [{ path: "README.md", name: "README.md", isDir: false }];
        if (command === "open_buffer") return { path: "README.md", text: markdown, revision: 0, savedRevision: 0, language: "markdown" };
        if (command === "native_window_state") return { fullscreen: false, maximized: false, hasNativeTrafficLights: false };
        if (command === "plugin:event|listen") return ++callback;
        if (["plugin:event|unlisten", "plugin:webview|set_webview_zoom", "save_session"].includes(command)) return null;
        if (command === "terminal_profiles") return [
          { id: "/bin/zsh", name: "zsh", path: "/bin/zsh", isDefault: true, kind: "shell" },
          { id: "/bin/bash", name: "bash", path: "/bin/bash", isDefault: false, kind: "shell" },
          { id: "/fixture/bin/fish", name: "fish", path: "/fixture/bin/fish", isDefault: false, kind: "shell" },
          { id: "/fixture/bin/node", name: "Node REPL", path: "/fixture/bin/node", isDefault: false, kind: "node" },
          { id: "/fixture/bin/python3", name: "Python REPL", path: "/fixture/bin/python3", isDefault: false, kind: "python" },
        ];
        if (command === "terminal_create_command") {
          const id = `fixture:${++next}`; trace.creates.push(id); trace.dimensions[id] = { cols: args.cols, rows: args.rows }; trace.commands.push({ language: args.language, code: args.code, root: args.expectedWorkspaceRoot });
          sessions.set(id, { channel: args.onEvent, queue: [], sequence: 0, waiting: false, exitCode: 0 });
          setTimeout(() => output(id, "Explicit command fixture output, no command executed.\r\n"), 0);
          return { id, cwd: root, shell: args.language === "bash" ? "/bin/bash" : "/bin/zsh", cols: args.cols, rows: args.rows, processId: null, exitCode: null, exited: false };
        }
        if (command === "terminal_create") {
          const id = `fixture:${++next}`; trace.creates.push(id); trace.dimensions[id] = { cols: args.cols, rows: args.rows };
          sessions.set(id, { channel: args.onEvent, queue: [], sequence: 0, waiting: false });
          setTimeout(() => {
            const normal = Array.from({ length: 8 }, (_, index) => `\x1b[${30 + index}mANSI ${index} `).join("");
            const bright = Array.from({ length: 8 }, (_, index) => `\x1b[${90 + index}mANSI ${8 + index} `).join("");
            output(id, `Explicit fixture transport, no commands execute here\r\n${normal}\x1b[0m\r\n${bright}\x1b[0m\r\n`);
          }, 0);
          return { id, cwd: root, shell: args.profileId || "/bin/zsh", cols: args.cols, rows: args.rows, processId: null, exitCode: null, exited: false };
        }
        if (command === "terminal_write") { const text = new TextDecoder().decode(Uint8Array.from(args.data)); trace.writes.push({ id: args.id, text }); output(args.id, text); return null; }
        if (command === "terminal_resize") { trace.dimensions[args.id] = { cols: args.cols, rows: args.rows }; trace.resizes.push({ id: args.id, cols: args.cols, rows: args.rows }); return null; }
        if (command === "terminal_acknowledge") { trace.acknowledgements++; const session = sessions.get(args.id); if (session) session.waiting = false; output(args.id); if (session && !session.waiting && !session.queue.length && session.exitCode !== undefined) { session.channel.onmessage({ kind: "exit", id: args.id, code: session.exitCode }); session.exitCode = undefined; } return null; }
        if (command === "terminal_close") { trace.closes.push(args.id); sessions.delete(args.id); return null; }
        if (command === "terminal_interrupt") return null;
        throw new Error(`Unsupported explicit terminal fixture command: ${command}`);
      },
    } });
  }, settings);
  const trace = () => page.evaluate(() => (window as unknown as { __terminalFixture: Trace }).__terminalFixture);
  await page.goto("/");
  const rootName = page.locator(".tree-root-name");
  await expect(rootName).toHaveAttribute("title", "Native transport fixture");
  const rootMetrics = await rootName.evaluate(node => ({ height: node.getBoundingClientRect().height, client: node.clientWidth, scroll: node.scrollWidth, wrap: getComputedStyle(node).whiteSpace, ellipsis: getComputedStyle(node).textOverflow }));
  expect(rootMetrics.wrap).toBe("nowrap"); expect(rootMetrics.ellipsis).toBe("ellipsis");
  expect(rootMetrics.height).toBeLessThanOrEqual(20); expect(rootMetrics.scroll).toBeGreaterThan(rootMetrics.client);
  const rootBounds = (await page.locator(".tree-root").boundingBox())!;
  expect((await page.locator(".file-index-status").boundingBox())!.y).toBeGreaterThanOrEqual(rootBounds.y + rootBounds.height);
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal.getByRole("tab", { name: "zsh", exact: true })).toBeVisible();
  const input = terminal.locator(".xterm-helper-textarea:visible");
  await expect(input).toBeVisible();
  await page.evaluate(() => document.fonts.load('13px "JetBrains Mono"'));
  expect(await page.evaluate(() => document.fonts.check('13px "JetBrains Mono"'))).toBe(true);
  await input.focus();
  await expect.poll(async () => (await trace()).menus.at(-1)?.toggleFiles).toEqual(["Meta+E"]);
  expect(Object.entries((await trace()).menus.at(-1) || {}).filter(([, keys]) => keys.some(key => key.includes("Ctrl+")))).toEqual([["showSourceControl", ["Ctrl+Shift+G"]]]);
  await page.keyboard.insertText("typed 日本語");
  await expect.poll(async () => (await trace()).writes.map(value => value.text).join("")).toContain("typed 日本語");
  await input.press("Control+c"); await input.press("Control+p"); await input.press("Control+w");
  await expect.poll(async () => (await trace()).writes.map(value => value.text).join("")).toContain("\x03\x10\x17");
  await expect(page.getByRole("dialog", { name: "Goto", exact: true })).toHaveCount(0);
  await input.press("Control+Shift+G");
  await expect(page.getByRole("region", { name: "Git source control", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".git-panel"))).toBe(true);
  await expect(page.getByRole("button", { name: "Enable Git", exact: true })).toBeVisible();
  expect((await trace()).writes.map(value => value.text).join("")).not.toContain("\x07");
  await input.focus(); await input.press("Control+g"); await input.press("Control+p");
  await expect.poll(async () => (await trace()).writes.map(value => value.text).join("")).toContain("\x07\x10");
  await expect(page.getByRole("dialog", { name: "Goto", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Files", exact: true }).click(); await input.focus();
  const project = page.getByRole("complementary", { name: "Project", exact: true });
  await input.press("Meta+e"); await expect(project).toBeHidden();
  await input.press("Meta+e"); await expect(project).toBeVisible();
  await input.press("Meta+p"); await expect(page.getByRole("dialog", { name: "Goto", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await input.focus();
  await input.press("Meta+j"); await expect(terminal).toBeHidden();
  await page.keyboard.press("Meta+j"); await expect(input).toBeFocused();
  await expect.poll(async () => (await trace()).acknowledgements).toBeGreaterThan(0);
  // Inspect rendered cells instead of inferring spacing from transport writes.
  await page.evaluate(() => (window as any).__terminalFixtureOutput("fixture:1", "\x1b[2J\x1b[Hii WW 00   spaces 日本語🌱"));
  const rendered = terminal.locator(".xterm:visible .xterm-rows > div").first();
  await expect(rendered).toContainText("ii WW 00   spaces 日本語🌱");
  const metrics = await rendered.evaluate(row => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    function characterRect(index: number) {
      for (const node of nodes) { if (index < node.length) { const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1); const bounds = range.getBoundingClientRect(); return { x: bounds.x, width: bounds.width }; } index -= node.length; }
      throw new Error("Missing rendered character");
    }
    const cursor = row.querySelector<HTMLElement>(".xterm-cursor");
    return { widths: [0, 2, 3, 6, 8].map(index => characterRect(index).width), gap: characterRect(11).x - characterRect(7).x, rowHeight: row.getBoundingClientRect().height, cursorHeight: cursor?.getBoundingClientRect().height, fontFamily: getComputedStyle(row.parentElement!).fontFamily };
  });
  expect(Math.max(...metrics.widths) - Math.min(...metrics.widths)).toBeLessThan(0.1);
  expect(metrics.gap).toBeCloseTo(metrics.widths[0] * 4, 0);
  expect(metrics.cursorHeight).toBeLessThanOrEqual(metrics.rowHeight + 1);
  expect(metrics.rowHeight).toBeLessThanOrEqual(19);
  expect(metrics.fontFamily).toContain("JetBrains Mono");
  // The configured proportional Inter editor font must not change terminal cell advances.
  await terminal.screenshot({ path: testInfo.outputPath("terminal-cell-metrics-fixture.png") });
  const initialResize = (await trace()).resizes.length; await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await trace()).resizes.length).toBeGreaterThan(initialResize);
  await page.setViewportSize({ width: 1440, height: 900 });
  await terminal.getByRole("button", { name: "Choose terminal shell", exact: true }).click();
  const profileMenu = page.getByRole("menu", { name: "Installed terminal shells", exact: true });
  await expect(profileMenu.getByRole("img", { name: "macOS", exact: true })).toBeVisible();
  await expect(profileMenu).not.toContainText("Detected: macOS");
  await page.screenshot({ path: testInfo.outputPath("terminal-shell-picker-fixture.png") });
  const popupBounds = (await profileMenu.boundingBox())!;
  expect(popupBounds.y).toBeGreaterThanOrEqual(0); expect(popupBounds.y + popupBounds.height).toBeLessThanOrEqual(900);
  expect(await profileMenu.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(await terminal.evaluate(node => getComputedStyle(node).backgroundColor));
  await page.evaluate(() => { document.documentElement.style.zoom = "1.25"; document.querySelector<HTMLElement>(".ide")!.style.height = "calc(100dvh / 1.25)"; });
  await expect.poll(async () => { const popup = (await profileMenu.boundingBox())!; return popup.y + popup.height; }).toBeLessThanOrEqual(900);
  const zoomedTrigger = (await terminal.getByRole("button", { name: "Choose terminal shell", exact: true }).boundingBox())!;
  const zoomedPopup = (await profileMenu.boundingBox())!;
  expect(Math.abs(zoomedPopup.x - zoomedTrigger.x)).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath("terminal-shell-picker-zoom125-fixture.png") });
  for (const factor of [1.728, 2]) {
    await page.evaluate(factor => { document.documentElement.style.zoom = String(factor); document.querySelector<HTMLElement>(".ide")!.style.height = `calc(100dvh / ${factor})`; }, factor);
    await expect.poll(async () => { const popup = (await profileMenu.boundingBox())!; return popup.y + popup.height; }).toBeLessThanOrEqual(900);
    const popup = (await profileMenu.boundingBox())!;
    expect(popup.x).toBeGreaterThanOrEqual(0); expect(popup.x + popup.width).toBeLessThanOrEqual(1441);
    expect(popup.y).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`terminal-platform-picker-zoom${factor}-fixture.png`) });
  }
  await page.evaluate(() => { document.documentElement.style.zoom = "1"; document.querySelector<HTMLElement>(".ide")!.style.height = "100dvh"; });
  await profileMenu.getByRole("menuitem").filter({ hasText: "/bin/bash" }).click();
  await expect.poll(async () => (await trace()).creates.length).toBe(2);
  await expect(terminal.getByRole("tablist", { name: "Output views", exact: true })).toHaveCount(0);
  await expect(terminal.getByRole("tab", { name: "Run", exact: true })).toHaveCount(0);
  await expect(terminal.getByRole("tab", { name: "bash", exact: true })).toBeVisible();
  await expect(input).toBeFocused();
  expect((await trace()).creates).toHaveLength(2); expect((await trace()).closes).toEqual([]);
  const resizeCountBeforeThemes = (await trace()).resizes.length;
  const viewport = terminal.locator(".xterm:visible .xterm-scrollable-element");
  for (const [theme, background] of [["light", "rgb(255, 255, 255)"], ["purple", "rgb(23, 23, 43)"], ["dark", "rgb(24, 25, 27)"]] as const) {
    await page.locator(".ide").evaluate((node, value) => { node.classList.remove("theme-dark", "theme-light", "theme-purple"); node.classList.add(`theme-${value}`); }, theme);
    await expect.poll(async () => viewport.evaluate(node => (node as HTMLElement).style.backgroundColor)).toBe(background);
    await expect.poll(async () => terminal.locator(".xterm:visible .xterm-viewport").evaluate(node => getComputedStyle(node).backgroundColor)).toBe(background);
    await expect.poll(async () => terminal.locator(".terminal-panel:visible").evaluate(node => getComputedStyle(node).getPropertyValue("--terminal-red").trim())).not.toBe("");
    await terminal.screenshot({ path: testInfo.outputPath(`terminal-${theme}-fixture.png`) });
    await page.screenshot({ path: testInfo.outputPath(`app-terminal-${theme}-fixture.png`) });
  }
  expect((await trace()).resizes).toHaveLength(resizeCountBeforeThemes);
  const columns = (await trace()).dimensions["fixture:2"].cols;
  await page.evaluate(cols => (window as any).__terminalFixtureOutput("fixture:2", "\x1b[2J\x1b[H" + "X".repeat(cols - 4) + "日本語"), columns);
  const wrappingRows = terminal.locator(".xterm:visible .xterm-rows > div");
  await expect(wrappingRows.nth(0)).toHaveText("X".repeat(columns - 4) + "日本");
  await expect(wrappingRows.nth(1)).toContainText("語");
  const columnsBeforeFontChange = (await trace()).dimensions["fixture:2"].cols;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect.poll(async () => Object.keys((await trace()).menus.at(-1) || {}).length).toBeGreaterThan(0);
  await page.getByRole("searchbox", { name: "Search settings", exact: true }).fill("Editor font size");
  const fontSize = page.getByRole("spinbutton", { name: "Editor font size", exact: true });
  await fontSize.fill("18"); await fontSize.press("Tab");
  await expect.poll(async () => (await trace()).dimensions["fixture:2"].cols).toBeLessThan(columnsBeforeFontChange);
  expect((await trace()).creates).toHaveLength(2); expect((await trace()).closes).toEqual([]);
  await terminal.screenshot({ path: testInfo.outputPath("terminal-font18-fixture.png") });
  await page.screenshot({ path: testInfo.outputPath("app-terminal-font18-fixture.png") });
  await fontSize.fill("13"); await fontSize.press("Tab");
  await page.getByRole("tab").filter({ hasText: "README.md" }).click();
  await page.getByRole("button", { name: "Toggle project panel", exact: true }).click();
  await page.setViewportSize({ width: 520, height: 700 });
  const narrowWidth = (await terminal.boundingBox())!.width;
  expect(narrowWidth).toBeLessThanOrEqual(520);
  await expect.poll(async () => terminal.locator(".xterm:visible .xterm-screen").evaluate(node => node.getBoundingClientRect().width)).toBeLessThanOrEqual(narrowWidth);
  await expect(terminal.getByRole("button", { name: "Clear terminal display", exact: true })).toBeHidden();
  expect((await terminal.locator(".terminal-dock-toolbar").boundingBox())?.height).toBe(32);
  await terminal.screenshot({ path: testInfo.outputPath("terminal-narrow-fixture.png") });
  await page.screenshot({ path: testInfo.outputPath("app-terminal-narrow-fixture.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Toggle project panel", exact: true }).click();
  await terminal.getByRole("button", { name: "Hide terminal", exact: true }).click();
  await page.getByRole("button", { name: "Toggle terminal panel", exact: true }).click();
  expect((await trace()).creates).toHaveLength(2);
  await terminal.getByRole("button", { name: "Close shell 2", exact: true }).click();
  await expect.poll(async () => (await trace()).closes).toContain("fixture:2");
  await page.getByRole("button", { name: "Run code in terminal", exact: true }).click();
  await expect.poll(async () => (await trace()).commands).toEqual([{ language: "bash", code: "printf 'explicit Run'", root: "/fixture/workspace" }]);
  await expect(terminal.getByRole("status")).toContainText("Command exited (0)");
  const writeCount = (await trace()).writes.length;
  await page.getByRole("button", { name: "Send code to terminal for review", exact: true }).click();
  const draft = terminal.getByRole("textbox", { name: "Terminal command draft", exact: true });
  await expect(draft).toHaveValue("npm run fixture-only"); expect((await trace()).writes).toHaveLength(writeCount);
  expect((await terminal.locator(".terminal-dock-toolbar").boundingBox())?.height).toBe(32);
  await page.screenshot({ path: testInfo.outputPath("terminal-ipc-fixture.png") });
  await terminal.getByRole("button", { name: "Run draft", exact: true }).click();
  await expect.poll(async () => (await trace()).commands.at(-1)).toEqual({ language: "shell", code: "npm run fixture-only", root: "/fixture/workspace" });
  expect((await trace()).writes).toHaveLength(writeCount);
  await expect(terminal.getByRole("status")).toContainText("Command exited (0)");
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".xterm"))).toBe(true);
  await page.keyboard.press("Meta+w");
  await expect.poll(async () => (await trace()).closes).toContain("fixture:5");
  await expect(terminal.getByRole("tab", { name: "zsh command 5", exact: true })).toHaveCount(0);
  await expect(terminal.getByRole("tab", { name: "zsh", exact: true }).last()).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab").filter({ hasText: "README.md" })).toBeVisible();
  expect((await trace()).warnings).toEqual([]);
});

test("ordinary browser preview exposes an unavailable terminal without a fake shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Terminal", exact: true }).getByText("Browser preview does not execute commands.", { exact: false })).toBeVisible();
  await expect(page.locator(".xterm")).toHaveCount(0);
});
