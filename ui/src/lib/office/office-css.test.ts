import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = resolve(process.cwd(), 'src');
const css = readFileSync(resolve(src, 'styles/office.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe('office stylesheet', () => {
  it('uses tokens only: no hex literal, and the paper comes from the workbench paper tokens', () => {
    const declarations = [...css.matchAll(/([\w-]+)\s*:\s*([^;{}]*#[0-9a-fA-F]{3,8}\b[^;{}]*)/g)].map(m => m[1]);
    expect(declarations).toEqual([]);
    expect(css).toContain('--ox-paper:var(--paper)');
    const tokens = readFileSync(resolve(src, 'styles/workbench.css'), 'utf8');
    for (const name of ['--paper', '--paper-ink', '--paper-dim', '--paper-line', '--paper-head']) expect(tokens).toMatch(new RegExp(`${name}:#[0-9a-fA-F]{3,8}[;}]`));
  });
  it('honours reduced motion and keeps no ox- selector that nothing uses', () => {
    expect(css).toContain('prefers-reduced-motion:reduce');
    const code = walk(src).filter(p => /\.tsx?$/.test(p) && !p.endsWith('.test.ts') && !p.endsWith('.test.tsx')).map(p => readFileSync(p, 'utf8')).join('\n');
    const classes = [...new Set([...css.matchAll(/\.(ox-[\w-]+)/g)].map(m => m[1]))];
    const dynamic = ['ox-anchor-top', 'ox-anchor-middle', 'ox-anchor-bottom'];
    expect(classes.filter(name => !code.includes(name) && !dynamic.includes(name))).toEqual([]);
  });
});
