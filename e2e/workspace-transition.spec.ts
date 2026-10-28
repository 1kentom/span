import { expect, test } from "@playwright/test";
import { modifier, ready } from "./helpers";

for (const result of ["cancel", "failure", "open"] as const) {
  test(`folder transition blocks editing and commands while native response is held: ${result}`, async ({ page }) => {
    await ready(page);
    await page.evaluate(async () => {
      const source = await (await fetch("/src/stores/workbench.ts")).text();
      const path = source.match(/from\s*["']([^"']*\/lib\/client\.ts[^"']*)["']/)?.[1];
      if (!path) throw new Error("Could not locate the running workbench transport.");
      const { api } = await import(path);
      const original = api.openWorkspace;
      api.openWorkspace = async (workspacePath?: string) => {
        const outcome = await new Promise<string>(resolve => { (window as unknown as { releaseOpen: (result: string) => void }).releaseOpen = resolve; });
        if (outcome === "cancel") return null;
        if (outcome === "failure") throw new Error("Held folder open failed");
        return original(workspacePath);
      };
    });
    const editor = page.locator(".source-view:visible .cm-content");
    const original = await editor.textContent() || "";
    await page.locator(".open-folder-toolbar").click();
    const application = page.locator("main.ide");
    await expect(application).toHaveAttribute("aria-busy", "true");
    await expect(application).toHaveAttribute("inert", "");
    await page.keyboard.type("new draft during folder transition");
    await page.keyboard.press(`${modifier}+w`);
    await expect(editor).toHaveText(original);
    await expect(page.locator('.file-tab [role="tab"]').filter({ hasText: "rpc-node.ts" })).toHaveCount(1);
    await page.evaluate(value => (window as unknown as { releaseOpen: (result: string) => void }).releaseOpen(value), result);
    await expect(application).toHaveAttribute("aria-busy", "false");
    const restored = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
    await expect(restored).toBeVisible(); await expect(restored).toHaveAttribute("contenteditable", "true");
    await expect(restored).not.toContainText("new draft during folder transition");
    if (result === "failure") await expect(page.getByRole("alert")).toContainText("Held folder open failed");
    await restored.focus(); await restored.press(`${modifier}+End`); await page.keyboard.insertText("// editing resumes");
    await expect(restored).toContainText("editing resumes");
  });
}
