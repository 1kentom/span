import { expect, test } from '@playwright/test';
import { ready } from './helpers';

test('a completed workspace image thumbnail opens the shared viewer using retained bytes', async ({ page }, testInfo) => {
  await ready(page);
  await page.evaluate(async () => {
    const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
    const runtime = (name: string) => resources.find((url) => url.includes(`/node_modules/.vite/deps/${name}.js?`)) || `/node_modules/.vite/deps/${name}.js`;
    const paths = ['/src/lib/agent-saved-images.ts', '/src/components/agent/WorkGroup.tsx', '/src/components/attachments/AttachmentViewer.tsx', runtime('solid-js_web'), runtime('solid-js')];
    const [{ createSavedImageStore }, { WorkGroup }, { AttachmentView }, { render }, { createMemo, createComponent }] = await Promise.all(paths.map((path) => import(path)));
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 160;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#36594a'; context.fillRect(0, 0, 240, 160);
    context.fillStyle = '#f5f5f0'; context.font = '24px monospace'; context.fillText('Workspace image', 12, 88);
    const dataUrl = canvas.toDataURL('image/png');
    const calls: { path: string; root: string }[] = [];
    const host = document.createElement('div'); host.className = 'ide';
    host.style.cssText = 'position:fixed;inset:0;z-index:100;padding:32px;display:grid;grid-template-columns:360px 1fr;gap:32px;height:100dvh;box-sizing:border-box';
    const feed = document.createElement('div'); feed.className = 'agent-panel';
    const viewer = document.createElement('div'); host.append(feed, viewer); document.body.append(host);
    let opened = '';
    render(() => {
      const store = createSavedImageStore(async (path: string, root: string) => { calls.push({ path, root }); return { mime: 'image/png', dataUrl }; });
      store.sync('session-1', '/workspace', [{ id: 'session-1:generate', path: '/workspace/assets/result.png' }]);
      const steps = createMemo(() => {
        const image = store.get('session-1:generate', '/workspace/assets/result.png');
        return [{ id: 'generate', kind: 'other', verb: 'Generate image', status: 'completed', savedPath: '/workspace/assets/result.png', savedImageNote: image?.state === 'ready' ? 'Workspace image preview loaded.' : 'Loading workspace image preview...', images: image?.state === 'ready' ? [{ id: image.attachment.id, name: image.attachment.name, mime: image.attachment.mime, src: image.src, onOpen: () => { opened = image.attachment.id; render(() => createComponent(AttachmentView, { item: image.attachment }), viewer); } }] : [] }];
      });
      return createComponent(WorkGroup, { headline: 'Worked', get steps() { return steps(); } });
    }, feed);
    Object.assign(window, { __savedImageFixture: { calls, get opened() { return opened; } } });
  });
  const thumbnail = page.locator('.sb-thumb-btn');
  await expect(thumbnail).toBeVisible();
  await thumbnail.click();
  await expect(page.locator('.att-viewer-title')).toHaveText('result.png');
  await expect(page.locator('.vw-image img')).toBeVisible();
  expect(await page.locator('.vw-image img').evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }))).toEqual({ width: 240, height: 160 });
  const trace = await page.evaluate(() => (window as any).__savedImageFixture);
  expect(trace.calls).toEqual([{ path: '/workspace/assets/result.png', root: '/workspace' }]);
  expect(trace.opened).toContain('session-1:generate');
  await page.screenshot({ path: testInfo.outputPath('saved-image-viewer.png') });
});
