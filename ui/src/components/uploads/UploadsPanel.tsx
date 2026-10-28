import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on } from 'solid-js';
import { formatAssetBytes } from '../../lib/asset-preview';
import type { Platform } from '../../lib/commands';
import type { UploadEntry, UploadsCapabilities } from '../../lib/uploads-api';
import { FileIcon } from '../FileIcon';
import Icon from '../Icon';
import { fileKey, formatUploadTime, groupKey, groupUploads, navigateTree, validateRename, visibleRows, type UploadGroupId } from './upload-model';
import '../../styles/uploads.css';

export interface UploadsPanelProps {
  entries: UploadEntry[];
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  /** Error text, or the reason uploads are unavailable. */
  message?: string;
  activeId: string | null;
  capabilities: UploadsCapabilities;
  platform: Platform;
  now?: () => number;
  usage?: string;
  renaming: string | null;
  confirmRemove: string | null;
  onOpen: (id: string, pin: boolean) => void;
  onMenu: (id: string, at: { x: number; y: number }) => void;
  onAdd?: () => void;
  onRetry?: () => void;
  onRenameStart: (id: string) => void;
  onRenameCancel: () => void;
  /** Resolves to an error message to show, or null when renamed. */
  onRenameCommit: (id: string, name: string) => Promise<string | null>;
  onRemoveRequest: (id: string) => void;
  onRemoveCancel: () => void;
  onRemoveConfirm: (id: string) => void;
  onReveal?: (id: string) => void;
}

/**
 * Left rail of the uploads workspace (File Viewer design, rail). A tree of groups and files: arrows move,
 * Left and Right collapse and expand, Enter opens a preview, Space keeps it open, F2 renames, Delete removes
 * after a confirmation, and Cmd+Alt+R (Ctrl+Alt+R) reveals when the backend supports it.
 */
export function UploadsPanel(props: UploadsPanelProps) {
  const [query, setQuery] = createSignal('');
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = createSignal('');
  const rowElements = new Map<string, HTMLElement>();
  const id = createUniqueId();
  const groups = createMemo(() => groupUploads(props.entries, query()));
  const rows = createMemo(() => visibleRows(groups(), collapsed()));
  const entry = (uploadId: string) => props.entries.find(item => item.id === uploadId);
  const now = () => props.now?.() ?? Date.now();
  // Keep a valid roving focus target: the active file, else the first row.
  createEffect(on(rows, list => { if (!list.some(row => row.key === focused())) setFocused(list.find(row => row.key === fileKey(props.activeId ?? ''))?.key ?? list[0]?.key ?? ''); }));
  const focusRow = (key: string) => { setFocused(key); queueMicrotask(() => rowElements.get(key)?.focus()); };
  const setGroup = (group: UploadGroupId, open: boolean) => setCollapsed(previous => { const next = new Set(previous); if (open) next.delete(group); else next.add(group); return next; });

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('input,[role="alertdialog"]')) return;
    const action = navigateTree(rows(), focused(), event, { canReveal: !!props.onReveal && props.capabilities.reveal, platform: props.platform });
    if (!action) return;
    event.preventDefault();
    switch (action.type) {
      case 'focus': focusRow(action.key); break;
      case 'expand': setGroup(action.group, true); break;
      case 'collapse': setGroup(action.group, false); break;
      case 'toggle': setGroup(action.group, collapsed().has(action.group)); break;
      case 'open': props.onOpen(action.id, false); break;
      case 'pin': props.onOpen(action.id, true); break;
      case 'rename': if (props.capabilities.rename) props.onRenameStart(action.id); break;
      case 'remove': if (props.capabilities.remove) props.onRemoveRequest(action.id); break;
      case 'reveal': props.onReveal?.(action.id); break;
      case 'menu': { const bounds = rowElements.get(fileKey(action.id))?.getBoundingClientRect(); props.onMenu(action.id, { x: (bounds?.left ?? 0) + 24, y: bounds?.bottom ?? 0 }); break; }
    }
  };

  const Empty = (empty: { title: string; text?: string; action?: { label: string; run: () => void } }) => <div class="up-empty" role="status">
    <strong>{empty.title}</strong><Show when={empty.text}><span>{empty.text}</span></Show>
    <Show when={empty.action}><button type="button" class="vw-btn vw-btn-outline" onClick={() => empty.action!.run()}>{empty.action!.label}</button></Show>
  </div>;

  return <aside class="up-rail" aria-labelledby={`${id}-title`}>
    <div class="up-rail-head">
      <h2 id={`${id}-title`} class="up-rail-title">Uploads</h2>
      <span class="vw-spacer" />
      <Show when={props.onAdd && props.capabilities.add}><button type="button" class="up-icon-btn" aria-label="Upload files" title="Upload files" onClick={() => props.onAdd!()}><Icon name="Add" size={15} /></button></Show>
    </div>
    <Show when={props.status !== 'unavailable'}>
      <label class="up-filter"><Icon name="SearchNormal1" size={14} /><input type="search" placeholder="Filter uploads" aria-label="Filter uploads" value={query()} onInput={event => setQuery(event.currentTarget.value)} /></label>
    </Show>
    <div class="up-rail-body">
      <Switch_ status={props.status}>
        {{
          unavailable: () => <Empty title={props.message || 'Uploads need the desktop app'} text="Files you attach to an agent, and files agents create, are listed here in the desktop app." />,
          loading: () => <div class="up-empty" role="status"><span class="vw-shimmer" aria-hidden="true"><span /><span /></span><span>Loading uploads…</span></div>,
          error: () => <Empty title="Uploads could not be loaded" text={props.message} action={props.onRetry ? { label: 'Retry', run: props.onRetry } : undefined} />,
          ready: () => <Show when={props.entries.length} fallback={<Empty title="No uploads yet" text="Files you attach to an agent session appear here." action={props.onAdd && props.capabilities.add ? { label: 'Upload files', run: props.onAdd } : undefined} />}>
            <Show when={groups().length} fallback={<Empty title={`No uploads match “${query().trim()}”`} />}>
              <div class="up-tree" role="tree" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown}>
                <For each={groups()}>{group => {
                  const open = () => !collapsed().has(group.id);
                  const key = groupKey(group.id);
                  return <div role="treeitem" aria-level={1} aria-expanded={open()} aria-labelledby={`${id}-${group.id}`} class="up-group"
                    ref={element => rowElements.set(key, element)} tabIndex={focused() === key ? 0 : -1} onFocus={event => { if (event.target === event.currentTarget) setFocused(key); }}>
                    <div class="up-group-row" onClick={() => { setFocused(key); setGroup(group.id, !open()); }}>
                      <Icon name={open() ? 'arrow-down4' : 'arrow-right4'} size={8} class="up-chevron" />
                      <span id={`${id}-${group.id}`}>{group.label}</span><span class="vw-spacer" /><span class="up-count" aria-label={`${group.count} ${group.count === 1 ? 'file' : 'files'}`}>{group.count}</span>
                    </div>
                    <Show when={open()}>
                      <div role="group">
                        <For each={group.items}>{item => {
                          const itemKey = fileKey(item.id);
                          const meta = () => [item.session?.title, formatUploadTime(item.createdAt, now())].filter(Boolean).join(' · ');
                          return <div role="treeitem" aria-level={2} aria-selected={props.activeId === item.id} class="up-row" classList={{ 'up-row-active': props.activeId === item.id }}
                            ref={element => rowElements.set(itemKey, element)} tabIndex={focused() === itemKey ? 0 : -1}
                            aria-label={`${item.name}, ${formatAssetBytes(item.size)}${meta() ? `, ${meta()}` : ''}`}
                            onFocus={event => { if (event.target === event.currentTarget) setFocused(itemKey); }}
                            onClick={() => { setFocused(itemKey); props.onOpen(item.id, false); }} onDblClick={() => props.onOpen(item.id, true)}
                            onContextMenu={event => { event.preventDefault(); setFocused(itemKey); props.onMenu(item.id, { x: event.clientX, y: event.clientY }); }}>
                            <FileIcon path={item.name} class="up-row-icon" />
                            <Show when={props.renaming === item.id} fallback={<span class="up-row-text"><span class="up-row-line"><span class="up-row-name">{item.name}</span><span class="up-row-size">{formatAssetBytes(item.size)}</span></span>
                              <Show when={meta()}><span class="up-row-meta">{meta()}</span></Show></span>}>
                              <RenameField entry={item} all={props.entries} onCancel={() => { props.onRenameCancel(); focusRow(itemKey); }} onCommit={async name => { const error = await props.onRenameCommit(item.id, name); if (!error) focusRow(itemKey); return error; }} />
                            </Show>
                          </div>;
                        }}</For>
                      </div>
                    </Show>
                  </div>;
                }}</For>
              </div>
            </Show>
          </Show>,
        }}
      </Switch_>
      <Show when={props.confirmRemove ? entry(props.confirmRemove) : undefined}>{target => <ConfirmRemove entry={target()} onCancel={() => { const key = fileKey(target().id); props.onRemoveCancel(); focusRow(key); }} onConfirm={() => props.onRemoveConfirm(target().id)} />}</Show>
    </div>
    <div class="up-rail-foot">
      <span>Click to preview, double-click to keep open, right-click for more</span>
      <Show when={props.usage}><span class="up-usage">{props.usage}</span></Show>
    </div>
  </aside>;
}

/** Tiny keyed switch so each status renders its own subtree. */
function Switch_(props: { status: UploadsPanelProps['status']; children: Record<UploadsPanelProps['status'], () => any> }) {
  return <>{props.children[props.status]()}</>;
}

function RenameField(props: { entry: UploadEntry; all: UploadEntry[]; onCancel: () => void; onCommit: (name: string) => Promise<string | null> }) {
  const [value, setValue] = createSignal(props.entry.name);
  const [error, setError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const errorId = createUniqueId();
  let input!: HTMLInputElement;
  queueMicrotask(() => { input?.focus(); const dot = props.entry.name.lastIndexOf('.'); input?.setSelectionRange(0, dot > 0 ? dot : props.entry.name.length); });
  const commit = async () => {
    if (saving()) return;
    if (value() === props.entry.name) { props.onCancel(); return; }
    const problem = validateRename(value(), props.entry, props.all);
    if (problem) { setError(problem); return; }
    setSaving(true);
    const failure = await props.onCommit(value());
    setSaving(false);
    if (failure) setError(failure);
  };
  return <span class="up-rename" onClick={event => event.stopPropagation()} onDblClick={event => event.stopPropagation()}>
    <input ref={input} value={value()} aria-label={`Rename ${props.entry.name}`} aria-invalid={!!error()} aria-describedby={error() ? errorId : undefined} disabled={saving()}
      onInput={event => { setValue(event.currentTarget.value); setError(''); }}
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); void commit(); } else if (event.key === 'Escape') { event.preventDefault(); props.onCancel(); } }} />
    <Show when={error()}><span id={errorId} class="up-rename-error" role="alert">{error()}</span></Show>
  </span>;
}

function ConfirmRemove(props: { entry: UploadEntry; onCancel: () => void; onConfirm: () => void }) {
  const titleId = createUniqueId();
  let cancel!: HTMLButtonElement;
  queueMicrotask(() => cancel?.focus());
  return <div class="up-confirm" role="alertdialog" aria-labelledby={titleId} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onCancel(); } }}>
    <span id={titleId}>Remove <strong>{props.entry.name}</strong> from uploads?</span>
    <span class="up-confirm-actions">
      <button type="button" class="vw-btn vw-btn-danger" onClick={() => props.onConfirm()}>Remove</button>
      <button ref={cancel} type="button" class="vw-btn vw-btn-outline" onClick={() => props.onCancel()}>Cancel</button>
    </span>
  </div>;
}
