// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import DocxView from './DocxView';
import PptxView from './PptxView';
import XlsxView from './XlsxView';
import { buildDocx, buildPptx, buildXlsx } from '../../../lib/office/test-fixtures';
import { FileViewer } from '../FileViewer';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const settle = async (rounds = 3) => { for (let r = 0; r < rounds; r++) { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise(res => setTimeout(res, 0)); } };
const mount = (view: () => any) => { const root = document.createElement('div'); document.body.append(root); cleanup.push(render(view, root)); return root; };
const button = (root: ParentNode, name: string) => [...root.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const key = (element: Element, value: string, extra: KeyboardEventInit = {}) => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }));
const until = async (check: () => unknown, tries = 40) => { for (let i = 0; i < tries && !check(); i++) await settle(1); };

describe('DocxView', () => {
  it('renders the page, meta, comments and the outline mode', async () => {
    const meta = vi.fn();
    const root = mount(() => <DocxView name="notes.docx" bytes={buildDocx({ comments: true, pages: 3 })} onMeta={meta} />);
    expect(root.querySelector('[data-state="loading"]')).not.toBeNull();
    await until(() => root.querySelector('.ox-page h1'));
    expect(root.querySelector('.ox-page h1')?.textContent).toBe('Settings migration');
    expect(root.querySelector('.ox-page table')).not.toBeNull();
    expect(meta).toHaveBeenLastCalledWith(['3 pages', expect.stringMatching(/^\d+ words$/), '1 comment', 'Word document']);
    const card = root.querySelector('.ox-comment')!;
    expect(card.textContent).toContain('Maya');
    expect(card.textContent).toContain('the JSONC editor is unchanged');
    expect(card.textContent).toContain('Confirmed.');
    expect(card.textContent).toContain('1 reply');
    expect(root.querySelector('.ox-outline')).toBeNull();
    button(root, 'Outline')!.click(); await settle(1);
    expect([...root.querySelectorAll('.ox-outline-item')].map(b => b.textContent)).toEqual(['Settings migration', 'Summary', 'What changed', 'Open questions']);
    expect(button(root, 'Outline')!.getAttribute('aria-pressed')).toBe('true');
  });
  it('notes tracked changes and shows damaged and locked files with the shared states', async () => {
    const tracked = mount(() => <DocxView name="t.docx" bytes={buildDocx({ tracked: true })} />);
    await until(() => tracked.querySelector('.ox-page'));
    expect(tracked.querySelector('.vw-note')?.textContent).toContain('tracked changes');
    const broken = mount(() => <DocxView name="b.docx" bytes={new TextEncoder().encode('not a zip')} />);
    await until(() => broken.querySelector('[data-state="damaged"]'));
    expect(broken.querySelector('[data-state="damaged"]')?.textContent).toContain('Cannot open this document');
    const locked = mount(() => <DocxView name="l.docx" bytes={new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])} />);
    await until(() => locked.querySelector('[data-state="unsupported"]'));
    expect(locked.querySelector('[data-state="unsupported"]')?.textContent).toContain('Password protected');
  });
});

describe('PptxView', () => {
  const deck = () => buildPptx([{ title: 'Agent panel review', bullets: ['Steering', 'Queueing'], notes: 'Start with the queue.' }, { title: 'Second', chart: true }, { title: 'Third' }]);
  it('shows thumbnails, the stage, notes and the slide meta', async () => {
    const meta = vi.fn();
    const root = mount(() => <PptxView name="deck.pptx" bytes={deck()} onMeta={meta} />);
    await until(() => root.querySelector('.ox-slide-stage .ox-slide'));
    expect(meta).toHaveBeenLastCalledWith(['3 slides', '16:9', 'PowerPoint']);
    expect(root.querySelectorAll('.ox-thumb')).toHaveLength(3);
    expect(root.querySelector('.ox-slide-stage [role="group"]')?.getAttribute('aria-label')).toBe('Slide 1 of 3: Agent panel review');
    expect(root.querySelector('.ox-slide-stage')?.textContent).toContain('Steering');
    expect(root.querySelector('.ox-notes-text')?.textContent).toBe('Start with the queue.');
    button(root, 'Slide 2: Second')!.click(); await settle(1);
    expect(root.querySelector('.ox-slide-stage .ox-shape-placeholder')?.textContent).toBe('Chart');
    expect(root.querySelector('.ox-notes-text')?.textContent).toBe('No speaker notes for this slide.');
    key(root.querySelector('.ox-slide-stage')!, 'ArrowRight'); await settle(1);
    expect(root.querySelector('.ox-toolbar')?.textContent).toContain('Slide 3 of 3');
  });
  it('presents fullscreen with arrow navigation and leaves with Escape', async () => {
    const root = mount(() => <PptxView name="deck.pptx" bytes={deck()} />);
    await until(() => button(root, 'Present'));
    button(root, 'Present')!.click(); await settle(1);
    const overlay = root.querySelector<HTMLElement>('.ox-present')!;
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(overlay);
    key(overlay, 'ArrowRight'); await settle(1);
    expect(overlay.getAttribute('aria-label')).toBe('Presenting slide 2 of 3');
    key(overlay, 'End'); await settle(1);
    expect(overlay.getAttribute('aria-label')).toBe('Presenting slide 3 of 3');
    key(overlay, 'Escape'); await settle(1);
    expect(root.querySelector('.ox-present')).toBeNull();
    expect(document.activeElement?.textContent).toContain('Present');
  });
});

describe('XlsxView', () => {
  const book = () => buildXlsx([
    { name: 'Startup', rows: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><f>SUM(1,2)</f><v>3</v></c></row><row r="3"><c r="A3"><v>7</v></c></row>', merges: ['A3:B3'] },
    { name: 'Memory', rows: '<row r="1"><c r="A1"><v>42</v></c></row>' },
  ], ['Name', 'Median', 'Span']);
  it('shows the grid, formula bar, sheet tabs and status, and moves the selection with arrows', async () => {
    const meta = vi.fn();
    const root = mount(() => <XlsxView name="bench.xlsx" bytes={book()} onMeta={meta} />);
    await until(() => root.querySelector('.ox-grid'));
    expect(meta).toHaveBeenLastCalledWith(['2 sheets', '3 rows', 'Excel workbook']);
    expect([...root.querySelectorAll('.ox-col-head')].map(th => th.textContent)).toEqual(['A', 'B']);
    expect(root.querySelector('.ox-sheet-status')?.textContent).toContain('Showing rows 1 to 3 of 3');
    expect(root.querySelector('.ox-ref')?.textContent).toBe('A1');
    expect(root.querySelector('.ox-fx-text')?.textContent).toBe('Name');
    const grid = root.querySelector<HTMLElement>('[role="grid"]')!;
    key(grid, 'ArrowDown'); key(grid, 'ArrowRight'); await settle(1);
    expect(root.querySelector('.ox-ref')?.textContent).toBe('B2');
    expect(root.querySelector('.ox-fx-text')?.textContent).toBe('=SUM(1,2)');
    expect(grid.getAttribute('aria-activedescendant')).toBe(root.querySelector('.ox-sel')?.id);
    expect(root.querySelector('.ox-sel')?.textContent).toBe('3');
    const merged = [...root.querySelectorAll('td')].find(td => td.textContent === '7')!;
    expect(merged.getAttribute('colspan')).toBe('2');
    const tabs = [...root.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(tabs.map(t => t.textContent)).toEqual(['Startup', 'Memory']);
    tabs[1].click(); await settle(1);
    expect(root.querySelector('.ox-fx-text')?.textContent).toBe('42');
  });
  it('windows rows and says how many are shown', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
    const root = mount(() => <XlsxView name="big.xlsx" bytes={buildXlsx([{ name: 'Big', rows }])} />);
    await until(() => root.querySelector('.ox-grid'));
    expect(root.querySelectorAll('tbody tr:not(.ox-spacer)')).toHaveLength(400);
    expect(root.querySelector('.ox-sheet-status')?.textContent).toContain('Showing rows 1 to 450 of 450');
    expect(root.querySelector<HTMLElement>('tbody tr.ox-spacer')?.style.height).toBe(`${50 * 26}px`);
  });
});

describe('FileViewer dispatch', () => {
  it('mounts the document viewers lazily for their kinds and shows their footer facts', async () => {
    const root = mount(() => <FileViewer name="bench.xlsx" content={{ status: 'ready', bytes: buildXlsx([{ name: 'S', rows: '<row r="1"><c r="A1"><v>1</v></c></row>' }]) }} />);
    await until(() => root.querySelector('.ox-grid'));
    expect(root.querySelector('section')?.getAttribute('data-kind')).toBe('office');
    expect(root.querySelector('.vw-footer')?.textContent).toContain('1 sheet');
    expect(root.querySelector('.vw-footer')?.textContent).toContain('Excel workbook');
  });
});
