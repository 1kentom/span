import { expect, test } from "@playwright/test";
import { ready } from "./helpers";

test("uploaded ZIP previews receive the complete container after the 64 KiB prefix", async ({ page }, testInfo) => {
  await ready(page);
  await page.evaluate(async () => {
    const componentPath = "/src/components/uploads/UploadsWorkspace.tsx";
    const apiPath = "/src/lib/uploads-api.ts";
    const runtimePath = "/node_modules/.vite/deps/solid-js_web.js";
    const [{ UploadsWorkspace }, { createMemoryUploadsApi }, { render }] = await Promise.all([import(componentPath), import(apiPath), import(runtimePath)]);
    const fflatePath = "/node_modules/.vite/deps/fflate.js";
    const { zipSync } = await import(fflatePath);
    const data = zipSync({ "payload.bin": Uint8Array.from({ length: 80 * 1024 }, (_, index) => index % 251) }, { level: 0 });
    const api = createMemoryUploadsApi([{ entry: { id: "complete-zip", name: "complete.zip", size: data.length, createdAt: Date.now(), origin: "sent" }, data }]);
    const calls: { id: string; length: number }[] = [];
    const original = api.read;
    api.read = (id: string, offset: number, length: number) => { calls.push({ id, length }); return original(id, offset, length); };
    Object.assign(window, { __uploadDocumentFixture: { length: data.length, calls } });
    const host = document.createElement("div"); host.className = "ide";
    host.style.cssText = "position:fixed;inset:0;z-index:100;height:100dvh";
    document.body.append(host);
    render(() => UploadsWorkspace({ api, platform: "mac" }), host);
  });
  await page.locator(".up-row").filter({ hasText: "complete.zip" }).click();
  await expect(page.locator(".ox-archive")).toContainText("payload.bin");
  const trace = await page.evaluate(() => (window as any).__uploadDocumentFixture);
  expect(trace.length).toBeGreaterThan(65_536);
  expect(trace.calls).toEqual([{ id: "complete-zip", length: trace.length }]);
  await expect(page.locator('[data-state="damaged"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("complete-upload-zip.png") });
});
