import { For, Show, batch, createEffect, createMemo, createSignal, on, onMount } from 'solid-js';
import type { ArchiveApi } from '../../lib/archive-api';
import { officeKindOf } from '../../lib/office/kind';
import { formatAssetBytes } from '../../lib/asset-preview';
import { currentPlatform, type Platform } from '../../lib/commands';
import { UploadsError, type UploadEntry, type UploadExtras, type UploadsApi } from '../../lib/uploads-api';
import {
  closeAllTabs, closeOtherTabs, closeTab, closeTabsToRight, openTab, pinTab, readLimit, removeFromTabs, type ViewerTabs,
} from '../../lib/viewer';
import { FileIcon } from '../FileIcon';
import Icon from '../Icon';
import { KeyGlyph } from '../agent/KeyGlyph';
import { FileViewer, type ViewerContent } from '../viewer/FileViewer';
import { ToastHost, createToaster } from './Toast';
import { UploadMenu } from './UploadMenu';
import { UploadsPanel } from './UploadsPanel';
import { fileMenuItems, formatUploadTime, revealLabel, revealPlace, shortcutLabels, sourceLine, tabMenuItems, type MenuItem } from './upload-model';
import '../../styles/uploads.css';

export interface UploadsWorkspaceProps {
  api: UploadsApi;
  archiveApi?: (uploadId: string) => ArchiveApi;
  platform?: Platform;
  /** Host navigation to the session an upload came from. The menu entry is hidden without it. */
  onShowInSession?: (entry: UploadEntry) => void;
  /** Action of the "gone" state. */
  onShowSessionList?: () => void;
  /** Clock for relative times (tests). */
  now?: () => number;
  /** Host navigation back to the file explorer, shown as a tab in the rail head. */
  onShowExplorer?: () => void;
}

type ViewAs = 'preview' | 'hex';
type MenuState = { kind: 'file' | 'tab'; id: string; x: number; y: number };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/**
 * Self-contained uploads surface: the Uploads rail, a viewer tab strip (italic preview tab replaced by the next
 * single click, pinned by double-click or Keep open) and the FileViewer. All data and actions go through the
 * UploadsApi; every action the api does not offer is hidden.
 */
export function UploadsWorkspace(props: UploadsWorkspaceProps) {
  const platform = () => props.platform ?? currentPlatform();
  const caps = () => props.api.capabilities;
  const toaster = createToaster();
  const [entries, setEntries] = createSignal<UploadEntry[]>([]);
  const [status, setStatus] = createSignal<'loading' | 'ready' | 'error' | 'unavailable'>(props.api.available ? 'loading' : 'unavailable');
  const [loadError, setLoadError] = createSignal('');
  const [usage, setUsage] = createSignal('');
  const [tabs, setTabs] = createSignal<ViewerTabs>({ tabs: [], active: null });
  const [contents, setContents] = createSignal<Record<string, ViewerContent>>({});
  const [extras, setExtras] = createSignal<Record<string, UploadExtras | undefined>>({});
  const [viewAs, setViewAsMap] = createSignal<Record<string, ViewAs>>({});
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);
  const tabElements = new Map<string, HTMLElement>();

  const byId = createMemo(() => new Map(entries().map(entry => [entry.id, entry])));
  const active = () => { const id = tabs().active; return id ? byId().get(id) : undefined; };
  const archiveApi = createMemo(() => {
    const entry = active();
    return entry && officeKindOf(entry.name, entry.mime ?? '') === 'archive' ? props.archiveApi?.(entry.id) : undefined;
  });
  const viewOf = (id: string): ViewAs => viewAs()[id] ?? 'preview';
  const now = () => props.now?.() ?? Date.now();

  async function refresh() {
    if (!props.api.available) return;
    try {
      const list = await props.api.list();
      batch(() => { setEntries(list); setStatus('ready'); setLoadError(''); setTabs(current => removeFromTabs(current, new Set(list.map(entry => entry.id)))); });
      if (caps().usage) props.api.usage().then(value => setUsage(`${value.count} ${value.count === 1 ? 'file' : 'files'} · ${formatAssetBytes(value.bytes)}`)).catch(() => setUsage(''));
    } catch (cause) { batch(() => { setStatus('error'); setLoadError(message(cause)); }); }
  }
  onMount(() => void refresh());

  // Load the active tab's bytes (only as many as its viewer can use), once per upload and view mode.
  createEffect(on(() => { const entry = active(); return entry ? `${entry.id}:${viewOf(entry.id)}:${entry.size}` : ''; }, key => {
    const entry = active();
    if (!key || !entry || contents()[key]) return;
    const limit = readLimit(entry.name, entry.mime ?? '', entry.size, viewOf(entry.id) === 'hex');
    const set = (content: ViewerContent) => setContents(current => ({ ...current, [key]: content }));
    if (limit === 0) { set({ status: 'ready' }); return; }
    set({ status: 'loading' });
    props.api.read(entry.id, 0, limit)
      .then(bytes => set({ status: 'ready', bytes }))
      .catch(cause => set(cause instanceof UploadsError && cause.code === 'gone' ? { status: 'gone' } : { status: 'error', message: `Could not read ${entry.name}: ${message(cause)}` }));
    if (props.api.extras && !(entry.id in extras())) props.api.extras(entry.id).then(value => setExtras(current => ({ ...current, [entry.id]: value }))).catch(() => undefined);
  }));
  const contentOf = (entry: UploadEntry): ViewerContent => contents()[`${entry.id}:${viewOf(entry.id)}:${entry.size}`] ?? { status: 'loading' };

  const open = (id: string, pin = false) => setTabs(current => openTab(current, id, pin));
  const setViewAs = (id: string, mode: ViewAs) => { setViewAsMap(current => ({ ...current, [id]: mode })); open(id); };
  const focusTab = (id: string | null) => queueMicrotask(() => id && tabElements.get(id)?.focus());

  /** Runs an api action with a toast for the outcome. Failures stay until dismissed. */
  async function act(label: string, entry: UploadEntry, run: () => Promise<unknown>, success?: string) {
    try { await run(); if (success) toaster.show(success); }
    catch (cause) { toaster.show(`Could not ${label} ${entry.name}: ${message(cause)}`, 'error'); }
  }
  const actions = (entry: UploadEntry) => ({
    save: () => act('save', entry, () => props.api.saveToWorkspace(entry.id), `${entry.name} saved to workspace`),
    reveal: () => act('reveal', entry, () => props.api.reveal(entry.id), `Revealed ${entry.name} in ${revealPlace(platform())}`),
    copyPath: () => act('copy the path of', entry, async () => navigator.clipboard.writeText(await props.api.path(entry.id)), `Copied path of ${entry.name}`),
    openWithSystem: () => act('open', entry, () => props.api.openWithSystem(entry.id), `Opened ${entry.name} externally`),
    chooseApplication: () => act('open', entry, () => props.api.chooseApplication(entry.id)),
    duplicate: () => act('duplicate', entry, async () => { await props.api.duplicate(entry.id); await refresh(); }, `Duplicated ${entry.name}`),
    showInSession: props.onShowInSession ? () => { props.onShowInSession!(entry); if (entry.session) toaster.show(`Jumped to ${entry.session.title}`); } : undefined,
  });

  async function rename(id: string, name: string): Promise<string | null> {
    const entry = byId().get(id);
    if (!entry) return 'This upload no longer exists.';
    try { await props.api.rename(id, name); setRenaming(null); await refresh(); toaster.show(`Renamed to ${name}`); return null; }
    catch (cause) { return message(cause); }
  }
  async function remove(id: string) {
    const entry = byId().get(id);
    setConfirmRemove(null);
    if (!entry) return;
    try {
      await props.api.remove(id);
      batch(() => { setTabs(current => closeTab(current, id)); setContents(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${id}:`)))); });
      await refresh();
      toaster.show(`Removed ${entry.name}`);
    } catch (cause) { toaster.show(`Could not remove ${entry.name}: ${message(cause)}`, 'error'); }
  }
  async function add() {
    try { const added = await props.api.add(); await refresh(); if (added.length) { toaster.show(`Added ${added.length} ${added.length === 1 ? 'file' : 'files'}`); open(added[0].id); } }
    catch (cause) { toaster.show(`Could not add files: ${message(cause)}`, 'error'); }
  }

  const menuItems = (state: MenuState): MenuItem[] => {
    const entry = byId().get(state.id);
    if (!entry) return [];
    const a = actions(entry);
    const external = { setViewAs: (mode: ViewAs) => setViewAs(entry.id, mode), openWithSystem: a.openWithSystem, chooseApplication: a.chooseApplication };
    if (state.kind === 'tab') {
      const list = tabs().tabs, index = list.findIndex(tab => tab.id === entry.id);
      return tabMenuItems(entry, caps(), {
        ...external,
        close: () => closeTabById(entry.id), closeOthers: () => setTabs(current => closeOtherTabs(current, entry.id)), closeRight: () => setTabs(current => closeTabsToRight(current, entry.id)), closeAll: () => setTabs(closeAllTabs()),
        keepOpen: () => setTabs(current => pinTab(current, entry.id)), copyPath: a.copyPath, reveal: a.reveal,
      }, { viewAs: viewOf(entry.id), platform: platform(), preview: !list[index]?.pinned, hasOthers: list.length > 1, hasRight: index >= 0 && index < list.length - 1 });
    }
    return fileMenuItems(entry, caps(), {
      ...external, openPreview: () => open(entry.id), openKeep: () => open(entry.id, true), saveToWorkspace: a.save, reveal: a.reveal, copyPath: a.copyPath, showInSession: a.showInSession,
      rename: () => setRenaming(entry.id), duplicate: a.duplicate, remove: () => setConfirmRemove(entry.id),
    }, { viewAs: viewOf(entry.id), platform: platform() });
  };

  const closeTabById = (id: string) => {
    const before = tabs();
    const next = closeTab(before, id);
    setTabs(next);
    if (before.active === id) focusTab(next.active);
  };
  const onTabKeyDown = (event: KeyboardEvent, id: string) => {
    const list = tabs().tabs, index = list.findIndex(tab => tab.id === id);
    const go = (target: number) => { event.preventDefault(); const tab = list[(target + list.length) % list.length]; if (tab) { setTabs(current => ({ ...current, active: tab.id })); focusTab(tab.id); } };
    if (event.key === 'ArrowRight') go(index + 1);
    else if (event.key === 'ArrowLeft') go(index - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(list.length - 1);
    else if (event.key === 'Delete' || (event.key === 'Backspace' && platform() === 'mac')) { event.preventDefault(); closeTabById(id); }
    else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { event.preventDefault(); const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ kind: 'tab', id, x: bounds.left, y: bounds.bottom + 4 }); }
    else if ((event.key === 'r' || event.code === 'KeyR') && event.altKey && (platform() === 'mac' ? event.metaKey : event.ctrlKey) && caps().reveal) { event.preventDefault(); const entry = byId().get(id); if (entry) void actions(entry).reveal(); }
  };

  const keys = () => shortcutLabels(platform());
  const hints = () => [
    { label: 'Open preview', key: keys().open }, { label: 'Keep open', key: 'Space' },
    ...(caps().rename ? [{ label: 'Rename', key: keys().rename }] : []), ...(caps().remove ? [{ label: 'Remove', key: keys().remove }] : []),
    ...(caps().reveal ? [{ label: revealLabel(platform()), key: keys().reveal }] : []),
  ];

  return <div class="up-workspace">
    <UploadsPanel entries={entries()} status={status()} message={status() === 'unavailable' ? props.api.unavailableReason : loadError()} activeId={tabs().active} capabilities={caps()} platform={platform()} now={now}
      usage={usage() || undefined} renaming={renaming()} confirmRemove={confirmRemove()}
      onOpen={open} onMenu={(id, at) => setMenu({ kind: 'file', id, ...at })} onAdd={caps().add ? () => void add() : undefined} onRetry={() => { setStatus('loading'); void refresh(); }}
      onRenameStart={setRenaming} onRenameCancel={() => setRenaming(null)} onRenameCommit={rename}
      onRemoveRequest={setConfirmRemove} onRemoveCancel={() => setConfirmRemove(null)} onRemoveConfirm={id => void remove(id)}
      onReveal={caps().reveal ? id => { const entry = byId().get(id); if (entry) void actions(entry).reveal(); } : undefined} onShowExplorer={props.onShowExplorer} />
    <section class="up-main" aria-label="Upload viewer">
      <div class="up-tabbar">
        <div class="up-tabs" role="tablist" aria-label="Open uploads">
          <For each={tabs().tabs}>{tab => {
            const entry = () => byId().get(tab.id);
            const selected = () => tabs().active === tab.id;
            return <Show when={entry()}>{item => <div class="up-tab" classList={{ 'up-tab-active': selected(), 'up-tab-preview': !tab.pinned }}
              onMouseDown={event => { if (event.button === 1) event.preventDefault(); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); closeTabById(tab.id); } }}
              onContextMenu={event => { event.preventDefault(); setMenu({ kind: 'tab', id: tab.id, x: event.clientX, y: event.clientY }); }}>
              <button ref={element => tabElements.set(tab.id, element)} type="button" role="tab" id={`up-tab-${tab.id}`} aria-selected={selected()} aria-controls="up-tabpanel" tabIndex={selected() ? 0 : -1}
                class="up-tab-label" onClick={() => setTabs(current => ({ ...current, active: tab.id }))} onDblClick={() => setTabs(current => pinTab(current, tab.id))} onKeyDown={event => onTabKeyDown(event, tab.id)}>
                <FileIcon path={item().name} class="up-tab-icon" /><span class="up-tab-name">{item().name}</span><Show when={!tab.pinned}><span class="vw-sr"> (preview)</span></Show>
              </button>
              <button type="button" class="up-tab-close" tabIndex={-1} aria-label={`Close ${item().name}`} title="Close" onClick={() => closeTabById(tab.id)}><Icon name="Close" size={9} /></button>
            </div>}</Show>;
          }}</For>
        </div>
        <Show when={active()}>{entry => <button type="button" class="up-icon-btn" aria-label="More actions" aria-haspopup="menu" title="More actions"
          onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); setMenu({ kind: 'file', id: entry().id, x: bounds.right - 240, y: bounds.bottom + 4 }); }}><Icon name="3DotsMore" size={14} /></button>}</Show>
      </div>
      <div id="up-tabpanel" class="up-panel" role="tabpanel" aria-labelledby={tabs().active ? `up-tab-${tabs().active}` : undefined}>
        <Show when={active()} keyed fallback={<div class="up-start">
          <span class="up-start-mark" aria-hidden="true">span</span>
          <Show when={props.api.available} fallback={<p>{props.api.unavailableReason ?? 'Uploads need the desktop app'}</p>}>
            <p>Open an upload to preview it</p>
            <dl class="up-start-keys">
              <For each={hints()}>{hint => <div><dt>{hint.label}</dt><dd><kbd><KeyGlyph value={hint.key} size={11} /></kbd></dd></div>}</For>
            </dl>
            <Show when={caps().add}><button type="button" class="vw-btn vw-btn-outline" onClick={() => void add()}><Icon name="ActionUpload" size={12} />Upload files</button></Show>
          </Show>
        </div>}>{entry => {
          const a = actions(entry);
          const line = sourceLine(entry, ms => formatUploadTime(ms, now()));
          return <FileViewer archiveApi={archiveApi()} name={entry.name} mime={entry.mime} size={entry.size} content={contentOf(entry)}
            source={{ agent: entry.agent, verb: line.verb, session: line.session, time: line.time }}
            viewAs={viewOf(entry.id)} onViewAsChange={mode => setViewAs(entry.id, mode)}
            openWith={{ system: caps().openWithSystem ? a.openWithSystem : undefined, choose: caps().chooseApplication ? a.chooseApplication : undefined }}
            extras={extras()[entry.id]}
            onSaveToWorkspace={caps().saveToWorkspace ? a.save : undefined}
            onReveal={caps().reveal ? a.reveal : undefined} revealLabel={revealLabel(platform())}
            onShowSessionList={props.onShowSessionList} reportActions={false} />;
        }}</Show>
      </div>
    </section>
    <Show when={menu()}>{state => {
      const entry = () => byId().get(state().id);
      return <UploadMenu items={menuItems(state())} x={state().x} y={state().y} label={`Actions for ${entry()?.name ?? 'upload'}`} title={entry()?.name}
        icon={entry() ? <FileIcon path={entry()!.name} class="up-menu-file" /> : undefined} onClose={() => setMenu(null)} />;
    }}</Show>
    <ToastHost toaster={toaster} />
  </div>;
}
