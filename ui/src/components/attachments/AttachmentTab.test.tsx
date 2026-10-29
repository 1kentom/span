// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { batch, createEffect, createRoot, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { AttachmentTab, createAttachmentTabs } from './AttachmentTab';
import { createFileAttachment, type Attachment } from '../../lib/attachments';
import { isViewerTab, viewerTabId, viewerTabName } from '../../lib/viewer-tabs';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
const mount = (view: () => any) => { const root = document.createElement('div'); document.body.append(root); cleanup.push(render(view, root)); return root; };
const tabs = () => createRoot(dispose => { cleanup.push(dispose); return createAttachmentTabs(); });
const png = (name = 'shot.png'): Attachment => createFileAttachment({ name, mime: 'image/png', bytes: new Uint8Array(12).fill(1), source: 'picked' });

describe('attachment tab registry', () => {
  it('registers a view under a viewer tab path named after the attachment', () => {
    const registry = tabs(); const item = png();
    const path = registry.register({ item });
    expect(isViewerTab(path)).toBe(true);
    expect(viewerTabId(path)).toBe(item.id);
    expect(viewerTabName(path)).toBe('shot.png');
    expect(registry.view(path)?.item).toBe(item);
  });
  it('reuses the open path for the same attachment and refreshes its view', () => {
    const registry = tabs(); const item = png();
    const first = registry.register({ item });
    const renamed = { ...item, name: 'assets-shot.png', source: 'workspace-file' as const, path: 'assets/shot.png' };
    const second = registry.register({ item: renamed });
    expect(second).toBe(first);
    expect(registry.view(first)?.item.name).toBe('assets-shot.png');
  });
  it('keeps a view registered and opened in one batch while an effect prunes by open tabs', () => {
    const { registry, open, setOpen } = createRoot(dispose => {
      cleanup.push(dispose);
      const registry = createAttachmentTabs();
      const [open, setOpen] = createSignal<string[]>([]);
      createEffect(() => registry.prune(open()));
      return { registry, open, setOpen };
    });
    const path = batch(() => { const next = registry.register({ item: png() }); setOpen([...open(), next]); return next; });
    expect(registry.view(path)).toBeDefined();
    setOpen([]);
    expect(registry.view(path)).toBeUndefined();
  });
  it('forgets views whose tabs are no longer open anywhere', () => {
    const registry = tabs();
    const kept = registry.register({ item: png('a.png') });
    const closed = registry.register({ item: png('b.png') });
    registry.prune([kept, 'src/a.ts']);
    expect(registry.view(kept)).toBeDefined();
    expect(registry.view(closed)).toBeUndefined();
  });
});

describe('attachment tab body', () => {
  it('shows the shared viewer for a registered view', () => {
    const root = mount(() => <AttachmentTab view={{ item: png() }} onClose={() => undefined} />);
    expect(root.querySelector('.att-viewer-tab .vw')?.getAttribute('data-kind')).toBe('image');
  });
  it('says plainly when the attachment is no longer available and offers to close the tab', () => {
    const close = vi.fn();
    const root = mount(() => <AttachmentTab onClose={close} />);
    expect(root.querySelector('[data-state="gone"]')?.textContent).toContain('no longer available');
    ([...root.querySelectorAll('button')].find(node => node.textContent === 'Close tab') as HTMLButtonElement).click();
    expect(close).toHaveBeenCalled();
  });
});
