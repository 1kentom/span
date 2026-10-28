import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = resolve(process.cwd(), 'src');
const css = readFileSync(resolve(src, 'styles/office.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe('office stylesheet', () => {
  it('uses theme tokens: hex literals appear only in the named paper variables', () => {
    const declarations = [...css.matchAll(/([\w-]+)\s*:\s*([^;{}]*#[0-9a-fA-F]{3,8}\b[^;{}]*)/g)].map(m => m[1]);
    expect(declarations.length).toBeGreaterThan(0);
    expect(declarations.filter(name => !name.startsWith('--ox-paper'))).toEqual([]);
  });
  it('honours reduced motion and keeps no ox- selector that nothing uses', () => {
    expect(css).toContain('prefers-reduced-motion:reduce');
    const code = walk(src).filter(p => /\.tsx?$/.test(p) && !p.endsWith('.test.ts') && !p.endsWith('.test.tsx')).map(p => readFileSync(p, 'utf8')).join('\n');
    const classes = [...new Set([...css.matchAll(/\.(ox-[\w-]+)/g)].map(m => m[1]))];
    const dynamic = ['ox-anchor-top', 'ox-anchor-middle', 'ox-anchor-bottom'];
    expect(classes.filter(name => !code.includes(name) && !dynamic.includes(name))).toEqual([]);
  });
});
