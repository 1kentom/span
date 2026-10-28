/** Pure logic for the uploads rail and menus: grouping, filtering, rename validation, keyboard map, menu gating. */
import type { Platform } from '../../lib/commands';
import type { UploadEntry, UploadsCapabilities } from '../../lib/uploads-api';
import { classifyFile, extensionOf } from '../../lib/viewer';
import { ENTER_KEY } from '../agent/KeyGlyph';

export type UploadGroupId = 'documents' | 'data' | 'media' | 'code';
export const UPLOAD_GROUPS: { id: UploadGroupId; label: string }[] = [
  { id: 'documents', label: 'Documents' }, { id: 'data', label: 'Data' }, { id: 'media', label: 'Media' }, { id: 'code', label: 'Code and archives' },
];

const documentExt = new Set(['md', 'markdown', 'mdx', 'txt', 'rtf', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'key', 'pages', 'odt', 'odp', 'html', 'htm', 'epub']);
const dataExt = new Set(['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xlsx', 'xls', 'numbers', 'ods', 'yaml', 'yml', 'xml', 'toml', 'parquet', 'sqlite', 'db']);
const designExt = new Set(['fig', 'sketch', 'psd', 'xd', 'ai']);

export function uploadGroupOf(name: string, mime = ''): UploadGroupId {
  const ext = extensionOf(name);
  if (documentExt.has(ext)) return 'documents';
  if (dataExt.has(ext)) return 'data';
  const kind = classifyFile(name, mime).kind;
  if (designExt.has(ext) || ['image', 'svg', 'audio', 'video', 'font'].includes(kind) || /^(?:image|audio|video|font)\//.test(mime)) return 'media';
  return 'code';
}

export interface UploadGroup { id: UploadGroupId; label: string; count: number; items: UploadEntry[] }
export function groupUploads(entries: readonly UploadEntry[], query: string): UploadGroup[] {
  const needle = query.trim().toLowerCase();
  const matches = (entry: UploadEntry) => !needle || entry.name.toLowerCase().includes(needle) || !!entry.session?.title.toLowerCase().includes(needle);
  return UPLOAD_GROUPS.map(group => {
    const items = entries.filter(entry => uploadGroupOf(entry.name, entry.mime) === group.id && matches(entry));
    return { ...group, count: items.length, items };
  }).filter(group => group.count > 0);
}

export type TreeRow = { key: string; kind: 'group'; group: UploadGroupId } | { key: string; kind: 'file'; group: UploadGroupId; id: string };
export const groupKey = (group: UploadGroupId) => `g:${group}`;
export const fileKey = (id: string) => `f:${id}`;
export function visibleRows(groups: readonly UploadGroup[], collapsed: ReadonlySet<string>): TreeRow[] {
  return groups.flatMap(group => [
    { key: groupKey(group.id), kind: 'group' as const, group: group.id },
    ...(collapsed.has(group.id) ? [] : group.items.map(item => ({ key: fileKey(item.id), kind: 'file' as const, group: group.id, id: item.id }))),
  ]);
}

export function validateRename(name: string, current: UploadEntry, all: readonly UploadEntry[]): string | null {
  if (!name.trim()) return 'Enter a name.';
  if (name !== name.trim()) return 'Names cannot start or end with a space.';
  if (/[\\/]/.test(name)) return 'Names cannot contain / or \\.';
  if (name === '.' || name === '..') return 'That name is reserved.';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'Names cannot contain control characters.';
  if (name.length > 255) return 'Names are limited to 255 characters.';
  if (all.some(entry => entry.id !== current.id && entry.name.toLowerCase() === name.toLowerCase())) return 'Another upload already has this name.';
  return null;
}

export type TreeAction =
  | { type: 'focus'; key: string } | { type: 'expand' | 'collapse' | 'toggle'; group: UploadGroupId }
  | { type: 'open' | 'pin' | 'rename' | 'remove' | 'reveal' | 'menu'; id: string };
type KeyInput = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & { code?: string };

/** Keyboard map of the uploads tree. Returns null for keys it does not handle. */
export function navigateTree(rows: readonly TreeRow[], focused: string, event: KeyInput, options: { canReveal: boolean; platform: Platform }): TreeAction | null {
  const index = Math.max(0, rows.findIndex(row => row.key === focused));
  const row = rows[index];
  if (!row) return null;
  const isReveal = (event.key.toLowerCase() === 'r' || event.code === 'KeyR') && event.altKey
    && (options.platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
  if (isReveal) return options.canReveal && row.kind === 'file' ? { type: 'reveal', id: row.id } : null;
  if (event.metaKey || event.ctrlKey || event.altKey) {
    if (row.kind === 'file' && event.key === 'Backspace' && event.metaKey) return { type: 'remove', id: row.id };
    return null;
  }
  switch (event.key) {
    case 'ArrowDown': return { type: 'focus', key: rows[Math.min(rows.length - 1, index + 1)].key };
    case 'ArrowUp': return { type: 'focus', key: rows[Math.max(0, index - 1)].key };
    case 'Home': return { type: 'focus', key: rows[0].key };
    case 'End': return { type: 'focus', key: rows[rows.length - 1].key };
    case 'ArrowRight': return row.kind === 'group' ? { type: 'expand', group: row.group } : null;
    case 'ArrowLeft': return row.kind === 'group' ? { type: 'collapse', group: row.group } : { type: 'focus', key: groupKey(row.group) };
    case 'Enter': return row.kind === 'group' ? { type: 'toggle', group: row.group } : { type: 'open', id: row.id };
    case ' ': return row.kind === 'file' ? { type: 'pin', id: row.id } : { type: 'toggle', group: row.group };
    case 'F2': return row.kind === 'file' ? { type: 'rename', id: row.id } : null;
    case 'Delete': case 'Backspace': return row.kind === 'file' ? { type: 'remove', id: row.id } : null;
    case 'ContextMenu': return row.kind === 'file' ? { type: 'menu', id: row.id } : null;
    case 'F10': return event.shiftKey && row.kind === 'file' ? { type: 'menu', id: row.id } : null;
    default: return null;
  }
}

export interface MenuItem {
  id: string; label: string; icon?: string; shortcut?: string; danger?: boolean; checked?: boolean; disabled?: boolean;
  separatorBefore?: boolean; children?: MenuItem[]; run?: () => void;
}
type Run = () => void;

export const revealLabel = (platform: Platform) => platform === 'mac' ? 'Reveal in Finder' : platform === 'windows' ? 'Show in File Explorer' : 'Show in file manager';
export const revealPlace = (platform: Platform) => platform === 'mac' ? 'Finder' : platform === 'windows' ? 'File Explorer' : 'the file manager';
/** Shortcut labels for the keys the uploads workspace binds. Nothing else gets a shortcut label. */
export const shortcutLabels = (platform: Platform) => ({
  open: ENTER_KEY, rename: 'F2', remove: platform === 'mac' ? '⌫' : 'Delete', reveal: platform === 'mac' ? '⌥⌘R' : 'Ctrl+Alt+R',
});

function sections(groups: (MenuItem | false | undefined)[][]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const group of groups) {
    const items = group.filter((item): item is MenuItem => !!item);
    items.forEach((item, i) => out.push(i === 0 && out.length ? { ...item, separatorBefore: true } : item));
  }
  return out;
}

export interface OpenWithHandlers { setViewAs?: (mode: 'preview' | 'hex') => void; openWithSystem?: Run; chooseApplication?: Run }
function openWithItem(caps: UploadsCapabilities, handlers: OpenWithHandlers, viewAs: 'preview' | 'hex'): MenuItem | undefined {
  if (!handlers.setViewAs) return undefined;
  const setViewAs = handlers.setViewAs;
  return {
    id: 'open-with', label: 'Open with', icon: 'ExportSquare',
    children: sections([
      [{ id: 'view-preview', label: 'Span preview', checked: viewAs === 'preview', run: () => setViewAs('preview') }, { id: 'view-hex', label: 'Binary (hex)', checked: viewAs === 'hex', run: () => setViewAs('hex') }],
      [caps.openWithSystem && handlers.openWithSystem && { id: 'system', label: 'System default app', run: handlers.openWithSystem },
        caps.chooseApplication && handlers.chooseApplication && { id: 'choose', label: 'Choose application…', run: handlers.chooseApplication }],
    ]),
  };
}

export interface FileMenuHandlers extends OpenWithHandlers {
  openPreview?: Run; openKeep?: Run; saveToWorkspace?: Run; reveal?: Run; copyPath?: Run; showInSession?: Run; rename?: Run; duplicate?: Run; remove?: Run;
}
/** Context menu of an upload. Each entry needs its handler, and api-backed entries also need the capability. */
export function fileMenuItems(_entry: UploadEntry, caps: UploadsCapabilities, h: FileMenuHandlers, options: { viewAs: 'preview' | 'hex'; platform: Platform }): MenuItem[] {
  const keys = shortcutLabels(options.platform);
  return sections([
    [h.openPreview && { id: 'open', label: 'Open preview', icon: 'Eye', shortcut: keys.open, run: h.openPreview },
      h.openKeep && { id: 'keep', label: 'Open and keep', icon: 'Check', run: h.openKeep },
      openWithItem(caps, h, options.viewAs)],
    [caps.saveToWorkspace && h.saveToWorkspace && { id: 'save', label: 'Save to workspace…', icon: 'Download', run: h.saveToWorkspace },
      caps.reveal && h.reveal && { id: 'reveal', label: revealLabel(options.platform), icon: 'Folder2', shortcut: keys.reveal, run: h.reveal },
      caps.copyPath && h.copyPath && { id: 'copy-path', label: 'Copy path', icon: 'Copy', run: h.copyPath },
      h.showInSession && { id: 'session', label: 'Show in session', icon: 'Message', run: h.showInSession }],
    [caps.rename && h.rename && { id: 'rename', label: 'Rename…', icon: 'Edit2', shortcut: keys.rename, run: h.rename },
      caps.duplicate && h.duplicate && { id: 'duplicate', label: 'Duplicate', icon: 'Copy', run: h.duplicate }],
    [caps.remove && h.remove && { id: 'remove', label: 'Remove upload', icon: 'Trash', shortcut: keys.remove, danger: true, run: h.remove }],
  ]);
}

export interface TabMenuHandlers extends OpenWithHandlers { close: Run; closeOthers: Run; closeRight: Run; closeAll: Run; keepOpen?: Run; copyPath?: Run; reveal?: Run }
export function tabMenuItems(_entry: UploadEntry, caps: UploadsCapabilities, h: TabMenuHandlers, options: { viewAs: 'preview' | 'hex'; platform: Platform; preview: boolean; hasOthers: boolean; hasRight: boolean }): MenuItem[] {
  const keys = shortcutLabels(options.platform);
  return sections([
    [{ id: 'close', label: 'Close', icon: 'Close', shortcut: keys.remove, run: h.close },
      { id: 'close-others', label: 'Close others', disabled: !options.hasOthers, run: h.closeOthers },
      { id: 'close-right', label: 'Close to the right', disabled: !options.hasRight, run: h.closeRight },
      { id: 'close-all', label: 'Close all', run: h.closeAll }],
    [options.preview && h.keepOpen && { id: 'keep', label: 'Keep open', icon: 'Check', run: h.keepOpen }, openWithItem(caps, h, options.viewAs)],
    [caps.copyPath && h.copyPath && { id: 'copy-path', label: 'Copy path', icon: 'Copy', run: h.copyPath },
      caps.reveal && h.reveal && { id: 'reveal', label: revealLabel(options.platform), icon: 'Folder2', shortcut: keys.reveal, run: h.reveal }],
  ]);
}

/** Source bar wording. See the decision note in lib/viewer.ts. */
export function sourceLine(entry: UploadEntry, formatTime: (ms: number) => string): { verb: string; session?: string; time?: string } {
  const session = entry.session?.title || undefined;
  const time = formatTime(entry.createdAt) || undefined;
  if (entry.origin === 'generated') {
    const who = entry.agent?.name ? `Created by ${entry.agent.name}` : 'Created by an agent';
    return { verb: session ? `${who} in` : who, session, time };
  }
  return { verb: session ? 'Attached in' : 'Attached', session, time };
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatUploadTime(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms), today = new Date(now);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(today) - day(date)) / 86400000);
  if (diff === 0) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (diff === 1) return 'Yesterday';
  if (date.getFullYear() === today.getFullYear()) return `${months[date.getMonth()]} ${date.getDate()}`;
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}
