import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const css = (name: string) => readFileSync(resolve(root, 'src/styles', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('viewer and uploads stylesheets use theme tokens only', () => {
  it('viewer.css has no literal colour: the image backgrounds come from the workbench paper tokens', () => {
    const source = css('viewer.css');
    expect(source).toContain('--vw-image-light:var(--paper-image-light)');
    expect(source).toContain('--vw-image-dark:var(--paper-image-dark)');
    expect(source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(source).not.toMatch(/rgba?\(|hsla?\(/);
    const tokens = css('workbench.css');
    for (const name of ['--paper-image-light', '--paper-image-dark']) expect(tokens).toMatch(new RegExp(`${name}:#[0-9a-fA-F]{3,8}[;}]`));
  });
  it('uploads.css has no literal colour at all', () => {
    const source = css('uploads.css');
    expect(source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(source).not.toMatch(/rgba?\(|hsla?\(/);
  });
  it('syntax colours are tokens with theme fallbacks', () => {
    const source = css('viewer.css');
    for (const token of ['tag', 'attr', 'string', 'comment', 'heading', 'keyword', 'number']) expect(source).toMatch(new RegExp(`--vw-syn-${token}:var\\(--syntax-[a-z]+,var\\(--[A-Za-z]+\\)\\)`));
  });
  it('animations stop under prefers-reduced-motion', () => {
    expect(css('viewer.css')).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\.vw \*\{animation:none!important;transition:none!important/);
    expect(css('uploads.css')).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\.up-workspace \*,\.up-menu,\.up-toast\{animation:none!important/);
  });
  it('every icon the viewer and uploads code names exists in public/icons', () => {
    const files = ['viewer/FileViewer.tsx', 'viewer/AudioView.tsx', 'viewer/MediaPlayer.tsx', 'viewer/ImageView.tsx', 'viewer/HtmlView.tsx', 'viewer/CsvView.tsx', 'viewer/JsonView.tsx', 'viewer/ViewerStates.tsx',
      'uploads/UploadsPanel.tsx', 'uploads/UploadsWorkspace.tsx', 'uploads/UploadMenu.tsx', 'uploads/Toast.tsx', 'uploads/upload-model.ts'];
    const names = new Set<string>();
    for (const file of files) {
      const source = readFileSync(resolve(root, 'src/components', file), 'utf8');
      for (const match of source.matchAll(/(?:\bname=|\bicon: |\bname: )["'{]+([A-Za-z0-9-]+)["'}]/g)) names.add(match[1]);
      for (const match of source.matchAll(/'(u-play|Pause|Volume|VolumeMute|arrow-up3|arrow-down4|arrow-right4|markdown-preview|markdown-both|markdown-source|Element3|Sun|Moon)'/g)) names.add(match[1]);
    }
    const aliases: Record<string, string> = { Copy: 'rounded-linear/copy', Trash: 'rounded-linear/trash', Folder2: 'rounded-linear/folder', Edit2: 'rounded-linear/rename', 'arrow-down4': 'rounded-linear/arrow-down4', 'arrow-up3': 'rounded-linear/arrow-up3', 'arrow-right4': 'rounded-linear/arrow-right4' };
    const missing = [...names].filter(name => !existsSync(resolve(root, 'public/icons', `${aliases[name] ?? name}.svg`)));
    expect(missing).toEqual([]);
    expect(names.size).toBeGreaterThan(20);
  });
  it('new icons record their source and are inert currentColor artwork', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'public/icons/viewer-provenance.json'), 'utf8')) as { assets: { asset: string; origin: string }[] };
    expect(manifest.assets.map(a => a.asset).sort()).toEqual(['Back10.svg', 'Check.svg', 'Close.svg', 'Download.svg', 'Fwd10.svg', 'Minus.svg', 'Moon.svg', 'Pause.svg', 'Repeat.svg', 'Sun.svg', 'Volume.svg', 'VolumeMute.svg']);
    expect(JSON.stringify(manifest)).not.toMatch(/\/Users\/|[A-Z]:\\/);
    for (const { asset } of manifest.assets) {
      const svg = readFileSync(resolve(root, 'public/icons', asset), 'utf8');
      expect(svg).not.toMatch(/<script|foreignObject|\bon\w+=|(?:href|src)=|<!DOCTYPE|<!ENTITY/i);
      expect(svg).not.toMatch(/(?:stroke|fill)="(?!none|transparent|currentColor)[^"]+"/);
      expect(svg).toContain('viewBox="0 0 24 24"');
    }
  });
});
