// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { Show, createSignal } from 'solid-js';
import { FileViewer, type FileViewerProps } from './FileViewer';
import { OFFICE_PREVIEW_BYTES } from '../../lib/office/limits';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
const mount = (view: () => any) => { const root = document.createElement('div'); document.body.append(root); cleanup.push(render(view, root)); return root; };
const bytes = (text: string) => new TextEncoder().encode(text);
const ready = (data: Uint8Array | string) => ({ status: 'ready' as const, ...(typeof data === 'string' ? { text: data } : { bytes: data }) });
const show = (props: Partial<FileViewerProps> & Pick<FileViewerProps, 'name'>) => mount(() => <FileViewer content={ready('')} {...props} />);
const button = (root: ParentNode, name: string) => [...root.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const key = (element: Element, value: string) => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><script>alert(1)</script><rect width="16" height="16"/></svg>';

describe('source bar and actions', () => {
  it('shows the source and only the actions whose handler is given', () => {
    const root = show({ name: 'a.txt', content: ready('hi'), source: { agent: { name: 'Claude' }, session: 'Match the toggle spec', time: 'you, 14:02' } });
    expect(root.querySelector('.vw-source')?.textContent).toContain('Attached in');
    expect(root.querySelector('.vw-source')?.textContent).toContain('Match the toggle spec');
    expect(root.querySelector('.vw-source')?.textContent).toContain('you, 14:02');
    expect(button(root, 'Save to workspace')).toBeUndefined();
    expect(button(root, 'More actions')).toBeUndefined();
  });
  it('lists exactly the given actions, runs them and closes the menu with Escape', async () => {
    const copy = vi.fn(), remove = vi.fn(), save = vi.fn();
    const root = show({ name: 'a.txt', content: ready('hi'), onCopyPath: copy, onRemove: remove, onSaveToWorkspace: save });
    expect(button(root, 'Save to workspace')).toBeDefined();
    const trigger = button(root, 'More actions')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.click(); await settle();
    const items = [...root.querySelectorAll('[role="menuitem"]')].map(item => item.textContent);
    expect(items).toEqual(['Copy path', 'Remove']);
    expect(document.activeElement?.textContent).toBe('Copy path');
    key(document.activeElement!, 'Escape'); await settle();
    expect(root.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.click(); await settle();
    (root.querySelectorAll('[role="menuitem"]')[1] as HTMLButtonElement).click(); await settle();
    expect(remove).toHaveBeenCalledTimes(1);
    button(root, 'Save to workspace')!.click(); await settle();
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('shows a failure of an action instead of swallowing it, and hides save for workspace files', async () => {
    const root = show({ name: 'a.txt', content: ready('hi'), onSaveToWorkspace: async () => { throw new Error('disk full'); } });
    button(root, 'Save to workspace')!.click(); await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('disk full');
    const other = show({ name: 'b.txt', content: ready('hi'), inWorkspace: true, onSaveToWorkspace: () => undefined });
    expect(button(other, 'Save to workspace')).toBeUndefined();
    expect(other.textContent).not.toContain('Read-only attachment');
  });
});

describe('text and code', () => {
  it('shows line numbers, the read-only banner and footer meta', () => {
    const root = show({ name: 'a.ts', mime: 'text/typescript', content: ready('one\ntwo\nthree\n') });
    expect(root.querySelector('.vw-gutter')?.textContent).toBe('1\n2\n3');
    expect(root.querySelector('.vw-code')?.textContent).toBe('one\ntwo\nthree\n');
    expect(root.querySelector('.vw-banner')?.textContent).toContain('Read-only attachment, not in the workspace');
    expect(root.querySelector('.vw-footer')?.textContent).toContain('3 lines');
    expect(root.querySelector('[aria-label="View mode"]')).toBeNull();
  });
  it('renders hostile text as text', () => {
    const root = show({ name: 'x.txt', content: ready('<img src=x onerror=alert(1)><script>1</script>') });
    expect(root.querySelector('.vw-code img, .vw-code script')).toBeNull();
  });
});

describe('modes', () => {
  it('SVG switches between preview, split and source and keeps the preview inert', async () => {
    const root = show({ name: 'a.svg', content: ready(svgText) });
    const group = root.querySelector('[aria-label="View mode"]')!;
    expect([...group.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Preview', 'Split', 'Source']);
    expect(root.querySelector('.vw-code')).toBeNull();
    const img = root.querySelector('img') as HTMLImageElement;
    expect(img.src).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(img.src)).not.toContain('script');
    button(group as HTMLElement, 'Split')!.click(); await settle();
    expect(root.querySelector('.vw-code')?.textContent).toContain('<script>');
    expect(root.querySelector('img')).not.toBeNull();
    button(group as HTMLElement, 'Source')!.click(); await settle();
    expect(root.querySelector('img')).toBeNull();
    expect(button(group as HTMLElement, 'Source')?.getAttribute('aria-pressed')).toBe('true');
  });
  it('markdown reuses MarkdownPreview and JSON gets a tree with a text source', async () => {
    const md = show({ name: 'n.md', content: ready('# Title\n\nhello') });
    await settle();
    expect(md.querySelector('.markdown-body')).not.toBeNull();
    button(md, 'Source')!.click(); await settle();
    expect(md.querySelector('.vw-code')?.textContent).toContain('# Title');
    const json = show({ name: 'a.json', content: ready('{"a":{"b":[1,2]}}') });
    expect(json.querySelector('[role="tree"]')).not.toBeNull();
    const toggle = button(json, 'Collapse root')!;
    toggle.click(); await settle();
    expect(json.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    expect(button(json, 'Expand root')?.getAttribute('aria-label')).toBe('Expand root');
  });
  it('invalid JSON falls back to text with a visible reason', () => {
    const root = show({ name: 'a.json', content: ready('{oops') });
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Not valid JSON');
    expect(root.querySelector('.vw-code')?.textContent).toBe('{oops');
  });
});

describe('image', () => {
  it('fits, zooms within 10 to 800 and switches background', async () => {
    const root = show({ name: 'a.png', mime: 'image/png', content: ready(png) });
    const img = root.querySelector('img') as HTMLImageElement;
    expect(img.src).toMatch(/^data:image\/png;base64,/);
    Object.defineProperty(img, 'naturalWidth', { value: 40 }); Object.defineProperty(img, 'naturalHeight', { value: 20 });
    img.dispatchEvent(new Event('load')); await settle();
    expect(root.querySelector('.vw-footer')?.textContent).toContain('40 × 20 px');
    const readout = () => root.querySelector('[aria-label="Zoom level"]')!.textContent;
    expect(readout()).toBe('Fit');
    button(root, 'Zoom in')!.click(); await settle();
    expect(readout()).toBe('125%');
    expect(img.style.width).toBe('50px');
    button(root, 'Actual size')!.click(); await settle();
    for (let i = 0; i < 40; i++) button(root, 'Zoom in')!.click();
    await settle(); expect(readout()).toBe('800%');
    expect(button(root, 'Zoom in')!.disabled).toBe(true);
    for (let i = 0; i < 60; i++) button(root, 'Zoom out')!.click();
    await settle(); expect(readout()).toBe('10%');
    expect(button(root, 'Zoom out')!.disabled).toBe(true);
    key(root.querySelector('.vw-stage')!, '0'); await settle();
    expect(readout()).toBe('Fit');
    button(root, 'Dark')!.click(); await settle();
    expect(root.querySelector('.vw-stage')?.getAttribute('data-background')).toBe('dark');
  });
  it('shows the damaged state when the image cannot be decoded and can open it as binary', async () => {
    const root = show({ name: 'broken.png', content: ready(png) });
    root.querySelector('img')!.dispatchEvent(new Event('error')); await settle();
    expect(root.querySelector('[data-state="damaged"]')?.textContent).toContain('could not decode this image');
    button(root, 'Open as binary')!.click(); await settle();
    expect(root.querySelector('.vw-hex-row')?.textContent).toContain('89 50 4e 47');
  });
  it('refuses images over 8 MiB with an explanation', () => {
    const root = show({ name: 'big.png', size: 9 * 1024 * 1024, content: ready(png) });
    expect(root.querySelector('[data-state="too-large"]')?.textContent).toContain('limited to 8 MiB');
  });
});

describe('edge states', () => {
  it('loading, gone and errors are announced', () => {
    expect(show({ name: 'd.png', content: { status: 'loading' } }).querySelector('[data-state="loading"]')?.textContent).toContain('Loading d.png');
    const onList = vi.fn();
    const gone = show({ name: 't.zip', content: { status: 'gone' }, onShowSessionList: onList });
    expect(gone.querySelector('[data-state="gone"]')?.textContent).toContain('no longer available');
    button(gone, 'Show session list')!.click();
    expect(onList).toHaveBeenCalled();
    expect(show({ name: 'x.txt', content: { status: 'error', message: 'read failed' } }).querySelector('[role="alert"]')?.textContent).toContain('read failed');
  });
  it('gates a text file over 2 MiB and then shows only the first 2 MiB', async () => {
    const data = new Uint8Array(2 * 1024 * 1024 + 1000).fill(97);
    const root = show({ name: 'build.log', content: ready(data) });
    expect(root.querySelector('[data-state="too-large"]')?.textContent).toContain('Showing the first 2 MiB');
    button(root, 'Show first 2 MiB')!.click(); await settle();
    expect(root.querySelector('.vw-code')?.textContent?.length).toBe(2 * 1024 * 1024);
    expect(root.querySelector('.vw-note')?.textContent).toContain('first 2.0 MiB');
  });
  it('shows binary files as hex with a banner', () => {
    const root = show({ name: 'core.bin', mime: 'application/octet-stream', content: ready(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1])), onOpenWithSystem: () => undefined });
    expect(root.querySelector('.vw-hex-row')?.textContent).toContain('7f 45 4c 46');
    expect(root.querySelector('.vw-binary')?.textContent).toContain('Binary file · application/octet-stream');
    expect(root.querySelector('.vw-binary button')?.textContent).toBe('Open with system app');
  });
  it('is honest about formats whose viewers are separate work', () => {
    for (const name of ['a.7z']) {
      const root = show({ name, content: ready(bytes('x')) });
      expect(root.querySelector('[data-state="unsupported"]')?.textContent).toContain('files cannot be previewed here');
      expect(root.querySelector('.vw-code, .vw-json, img, video, audio')).toBeNull();
    }
    const heic = show({ name: 'm.heic', content: ready(bytes('x')) });
    expect(heic.querySelector('[data-state="unsupported"]')?.textContent).toContain('This format is not supported');
  });
});

describe('audio and video', () => {
  let created: string[]; let revoked: string[]; let play: ReturnType<typeof vi.fn>; let pause: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    created = []; revoked = [];
    URL.createObjectURL = vi.fn(() => { const url = `blob:test/${created.length}`; created.push(url); return url; }) as never;
    URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); }) as never;
    play = vi.fn(() => Promise.resolve()); pause = vi.fn();
    HTMLMediaElement.prototype.play = play as never; HTMLMediaElement.prototype.pause = pause as never;
  });
  const media = (root: ParentNode) => root.querySelector('video,audio') as HTMLMediaElement;
  const loaded = (element: HTMLMediaElement, duration: number) => { Object.defineProperty(element, 'duration', { value: duration, configurable: true }); element.dispatchEvent(new Event('loadedmetadata')); };

  it('creates a blob URL, never autoplays and revokes the URL on cleanup', async () => {
    const [shown, setShown] = createSignal(true);
    const root = mount(() => <Show when={shown()}><FileViewer name="clip.mp4" content={ready(new Uint8Array([0, 0, 0, 24]))} /></Show>);
    const video = media(root);
    expect(video.tagName).toBe('VIDEO');
    expect(video.getAttribute('src')).toBe('blob:test/0');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(play).not.toHaveBeenCalled();
    setShown(false); await settle();
    expect(revoked).toEqual(['blob:test/0']);
  });
  it('revokes the previous URL when the file changes', async () => {
    const [data, setData] = createSignal(new Uint8Array([1]));
    mount(() => <FileViewer name="a.mp3" content={ready(data())} />);
    setData(new Uint8Array([2])); await settle();
    expect(created).toHaveLength(2);
    expect(revoked).toEqual(['blob:test/0']);
  });
  it('plays, pauses, seeks 10 s, changes speed, loop and volume, with Space and arrow keys', async () => {
    const root = show({ name: 'talk.m4a', content: ready(new Uint8Array([1, 2])) });
    const audio = media(root);
    expect(audio.tagName).toBe('AUDIO');
    loaded(audio, 192);
    expect(root.querySelector('.vw-time')?.textContent).toBe('0:00 / 3:12');
    const player = root.querySelector('.vw-player')!;
    key(player, ' '); await settle();
    expect(play).toHaveBeenCalledTimes(1);
    audio.dispatchEvent(new Event('play')); await settle();
    expect(button(root, 'Pause')).toBeDefined();
    Object.defineProperty(audio, 'paused', { value: false, configurable: true });
    key(player, ' '); expect(pause).toHaveBeenCalledTimes(1);
    audio.currentTime = 30;
    key(player, 'ArrowRight'); expect(audio.currentTime).toBe(40);
    key(player, 'ArrowLeft'); expect(audio.currentTime).toBe(30);
    button(root, 'Forward 10 seconds')!.click(); expect(audio.currentTime).toBe(40);
    button(root, 'Back 10 seconds')!.click(); expect(audio.currentTime).toBe(30);
    button(root, 'Speed 1.5 times')!.click(); await settle();
    expect(audio.playbackRate).toBe(1.5);
    expect(button(root, 'Speed 1.5 times')!.getAttribute('aria-pressed')).toBe('true');
    button(root, 'Loop')!.click(); await settle();
    expect(audio.loop).toBe(true);
    key(player, 'ArrowDown'); await settle();
    expect(audio.volume).toBeCloseTo(0.9);
    key(player, 'm'); await settle();
    expect(audio.muted).toBe(true);
    expect(button(root, 'Unmute')).toBeDefined();
  });
  it('does not steal Space from a focused button', async () => {
    const root = show({ name: 'talk.m4a', content: ready(new Uint8Array([1])) });
    key(button(root, 'Loop')!, ' ');
    expect(play).not.toHaveBeenCalled();
  });
  it('shows a play failure and a decode failure instead of failing silently', async () => {
    play.mockRejectedValueOnce(new Error('NotSupportedError'));
    const root = show({ name: 'clip.mp4', content: ready(new Uint8Array([1])) });
    button(root, 'Play')!.click(); await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('NotSupportedError');
    media(root).dispatchEvent(new Event('error')); await settle();
    expect(root.querySelector('[data-state="damaged"]')?.textContent).toContain('codec may not be supported on this platform');
    expect(revoked).toEqual(['blob:test/0']);
  });
});


it.each([['a.pdf', 'pdf'], ['a.docx', 'docx'], ['a.pptx', 'pptx'], ['a.xlsx', 'xlsx'], ['a.zip', 'archive']] as const)('explains an oversized %s before trying to load a lazy decoder', (name, kind) => {
  const root = show({ name, size: OFFICE_PREVIEW_BYTES[kind] + 1, content: { status: 'ready' } });
  expect(root.querySelector('[data-state="too-large"]')?.textContent).toContain('preview is limited');
  expect(root.querySelector('[data-state="damaged"]')).toBeNull();
});

it('reports incomplete binary document data instead of sending a prefix to the decoder', () => {
  const root = show({ name: 'partial.pdf', size: 100_000, content: ready(bytes('%PDF-1.7')) });
  expect(root.querySelector('[data-state="damaged"]')?.textContent).toContain('file data is incomplete');
});
