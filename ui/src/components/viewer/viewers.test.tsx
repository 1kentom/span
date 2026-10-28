// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { Show, createSignal } from 'solid-js';
import { FileViewer, type FileViewerProps } from './FileViewer';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); } };
const mount = (view: () => any) => { const root = document.createElement('div'); document.body.append(root); cleanup.push(render(view, root)); return root; };
const bytes = (text: string) => new TextEncoder().encode(text);
const show = (props: Partial<FileViewerProps> & Pick<FileViewerProps, 'name'>) => mount(() => <FileViewer content={{ status: 'ready', bytes: new Uint8Array() }} {...props} />);
const button = (root: ParentNode, name: string) => [...root.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const modes = (root: ParentNode) => [...root.querySelectorAll('[aria-label="View mode"] button')].map(b => b.textContent?.trim());

describe('mode switch per kind', () => {
  it('uses icon modes for Markdown, MDX and HTML, and words for JSON and CSV', () => {
    for (const name of ['a.md', 'a.mdx', 'a.html']) expect(modes(show({ name, content: { status: 'ready', text: '# x' } })), name).toEqual(['Preview', 'Split', 'Source']);
    expect(modes(show({ name: 'a.json', content: { status: 'ready', text: '{"a":1}' } }))).toEqual(['Tree', 'Raw']);
    expect(modes(show({ name: 'a.csv', content: { status: 'ready', text: 'a,b\n1,2' } }))).toEqual(['Table', 'Raw']);
    expect(show({ name: 'a.txt', content: { status: 'ready', text: 'x' } }).querySelector('[aria-label="View mode"]')).toBeNull();
    const image = show({ name: 'a.png', content: { status: 'ready', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) } });
    expect([...image.querySelectorAll('[aria-label="Image size"] button')].map(b => b.textContent)).toEqual(['Fit', 'Actual size']);
  });
  it('moves between modes with the arrow keys', async () => {
    const root = show({ name: 'a.md', content: { status: 'ready', text: '# Title' } });
    const group = root.querySelector('[aria-label="View mode"]')!;
    group.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle(1);
    expect(button(group, 'Split')!.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('.vw-split:not(.vw-single)')).not.toBeNull();
  });
});

describe('CSV table', () => {
  const csv = ['session_id,agent,tokens', ...Array.from({ length: 450 }, (_, i) => `ses_${i},${i % 2 ? 'claude' : 'codex'},${(i * 37) % 1000}`)].join('\n');
  it('detects the header, pages 200 rows at a time and loads more', async () => {
    const root = show({ name: 'sessions.csv', content: { status: 'ready', text: csv } });
    await settle();
    expect(root.querySelector('.vw-csv-bar')?.textContent).toContain('Comma-separated · UTF-8 · header row detected');
    expect([...root.querySelectorAll('thead th')].map(th => th.textContent?.trim())).toEqual(['Row', 'session_id', 'agent', 'tokens']);
    expect(root.querySelectorAll('tbody tr')).toHaveLength(200);
    expect(root.querySelector('.vw-csv-bar [role="status"]')?.textContent).toBe('Showing rows 1 to 200 of 450');
    button(root, 'Load more')!.click(); await settle(1);
    expect(root.querySelectorAll('tbody tr')).toHaveLength(400);
    button(root, 'Load more')!.click(); await settle(1);
    expect(root.querySelectorAll('tbody tr')).toHaveLength(450);
    expect(button(root, 'Load more')).toBeUndefined();
    expect(root.querySelector('.vw-footer')?.textContent).toContain('450 rows');
    expect(root.querySelector('.vw-footer')?.textContent).toContain('3 columns');
  });
  it('sorts by a column with aria-sort and numeric order, then turns sorting off', async () => {
    const root = show({ name: 'n.csv', content: { status: 'ready', text: 'name,score\nann,10\nbo,9\ncy,100' } });
    await settle();
    const th = () => root.querySelectorAll('thead th')[2];
    (th().querySelector('button') as HTMLButtonElement).click(); await settle(1);
    expect(th().getAttribute('aria-sort')).toBe('ascending');
    expect([...root.querySelectorAll('tbody tr td:nth-of-type(1)')].map(td => td.textContent)).toEqual(['bo', 'ann', 'cy']);
    (th().querySelector('button') as HTMLButtonElement).click(); await settle(1);
    expect(th().getAttribute('aria-sort')).toBe('descending');
    (th().querySelector('button') as HTMLButtonElement).click(); await settle(1);
    expect(th().getAttribute('aria-sort')).toBe('none');
  });
  it('shows raw text in Raw mode and explains ragged rows and a missing header', async () => {
    const root = show({ name: 'r.csv', content: { status: 'ready', text: '1,2\n3\n4,5' } });
    await settle();
    expect(root.querySelector('.vw-csv-bar')?.textContent).toContain('no header row');
    expect(root.textContent).toContain('1 row has a different number of columns');
    button(root, 'Raw')!.click(); await settle(1);
    expect(root.querySelector('.vw-code')?.textContent).toBe('1,2\n3\n4,5');
  });
});

describe('HTML sandbox', () => {
  it('renders in a fully sandboxed iframe, without scripts, and lists missing files', () => {
    const html = '<!doctype html><html><head><link rel="stylesheet" href="spec.css"></head><body><h1 onclick="steal()">Theme toggle</h1><script src="analytics.js"></script><script>alert(1)</script></body></html>';
    const root = show({ name: 'toggle-spec.html', content: { status: 'ready', text: html } });
    const frame = root.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    const srcdoc = frame.getAttribute('srcdoc') ?? (frame as HTMLIFrameElement).srcdoc;
    expect(srcdoc).toContain('Theme toggle');
    expect(srcdoc).not.toMatch(/<script|onclick|alert/);
    expect(root.querySelector('.vw-chip-ok')?.textContent).toBe('Sandboxed: scripts and network blocked');
    expect(root.querySelector('.vw-chip-warn')?.textContent).toContain('spec.css, analytics.js');
    expect(root.querySelector('.vw-footer')?.textContent).toContain('Sandboxed preview');
  });
});

describe('MDX', () => {
  it('shows the note, renders only the Markdown and never runs anything', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const root = show({ name: 'steering.mdx', content: { status: 'ready', text: 'import { Kbd } from "./Kbd";\nexport const x = alert("esm");\n\n# Steering\n\nPress <Kbd>Enter</Kbd>. {alert("expr")}\n' } });
    await settle();
    expect(root.querySelector('.vw-chip-info')?.textContent).toContain('MDX components are not run here: Kbd');
    expect(root.querySelector('.markdown-body h1')?.textContent).toBe('Steering');
    expect(root.querySelector('.markdown-body')?.textContent).not.toMatch(/alert|import|Kbd/);
    expect(alert).not.toHaveBeenCalled();
    button(root, 'Source')!.click(); await settle(1);
    expect(root.querySelector('.vw-code')?.textContent).toContain('import { Kbd }');
  });
});

describe('font specimen', () => {
  const ttf = () => { const data = new Uint8Array(64); new DataView(data.buffer).setUint32(0, 0x00010000); return data; };
  it('loads the face from bytes, shows the specimen and removes the face on cleanup', async () => {
    const faces = new Set<unknown>();
    class FakeFace { constructor(public family: string) {} load() { return Promise.resolve(this); } }
    vi.stubGlobal('FontFace', FakeFace);
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add: (f: unknown) => faces.add(f), delete: (f: unknown) => faces.delete(f) } });
    const [visible, setVisible] = createSignal(true);
    const root = mount(() => <Show when={visible()}><FileViewer name="Mono-Regular.ttf" content={{ status: 'ready', bytes: ttf() }} /></Show>);
    await settle();
    expect(faces.size).toBe(1);
    expect(root.querySelector('.vw-font-aa')?.textContent).toBe('Aa');
    expect([...root.querySelectorAll('.vw-font-size')].map(n => n.textContent)).toEqual(['12', '16', '24', '36']);
    const input = root.querySelector('input[aria-label="Sample text"]') as HTMLInputElement;
    input.value = 'Hello span'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); await settle(1);
    expect(root.querySelector('.vw-font-ramp')?.textContent).toContain('Hello span');
    expect(root.querySelector('.vw-footer')?.textContent).toContain('TrueType');
    setVisible(false); await settle(1);
    expect(faces.size).toBe(0);
  });
  it('shows the damaged state for invalid and oversize fonts', async () => {
    const bad = show({ name: 'fake.woff2', content: { status: 'ready', bytes: bytes('<html>not a font</html>') } });
    await settle();
    expect(bad.querySelector('[data-state="damaged"]')?.textContent).toContain('not a font');
    const big = show({ name: 'huge.ttf', size: 17 * 1024 * 1024, content: { status: 'ready' } });
    expect(big.querySelector('[data-state="damaged"]')?.textContent).toContain('larger than 16 MiB');
  });
});

describe('audio waveform', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:test/audio') as never;
    URL.revokeObjectURL = vi.fn() as never;
  });
  it('decodes with WebAudio, draws bars on a canvas and seeks by pointer', async () => {
    const samples = new Float32Array(44100).map((_, i) => Math.sin(i / 50) * (i / 44100));
    class FakeOffline { constructor(..._args: unknown[]) {} decodeAudioData() { return Promise.resolve({ numberOfChannels: 1, sampleRate: 44100, duration: 1, getChannelData: () => samples }); } }
    vi.stubGlobal('OfflineAudioContext', FakeOffline);
    const fills: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ setTransform() {}, clearRect() {}, beginPath() {}, rect() {}, fill() { fills.push('bar'); }, set fillStyle(_v: string) {} }) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(440);
    const root = show({ name: 'standup.m4a', content: { status: 'ready', bytes: new Uint8Array([1, 2, 3]) } });
    await settle();
    expect(root.querySelector('.vw-wave-canvas')).not.toBeNull();
    expect(fills).toHaveLength(110);
    expect(root.querySelector('.vw-footer')?.textContent).toContain('AAC · mono');
    expect(root.querySelector('.vw-footer')?.textContent).not.toContain('kHz');
    const audio = root.querySelector('audio')!;
    Object.defineProperty(audio, 'duration', { value: 200, configurable: true });
    audio.dispatchEvent(new Event('loadedmetadata')); await settle(1);
    const wave = root.querySelector('[role="slider"][aria-label="Seek"]') as HTMLElement;
    vi.spyOn(wave, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 400, top: 0, height: 96, right: 400, bottom: 96, x: 0, y: 0, toJSON() {} });
    wave.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, button: 0, bubbles: true }));
    expect(audio.currentTime).toBe(50);
    expect(wave.getAttribute('aria-valuetext')).toBe('0:50 of 3:20');
    root.querySelector('.vw-player')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
    expect(audio.currentTime).toBe(60);
    root.querySelector('.vw-player')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', bubbles: true }));
    expect(audio.currentTime).toBe(50);
  });
  it('still plays without a waveform and says why', async () => {
    const root = show({ name: 'a.mp3', content: { status: 'ready', bytes: new Uint8Array([1]) } });
    await settle();
    expect(root.querySelector('.vw-wave-note')?.textContent).toContain('Waveform unavailable: WebAudio is not available');
    expect(button(root, 'Play')).toBeDefined();
  });
  it('renders a transcript and chapters only when provided', async () => {
    const plain = show({ name: 'a.mp3', content: { status: 'ready', bytes: new Uint8Array([1]) } });
    expect(plain.querySelector('.vw-transcript')).toBeNull();
    const rich = show({ name: 'a.mp3', content: { status: 'ready', bytes: new Uint8Array([1]) }, extras: { transcript: [{ at: 0, speaker: 'Maya', text: 'Hello' }, { at: 41, text: 'Second' }], chapters: [{ at: 64, label: 'Toolchain' }] } });
    expect([...rich.querySelectorAll('.vw-transcript-line')].map(l => l.textContent)).toEqual(['0:00Maya Hello', '0:41Second']);
    expect(rich.querySelector('.vw-wave-mark')?.getAttribute('title')).toBe('Toolchain');
  });
});

describe('video controls', () => {
  beforeEach(() => { URL.createObjectURL = vi.fn(() => 'blob:test/video') as never; URL.revokeObjectURL = vi.fn() as never; HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve()) as never; });
  it('offers skip, speed, loop, mute, full screen and shows the buffered range', async () => {
    const root = show({ name: 'clip.mp4', content: { status: 'ready', bytes: new Uint8Array([1]) } });
    const video = root.querySelector('video')!;
    Object.defineProperty(video, 'duration', { value: 64, configurable: true });
    Object.defineProperty(video, 'buffered', { configurable: true, value: { length: 1, start: () => 0, end: () => 32 } });
    video.dispatchEvent(new Event('loadedmetadata')); await settle(1);
    expect(root.querySelector('.vw-seek-buffered')?.getAttribute('style')).toContain('width: 50%');
    button(root, 'Forward 10 seconds')!.click(); expect(video.currentTime).toBe(10);
    button(root, 'Playback speed 1 times, change')!.click(); await settle(1);
    expect(video.playbackRate).toBe(1.5);
    button(root, 'Loop')!.click(); await settle(1); expect(video.loop).toBe(true);
    button(root, 'Mute')!.click(); await settle(1); expect(video.muted).toBe(true);
    const player = root.querySelector('.vw-player') as HTMLElement & { requestFullscreen: () => Promise<void> };
    player.requestFullscreen = vi.fn(() => Promise.resolve());
    button(root, 'Full screen')!.click();
    expect(player.requestFullscreen).toHaveBeenCalled();
  });
});

describe('unsupported state', () => {
  it('offers only real actions: system app and reveal when given, and View as binary', async () => {
    const open = vi.fn(), reveal = vi.fn();
    const root = show({ name: 'Agent panel.fig', content: { status: 'ready', bytes: bytes('fig-kiwi') }, onOpenWithSystem: open, onReveal: reveal, revealLabel: 'Reveal in Finder' });
    const state = root.querySelector('[data-state="unsupported"]')!;
    expect(state.querySelector('.vw-state-title')?.textContent).toBe('Figma files cannot be previewed here');
    expect([...state.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Open with system app', 'Reveal in Finder', 'View as binary']);
    button(state, 'View as binary')!.click(); await settle(1);
    expect(root.querySelector('.vw-hex-row')?.textContent).toContain('66 69 67');
    const bare = show({ name: 'x.fig', content: { status: 'ready', bytes: bytes('x') } });
    expect([...bare.querySelectorAll('[data-state="unsupported"] button')].map(b => b.textContent)).toEqual(['View as binary']);
  });
});
