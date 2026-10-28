import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Upstream published package, verified before extraction. No package scripts execute.
const version = '5.40.0';
const commit = '045291ff033062a25441dd297fd51546326866f2';
const integrity = 'sha512-IrvgusbwtqxhUtVgUy0nToJcfN7CYVRdbBxKMfbo0vab9flVBHA5INZ9UiE5SgRj+PM6opCl5nn5TZdpm2UaxA==';
const repository = 'https://github.com/material-extensions/vscode-material-icon-theme';
const source = `https://registry.npmjs.org/material-icon-theme/-/material-icon-theme-${version}.tgz`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const destination = join(root, 'ui/public/material-icons');
const temp = mkdtempSync(join(tmpdir(), 'span-material-icons-'));

try {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Package download failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== integrity) throw new Error('Upstream archive integrity mismatch.');
  const archivePath = join(temp, 'icons.tgz');
  writeFileSync(archivePath, archive);
  execFileSync('tar', ['-xzf', archivePath, '-C', temp]);
  const base = join(temp, 'package');
  const manifest = JSON.parse(readFileSync(join(base, 'dist/material-icons.json'), 'utf8'));
  const sections = ['fileNames', 'fileExtensions', 'folderNames', 'folderNamesExpanded'];
  const data = { assets: {}, file: manifest.file, folder: manifest.folder, folderExpanded: manifest.folderExpanded, light: {} };
  for (const key of sections) { data[key] = manifest[key]; data.light[key] = manifest.light[key] ?? {}; }
  for (const key of ['file', 'folder', 'folderExpanded']) if (manifest.light[key]) data.light[key] = manifest.light[key];
  const names = new Set([data.file, data.folder, data.folderExpanded]);
  for (const theme of [data, data.light]) for (const key of sections) for (const name of Object.values(theme[key])) names.add(name);
  mkdirSync(destination, { recursive: true });
  const copied = new Set();
  for (const name of names) {
    if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid icon identifier: ${name}`);
    const filename = basename(manifest.iconDefinitions[name].iconPath);
    if (!/^[\w.-]+\.svg$/.test(filename)) throw new Error(`Invalid SVG filename: ${filename}`);
    data.assets[name] = filename;
    copyFileSync(join(base, 'icons', filename), join(destination, filename));
    copied.add(filename);
  }
  // This dedicated folder is generated. Supplied UI artwork lives in separate folders.
  for (const filename of readdirSync(destination)) if (filename.endsWith('.svg') && !copied.has(filename)) rmSync(join(destination, filename));
  copyFileSync(join(base, 'LICENSE'), join(destination, 'LICENSE'));
  writeFileSync(join(root, 'ui/src/lib/material-icon-map.json'), `${JSON.stringify(data)}\n`);
  const provenance = { project: 'Material Icon Theme', publisher: 'PKief', repository, version, commit, source, integrity, license: 'MIT', configuration: 'Official generated default manifest: specific folders, angular active icon pack. Includes upstream light overrides.', mappings: ['dist/material-icons.json'], assets: [...names].sort().map(name => data.assets[name]) };
  writeFileSync(join(destination, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  if (!existsSync(join(destination, 'LICENSE'))) throw new Error('Upstream license was not copied.');
  console.log(`Vendored ${names.size} Material Icon Theme SVGs and official filename, folder and light associations.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
