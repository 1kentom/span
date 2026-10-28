import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { materialIconName, materialIconUrl } from './file-icons';
import definitions from './material-icon-map.json';

describe('upstream Material Icon Theme associations', () => {
  it.each(['Dockerfile', 'Dockerfile.prod', 'docker-compose.yml', 'docker-compose.override.yaml', 'compose.yml', '.dockerignore'])('uses the official Docker mapping for %s', name => {
    expect(materialIconName(`project/${name}`)).toBe('docker');
  });
  it.each(['.env', '.env.example', '.env.local', '.env.production'])('uses the official environment mapping for %s', name => {
    expect(materialIconName(name)).toBe('tune');
  });
  it('prioritizes exact names and compound extensions', () => {
    expect(materialIconName('package.json')).toBe('nodejs');
    expect(materialIconName('package-lock.json')).toBe('nodejs');
    expect(materialIconName('tsconfig.json')).toBe('tsconfig');
    expect(materialIconName('vite.config.ts')).toBe('vite');
    expect(materialIconName('types/index.d.ts')).toBe('typescript-def');
    expect(materialIconName('README.md')).toBe('readme');
    expect(materialIconName('main.tsx')).toBe('react_ts');
    expect(materialIconName('file.unknown')).toBe('file');
  });
  it('uses real folder names and expanded variants', () => {
    expect(materialIconName('src', { directory: true })).toBe('folder-src');
    expect(materialIconName('src', { directory: true, open: true })).toBe('folder-src-open');
    expect(materialIconName('node_modules', { directory: true })).toBe('folder-node');
    expect(materialIconName('.github', { directory: true, open: true })).toBe('folder-github-open');
    expect(materialIconName('unknown', { directory: true, open: true })).toBe('folder-open');
  });
  it('uses official light overrides only where provided', () => {
    expect(materialIconName('Cargo.toml', { light: true })).toBe('toml_light');
    expect(materialIconName('settings.toml', { light: true })).toBe('toml_light');
    expect(materialIconName('.idea', { directory: true, light: true })).toBe('folder-intellij_light');
    expect(materialIconName('src/main.ts')).toBe('typescript');
  });
  it('ships every mapping as a local exact SVG asset with upstream license and provenance', () => {
    const root = `${resolve(process.cwd(), 'public/material-icons')}/`;
    for (const filename of Object.values(definitions.assets)) expect(existsSync(`${root}${filename}`), filename).toBe(true);
    expect(readFileSync(`${root}LICENSE`, 'utf8')).toContain('Copyright (c) 2025 Material Extensions');
    expect(JSON.parse(readFileSync(`${root}PROVENANCE.json`, 'utf8')).commit).toBe('045291ff033062a25441dd297fd51546326866f2');
    expect(materialIconUrl('Dockerfile')).toBe('/material-icons/docker.svg');
    expect(materialIconUrl('other.custom')).toBe('/material-icons/file.svg');
  });
});
