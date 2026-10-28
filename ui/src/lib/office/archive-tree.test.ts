import { describe, expect, it } from 'vitest';
import { allDirIds, buildArchiveTree, checkState, extractGate, isHiddenEntry, isUnsafePath, selectedPaths, toggleSelection, visibleRows } from './archive-tree';
import type { ArchiveEntry } from '../archive-api';

const f = (path: string, size = 10, packed = 5): ArchiveEntry => ({ path, dir: false, size, packed });
const d = (path: string): ArchiveEntry => ({ path, dir: true, size: 0, packed: 0 });

describe('unsafe paths', () => {
  it.each([
    ['../evil.sh', true], ['a/../../b', true], ['/etc/passwd', true], ['C:\\Windows\\x', true], ['c:/x', true], ['a\\..\\b', true], ['a/\u0000b', true],
    ['a/b/c.txt', false], ['./a.txt', false], ['a..b/c', false], ['..hidden', false],
  ])('%s is unsafe: %s', (path, unsafe) => { expect(isUnsafePath(path)).toBe(unsafe); });
  it('flags hidden metadata entries', () => {
    expect(isHiddenEntry('__MACOSX/a/._b')).toBe(true);
    expect(isHiddenEntry('dist/.DS_Store')).toBe(true);
    expect(isHiddenEntry('dist/a.js')).toBe(false);
  });
});

describe('archive tree', () => {
  it('nests flat paths, creates implicit folders and totals sizes', () => {
    const tree = buildArchiveTree([f('dist/assets/a.js', 100, 40), f('dist/index.html', 20, 10), d('logs/'), f('README.md', 5, 5)]);
    expect(tree.root.map(n => n.name)).toEqual(['dist', 'logs', 'README.md']);
    const dist = tree.root[0];
    expect(dist.dir && dist.implicit).toBe(true);
    expect(dist.children.map(n => n.name)).toEqual(['assets', 'index.html']);
    expect(dist.size).toBe(120);
    expect(dist.packed).toBe(50);
    expect([tree.files, tree.folders, tree.size, tree.packed]).toEqual([3, 3, 125, 55]);
  });
  it('keeps a file and a folder with the same name apart and keeps duplicate paths', () => {
    const tree = buildArchiveTree([f('a'), f('a/b'), f('x/y'), f('x/y')]);
    expect(tree.root.map(n => [n.name, n.dir])).toEqual([['a', true], ['x', true], ['a', false]]);
    expect(tree.root[1].children).toHaveLength(2);
    expect(new Set(tree.root[1].children.map(n => n.id)).size).toBe(2);
  });
  it('handles deep paths, backslashes and ./ prefixes', () => {
    const deep = Array.from({ length: 40 }, (_, i) => `d${i}`).join('/') + '/leaf.txt';
    const tree = buildArchiveTree([f(deep), f('win\\dir\\file.txt'), f('./dot.txt')]);
    let node = tree.root.find(n => n.name === 'd0')!;
    let depth = 0;
    while (node.children.length) { node = node.children[0]; depth++; }
    expect(node.name).toBe('leaf.txt');
    expect(depth).toBe(40);
    expect(tree.root.find(n => n.name === 'win')?.children[0].children[0].path).toBe('win/dir/file.txt');
    expect(tree.root.some(n => n.name === 'dot.txt')).toBe(true);
  });
  it('flags unsafe entries, keeps them out of folders and out of totals', () => {
    const tree = buildArchiveTree([f('ok.txt'), f('../evil.sh', 99), f('/abs/x', 99)]);
    expect(tree.unsafe.map(e => e.path)).toEqual(['../evil.sh', '/abs/x']);
    expect(tree.root.filter(n => n.unsafe).map(n => n.name)).toEqual(['../evil.sh', '/abs/x']);
    expect(tree.files).toBe(1);
    expect(tree.size).toBe(10);
  });
});

describe('filter and selection', () => {
  const tree = buildArchiveTree([f('dist/assets/a.js'), f('dist/assets/b.css'), f('dist/index.html'), f('logs/build.log'), f('../evil')]);
  it('shows open folders only and filters with ancestors expanded', () => {
    expect(visibleRows(tree.root, new Set(), '').map(r => r.node.name)).toEqual(['dist', 'logs', '../evil']);
    const open = new Set(allDirIds(tree.root));
    expect(visibleRows(tree.root, open, '').map(r => [r.node.name, r.depth])).toEqual([['dist', 0], ['assets', 1], ['a.js', 2], ['b.css', 2], ['index.html', 1], ['logs', 0], ['build.log', 1], ['../evil', 0]]);
    expect(visibleRows(tree.root, new Set(), 'CSS').map(r => r.node.name)).toEqual(['dist', 'assets', 'b.css']);
    expect(visibleRows(tree.root, new Set(), 'nothing')).toEqual([]);
  });
  it('selects folders as all their safe files and reports mixed state', () => {
    const dist = tree.root[0];
    let sel = toggleSelection(new Set(), dist);
    expect(selectedPaths(tree.root, sel)).toEqual(['dist/assets/a.js', 'dist/assets/b.css', 'dist/index.html']);
    expect(checkState(dist, sel)).toBe('on');
    sel = toggleSelection(sel, dist.children[1]);
    expect(checkState(dist, sel)).toBe('mixed');
    expect(checkState(dist.children[0], sel)).toBe('on');
    sel = toggleSelection(sel, dist);
    expect(checkState(dist, sel)).toBe('on');
    sel = toggleSelection(sel, dist);
    expect(sel.size).toBe(0);
    expect(toggleSelection(new Set(), tree.root[2]).size).toBe(0);
  });
});

describe('extraction gating', () => {
  it('disables extraction without a backend and says why', () => {
    expect(extractGate({ canExtract: false, safeFiles: 4, selected: 2, running: false })).toEqual({ all: false, selected: false, note: 'Extraction needs the desktop app. This preview lists and opens entries only.' });
  });
  it('enables extract all and extract selected only when there is something safe to extract', () => {
    expect(extractGate({ canExtract: true, safeFiles: 4, selected: 0, running: false })).toEqual({ all: true, selected: false });
    expect(extractGate({ canExtract: true, safeFiles: 4, selected: 2, running: false })).toEqual({ all: true, selected: true });
    expect(extractGate({ canExtract: true, safeFiles: 0, selected: 0, running: false })).toEqual({ all: false, selected: false, note: 'Nothing in this archive can be extracted safely.' });
  });
  it('blocks new extractions while one runs', () => {
    expect(extractGate({ canExtract: true, safeFiles: 4, selected: 2, running: true })).toEqual({ all: false, selected: false });
  });
});
