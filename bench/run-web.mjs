import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";

const baseURL = process.env.SPAN_BENCH_URL ?? "http://127.0.0.1:1420";
const viewport = { width: 1440, height: 900 };
const navigationSamples = [];
const browser = await chromium.launch();
let page;
try {
  for (let index = 0; index < 5; index += 1) {
    const context = await browser.newContext({ viewport });
    page = await context.newPage();
    const started = performance.now();
    await page.goto(baseURL);
    await page.locator(".cm-content[contenteditable=true]").first().waitFor();
    navigationSamples.push(performance.now() - started);
    if (index < 4) await context.close();
  }
  const editor = page.locator(".cm-content[contenteditable=true]").first();
  await editor.click();
  await page.evaluate(() => {
    globalThis.__spanBenchSamples = [];
    document.addEventListener("keydown", (event) => {
      if (event.key.length !== 1 || !event.target.closest(".cm-content[contenteditable=true]")) return;
      const started = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        globalThis.__spanBenchSamples.push(performance.now() - started);
      }));
    }, true);
  });
  for (let index = 0; index < 100; index += 1) {
    await editor.press("a");
    await page.waitForFunction((count) => globalThis.__spanBenchSamples.length >= count, index + 1);
  }
  const actualText = await editor.textContent();
  if (!actualText?.includes("a".repeat(100))) throw new Error("The benchmark keys did not reach the editor document");
  const typingSamples = await page.evaluate(() => globalThis.__spanBenchSamples);
  const summarize = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    return { samples: values.length, p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1], raw_ms: values };
  };
  const result = {
    recorded_at: new Date().toISOString(),
    scope: "Chromium browser preview only, native phase gates unverified",
    base_url: baseURL,
    viewport,
    browser: await browser.version(),
    node: process.version,
    build_mode: "Vite development server",
    hardware: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logical_cpus: cpus().length, total_memory_bytes: totalmem() },
    navigation: { method: "fresh context navigation to first editable CodeMirror", ...summarize(navigationSamples) },
    typing: { method: "keydown to second requestAnimationFrame, one paint opportunity proxy", ...summarize(typingSamples) },
  };
  await mkdir(new URL("./results/", import.meta.url), { recursive: true });
  await writeFile(new URL("./results/web.json", import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
