// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { FileProbe } from '../../bindings';

// The card's actions go through the real client api with the desktop commands mocked.
const commands = vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  return { openFileWithSystem: vi.fn(), revealFile: vi.fn(), readFileBytes: vi.fn() };
});
vi.mock('../../bindings', async (original) => ({ ...(await original<typeof import('../../bindings')>()), commands }));

import { api, isDesktop } from '../../lib/client';
import { NOT_TEXT_MESSAGE } from '../../lib/binary-file';
import { WorkspaceFileView, fileTypeLabel } from './WorkspaceFileView';

const cleanup: (() => void)[] = [];
beforeEach(() => { commands.openFileWithSystem.mockReset().mockResolvedValue(null); commands.revealFile.mockReset().mockResolvedValue(null); commands.readFileBytes.mockReset(); });
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
const button = (root: ParentNode, name: string) => [...root.querySelectorAll('button')].find(b => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const blob: FileProbe = { path: 'data/cache.blob', name: 'cache.blob', size: 2048, kind: 'binary' };

function mount(file: FileProbe, options: { desktop?: boolean } = {}) {
  const desktop = options.desktop ?? true;
  const root = document.createElement('div');
  document.body.append(root);
  cleanup.push(render(() => <WorkspaceFileView
    file={file}
    readBytes={api.readFileBytes}
    onOpenWithSystem={desktop ? () => api.openFileWithSystem(file.path) : undefined}
    onReveal={desktop ? () => api.revealFile(file.path) : undefined}
    revealLabel="Reveal in Finder"
  />, root));
  return root;
}

describe("Can't show this file card", () => {
  it('runs as the desktop client', () => { expect(isDesktop).toBe(true); });

  it('shows the name, size, type and the not-text message, never decoded text', () => {
    const root = mount(blob);
    expect(root.querySelector('.vw-state-title')?.textContent).toBe("Can't show this file");
    expect(root.querySelector('.vw-state-text')?.textContent).toBe(NOT_TEXT_MESSAGE);
    const facts = [...root.querySelectorAll('.vw-file-facts dd')].map(item => item.textContent);
    expect(facts[0]).toBe('cache.blob');
    expect(facts[1]).toBe('2.0 KiB');
    expect(facts[2]).toBe('BLOB file');
    expect(commands.readFileBytes).not.toHaveBeenCalled();
    expect([...root.querySelectorAll('.vw-state-actions button')].map(b => b.textContent)).toEqual(['Open with default app', 'Reveal in Finder', 'View as hex']);
  });

  it('opens the file with the default app and reveals it through the desktop commands', async () => {
    const root = mount(blob);
    button(root, 'Open with default app')!.click();
    await settle();
    expect(commands.openFileWithSystem).toHaveBeenCalledWith('data/cache.blob');
    button(root, 'Reveal in Finder')!.click();
    await settle();
    expect(commands.revealFile).toHaveBeenCalledWith('data/cache.blob');
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('reports a failed action in a banner and keeps the card', async () => {
    commands.openFileWithSystem.mockRejectedValueOnce(new Error('Programs and scripts are not opened'));
    const root = mount(blob);
    button(root, 'Open with default app')!.click();
    await settle();
    expect(root.querySelector('.vw-banner-error')?.textContent).toBe('Open with default app failed: Programs and scripts are not opened');
    expect(root.querySelector('.vw-state-title')?.textContent).toBe("Can't show this file");
  });

  it('reads the exact size and shows the bytes as hex', async () => {
    commands.readFileBytes.mockResolvedValue(btoa(String.fromCharCode(0, 1, 2, 0x41, 0xff)));
    const root = mount({ ...blob, size: 5 });
    button(root, 'View as hex')!.click();
    await settle();
    expect(commands.readFileBytes).toHaveBeenCalledWith('data/cache.blob', 5);
    const hex = root.querySelector('.vw-hex');
    expect(hex?.getAttribute('aria-label')).toBe('Binary view of cache.blob');
    expect(root.querySelector('.vw-hex-bytes')?.textContent).toMatch(/00 01 02 41 ff/i);
    expect(root.querySelector('.vw-state-title')).toBeNull();
  });

  it('refuses the hex view above its read ceiling without reading', async () => {
    const root = mount({ ...blob, size: 64 * 1024 * 1024 });
    button(root, 'View as hex')!.click();
    await settle();
    expect(commands.readFileBytes).not.toHaveBeenCalled();
    expect(root.textContent).toContain('The hex view reads files up to');
  });

  it('offers only View as hex without desktop handlers', () => {
    const root = mount(blob, { desktop: false });
    expect([...root.querySelectorAll('.vw-state-actions button')].map(b => b.textContent)).toEqual(['View as hex']);
  });

  it('labels types from office kinds, viewer kinds and extensions', () => {
    expect(fileTypeLabel('cache.blob')).toBe('BLOB file');
    expect(fileTypeLabel('noextension')).toBe('Binary file');
    expect(fileTypeLabel('track.mp3')).not.toBe('MP3 file');
  });
});
