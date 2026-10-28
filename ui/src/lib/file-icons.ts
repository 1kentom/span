import definitions from './material-icon-map.json';

type Association = Record<string, string>;
type Associations = { fileNames: Association; fileExtensions: Association; folderNames: Association; folderNamesExpanded: Association; file?: string; folder?: string; folderExpanded?: string };
const theme = definitions as typeof definitions & Associations;
const light = theme.light as Associations;

export interface FileIconOptions { directory?: boolean; open?: boolean; light?: boolean }

/** Resolve upstream filename associations before compound extensions, just like the pack manifest. */
export function materialIconName(path: string, options: FileIconOptions = {}): string {
  const segments = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase().split('/');
  const name = segments.at(-1) || '';
  const variant = options.light ? light : undefined;
  const association = (key: keyof Pick<Associations, 'fileNames' | 'fileExtensions' | 'folderNames' | 'folderNamesExpanded'>, value: string) => variant?.[key]?.[value] ?? theme[key][value];
  const named = (key: 'fileNames' | 'folderNames' | 'folderNamesExpanded') => {
    for (let index = 0; index < segments.length; index++) {
      const match = association(key, segments.slice(index).join('/'));
      if (match) return match;
    }
  };
  if (options.directory) {
    const key = options.open ? 'folderNamesExpanded' : 'folderNames';
    return named(key) ?? (options.open ? variant?.folderExpanded ?? theme.folderExpanded : variant?.folder ?? theme.folder);
  }
  const fileMatch = named('fileNames');
  if (fileMatch) return fileMatch;
  for (let index = name.indexOf('.'); index >= 0; index = name.indexOf('.', index + 1)) {
    const match = association('fileExtensions', name.slice(index + 1));
    if (match) return match;
  }
  return variant?.file ?? theme.file;
}

export function materialIconUrl(path: string, options: FileIconOptions = {}): string {
  const name = materialIconName(path, options);
  const filename = (theme.assets as Association)[name] ?? theme.assets.file;
  return `/material-icons/${filename}`;
}
