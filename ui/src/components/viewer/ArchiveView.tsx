import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { formatAssetBytes } from '../../lib/asset-preview';
import { localZipArchiveApi, type ArchiveApi, type ArchiveListing, type ConflictMode, type ExtractOptions, type ExtractPlan, type ExtractProgress, type ExtractTargetKind } from '../../lib/archive-api';
import { allDirIds, buildArchiveTree, checkState, extractGate, filesUnder, selectedPaths, toggleSelection, visibleRows, type ArchiveNode, type ArchiveTree } from '../../lib/office/archive-tree';
import { rowWindow } from '../../lib/office/window';
import { OfficeError } from '../../lib/office/zip';
import { ARCHIVE_MAX_BYTES } from '../../lib/office/limits';
import { bytesToDataUrl, extensionOf } from '../../lib/viewer';
import Icon, { FileIcon } from '../Icon';
import { ViewerState } from './ViewerStates';
import { plural } from './office/shared';
import '../../styles/office.css';

export interface ArchiveViewProps {
  name: string;
  /** Archive bytes. In the browser preview a ZIP is listed from these with fflate. */
  bytes?: Uint8Array;
  /** Backend for listing, reading and extracting. Without it, ZIP bytes are listed locally and extraction is disabled. */
  api?: ArchiveApi;
  onMeta?: (parts: string[]) => void;
  /** Open an entry in a viewer tab. The eye button is shown only when this is given. */
  onOpenEntry?: (path: string, bytes: Uint8Array) => void;
  onOpenWithSystem?: () => void;
  /** Copies an entry path. Falls back to the browser clipboard. */
  onCopyPath?: (path: string) => void;
}

const ROW = 28;
const targetIcons: Record<ExtractTargetKind, string> = { workspace: 'Folder2', here: 'Import', choose: 'ExportSquare', 'new-folder': 'Copy' };
const conflictLabels: Record<ConflictMode, string> = { ask: 'Ask', keepBoth: 'Keep both', skip: 'Skip', replace: 'Replace' };
const imageMime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml' };
/** Entries read for the inline preview: text or an image, never more than the backend's 1 MiB. */
type Preview = { path: string; name: string } & ({ state: 'loading' } | { state: 'text'; text: string } | { state: 'image'; url: string } | { state: 'error'; message: string });
type RowMenu = { node: ArchiveNode; x: number; y: number };
const isAbort = (cause: unknown) => cause instanceof Error && cause.name === 'AbortError';
const isZipBytes = (b?: Uint8Array) => !!b && b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
const formatDate = (ms?: number) => ms === undefined ? '' : new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

type Job =
  | { phase: 'idle' }
  | { phase: 'planning'; label: string }
  | { phase: 'confirm'; label: string; plan: ExtractPlan; options: ExtractOptions }
  | { phase: 'running'; label: string; destination: string; progress: ExtractProgress; cancelling?: boolean }
  | { phase: 'done' | 'cancelled' | 'error'; text: string };

function Checkbox(props: { state: 'on' | 'off' | 'mixed'; label: string; disabled?: boolean; onToggle: () => void }) {
  let input: HTMLInputElement | undefined;
  createEffect(() => { if (input) input.indeterminate = props.state === 'mixed'; });
  return <input ref={input} type="checkbox" class="ox-check" aria-label={props.label} checked={props.state === 'on'} disabled={props.disabled}
    onClick={event => event.stopPropagation()} onChange={() => props.onToggle()} />;
}

function ArchiveBody(props: { name: string; api: ArchiveApi; listing: ArchiveListing; onMeta?: (parts: string[]) => void; onOpenEntry?: ArchiveViewProps['onOpenEntry']; onCopyPath?: (path: string) => void }) {
  const tree = createMemo<ArchiveTree>(() => buildArchiveTree(props.listing.entries));
  const [open, setOpen] = createSignal<Set<string>>(new Set());
  const [filter, setFilter] = createSignal('');
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [focus, setFocus] = createSignal(0);
  const [menu, setMenu] = createSignal(false);
  const [keepStructure, setKeepStructure] = createSignal(true);
  const [skipHidden, setSkipHidden] = createSignal(true);
  const [openWhenDone, setOpenWhenDone] = createSignal(false);
  const [keepExecutable, setKeepExecutable] = createSignal(false);
  const [preview, setPreview] = createSignal<Preview>();
  const [rowMenu, setRowMenu] = createSignal<RowMenu>();
  let rowMenuPanel: HTMLDivElement | undefined;
  const [conflict, setConflict] = createSignal<ConflictMode>('ask');
  const [job, setJob] = createSignal<Job>({ phase: 'idle' });
  const [status, setStatus] = createSignal('');
  const [scroll, setScroll] = createSignal({ top: 0, height: 600 });
  let list: HTMLDivElement | undefined;
  let menuButton: HTMLButtonElement | undefined;
  let menuPanel: HTMLDivElement | undefined;

  createEffect(on(tree, t => {
    // Open the first level so a fresh archive shows its top folders' contents, as in the design.
    setOpen(new Set(t.root.filter(n => n.dir && !n.unsafe).map(n => n.id)));
    setSelected(new Set<string>());
    const format = props.listing.method ? `${props.listing.format} · ${props.listing.method}` : props.listing.format;
    props.onMeta?.([`${plural(t.files, 'file')} · ${plural(t.folders, 'folder')}`, `${formatAssetBytes(t.size)} unpacked`, `${formatAssetBytes(t.packed)} packed`, format]);
  }));

  const rows = createMemo(() => visibleRows(tree().root, open(), filter()));
  const span = createMemo(() => rowWindow(scroll().top, ROW, scroll().height, rows().length));
  const allDirs = createMemo(() => allDirIds(tree().root));
  const allOpen = () => allDirs().length > 0 && allDirs().every(id => open().has(id));
  const rootNode = createMemo<ArchiveNode>(() => ({ id: 'root', name: '', path: '', dir: true, size: 0, packed: 0, children: tree().root, unsafe: false, implicit: true, hidden: false, encrypted: false }));
  const running = () => job().phase === 'planning' || job().phase === 'running' || job().phase === 'confirm';
  const gate = createMemo(() => extractGate({ canExtract: props.api.canExtract, safeFiles: tree().files, selected: selected().size, running: running() }));
  const targets = () => props.api.targets();
  /** The first target is the main button's: "workspace" in the contract's default order, "here" natively. */
  const primary = (): ExtractTargetKind => targets()[0]?.kind ?? 'workspace';
  const primaryLabel = () => primary() === 'here' ? 'Extract all here' : 'Extract all to workspace';
  const hasUnsafeReasons = () => tree().unsafe.some(entry => entry.unsafeReason);
  const canPreview = (node: ArchiveNode) => !node.dir && !node.unsafe && !node.encrypted;

  const toggleOpen = (node: ArchiveNode, force?: boolean) => {
    if (!node.dir) return;
    const next = new Set(open());
    if (force ?? !next.has(node.id)) next.add(node.id); else next.delete(node.id);
    setOpen(next);
  };
  const openEntry = async (node: ArchiveNode) => {
    if (!canPreview(node)) return;
    setStatus('');
    if (!props.onOpenEntry) return showPreview(node);
    try { props.onOpenEntry(node.path, await props.api.readEntry(node.path)); }
    catch (cause) { setStatus(`Could not open ${node.name}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  /** Inline preview of one entry. Images by extension, everything else as text; the backend refuses the rest. */
  async function showPreview(node: ArchiveNode) {
    const base = { path: node.path, name: node.name };
    setPreview({ ...base, state: 'loading' });
    try {
      const bytes = await props.api.readEntry(node.path);
      if (preview()?.path !== node.path) return;
      const mime = imageMime[extensionOf(node.name)];
      if (mime) setPreview({ ...base, state: 'image', url: bytesToDataUrl(bytes, mime) });
      else setPreview({ ...base, state: 'text', text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) });
    } catch (cause) {
      if (preview()?.path === node.path) setPreview({ ...base, state: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  const copyPath = (path: string) => {
    if (props.onCopyPath) props.onCopyPath(path);
    else void navigator.clipboard?.writeText(path).catch(() => setStatus('Could not copy the path.'));
  };
  const nodeFiles = (node: ArchiveNode) => filesUnder(node).map(f => f.path);
  const menuItems = (node: ArchiveNode) => {
    const items: { label: string; icon: string; run: () => void }[] = [];
    if (canPreview(node)) items.push({ label: 'Preview', icon: 'Eye', run: () => void openEntry(node) });
    if (props.api.canExtract && !node.unsafe && filesUnder(node).length && !running()) {
      for (const target of targets()) items.push({ label: target.label, icon: targetIcons[target.kind], run: () => void extract(nodeFiles(node), target.kind, node.name) });
    }
    items.push({ label: 'Copy path', icon: 'Copy', run: () => copyPath(node.path) });
    return items;
  };
  const openRowMenu = (node: ArchiveNode, x: number, y: number) => {
    setRowMenu({ node, x, y });
    queueMicrotask(() => rowMenuPanel?.querySelector<HTMLElement>('button')?.focus());
  };
  createEffect(() => {
    if (!rowMenu()) return;
    const onDown = (event: MouseEvent) => { if (!rowMenuPanel?.contains(event.target as Node)) setRowMenu(undefined); };
    document.addEventListener('mousedown', onDown);
    onCleanup(() => document.removeEventListener('mousedown', onDown));
  });

  const options = (paths: string[] | 'all', target: ExtractTargetKind, conflictMode = conflict()): ExtractOptions =>
    ({ target, paths, keepStructure: keepStructure(), skipHidden: skipHidden(), openWhenDone: props.api.canOpenWhenDone === false ? false : openWhenDone(), conflict: conflictMode,
      ...(props.api.canKeepExecutable ? { keepExecutable: keepExecutable() } : {}) });
  async function run(opts: ExtractOptions, label: string, plan: ExtractPlan) {
    setJob({ phase: 'running', label, destination: plan.destination, progress: { done: 0, total: plan.files } });
    try {
      const result = await props.api.extract(opts, progress => setJob(j => j.phase === 'running' ? { ...j, progress } : j));
      if (result.cancelled) setJob({ phase: 'cancelled', text: props.api.atomic ? 'Extraction cancelled. Nothing was extracted.' : `Extraction cancelled. ${plural(result.extracted, 'file')} written to ${result.destination}.` });
      else setJob({ phase: 'done', text: `Extracted ${plural(result.extracted, 'file')} to ${result.destination}${result.skipped ? `, ${result.skipped} skipped` : ''}` });
    } catch (cause) { setJob({ phase: 'error', text: `Extraction failed: ${cause instanceof Error ? cause.message : String(cause)}${props.api.atomic ? ' Nothing was extracted.' : ''}` }); }
  }
  async function extract(paths: string[] | 'all', target: ExtractTargetKind, label: string) {
    setMenu(false);
    const opts = options(paths, target);
    setJob({ phase: 'planning', label });
    try {
      const plan = await props.api.planExtract(opts);
      if (opts.conflict === 'ask' && plan.conflicts.length) { setJob({ phase: 'confirm', label, plan, options: opts }); return; }
      await run(opts, label, plan);
    } catch (cause) {
      if (isAbort(cause)) { setJob({ phase: 'idle' }); return; }
      setJob({ phase: 'error', text: `Extraction failed: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
  }
  const resolveConflict = (mode: Exclude<ConflictMode, 'ask'>) => { const j = job(); if (j.phase === 'confirm') void run({ ...j.options, conflict: mode }, j.label, j.plan); };
  // The job stays "Cancelling…" until the extractor reports what actually happened.
  const cancel = async () => {
    setJob(current => current.phase === 'running' ? { ...current, cancelling: true } : current);
    try { await props.api.cancel(); }
    catch (cause) { setStatus(`Could not request cancellation: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };

  // Close the options popover on Escape or a click outside it.
  createEffect(() => {
    if (!menu()) return;
    const onDown = (event: MouseEvent) => { if (!menuPanel?.contains(event.target as Node) && !menuButton?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', onDown);
    onCleanup(() => document.removeEventListener('mousedown', onDown));
    queueMicrotask(() => menuPanel?.querySelector<HTMLElement>('button, input')?.focus());
  });
  const closeMenu = () => { setMenu(false); menuButton?.focus(); };

  const focusRow = (index: number) => {
    const count = rows().length;
    if (!count) return;
    const i = Math.min(count - 1, Math.max(0, index));
    setFocus(i);
    if (list) {
      const top = i * ROW, viewport = list.clientHeight || 600;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + ROW > list.scrollTop + viewport) list.scrollTop = top + ROW - viewport;
      setScroll({ top: list.scrollTop, height: viewport });
    }
    queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-row="${i}"]`)?.focus());
  };
  const onRowKey = (event: KeyboardEvent, index: number) => {
    const row = rows()[index];
    if (!row) return;
    const { node } = row;
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusRow(index + 1), ArrowUp: () => focusRow(index - 1), Home: () => focusRow(0), End: () => focusRow(rows().length - 1),
      ArrowRight: () => { if (node.dir && !row.open) toggleOpen(node, true); else if (node.dir) focusRow(index + 1); },
      ArrowLeft: () => {
        if (node.dir && row.open) { toggleOpen(node, false); return; }
        for (let i = index - 1; i >= 0; i--) if (rows()[i].depth < row.depth) { focusRow(i); return; }
      },
      ' ': () => { if (!node.unsafe) setSelected(toggleSelection(selected(), node)); },
      ContextMenu: () => { const box = (event.currentTarget as HTMLElement).getBoundingClientRect(); openRowMenu(node, box.left + 24, box.bottom); },
      Enter: () => { if (node.dir) toggleOpen(node); else void openEntry(node); },
    };
    const action = event.key === 'F10' && event.shiftKey ? keys.ContextMenu : keys[event.key];
    if (!action || event.target instanceof HTMLInputElement || (event.target as HTMLElement).closest?.('button')) return;
    event.preventDefault();
    action();
  };

  const progressPercent = () => { const j = job(); return j.phase === 'running' && j.progress.total ? Math.min(100, Math.round(j.progress.done / j.progress.total * 100)) : j.phase === 'done' ? 100 : 0; };
  const selectedCount = () => selected().size;

  return <div class="ox-archive">
    <div class="ox-toolbar ox-archive-bar">
      <label class="ox-find ox-archive-filter">
        <Icon name="SearchNormal1" size={12} />
        <input class="ox-find-input" type="search" placeholder={`Filter ${plural(tree().files, 'file')}`} aria-label="Filter entries" value={filter()} onInput={e => setFilter(e.currentTarget.value)} />
      </label>
      <button type="button" class="vw-btn" disabled={!allDirs().length} onClick={() => setOpen(allOpen() ? new Set<string>() : new Set(allDirs()))}>{allOpen() ? 'Collapse all' : 'Expand all'}</button>
      <span class="vw-spacer" />
      <Show when={selectedCount() > 0}>
        <button type="button" class="vw-btn vw-btn-outline" disabled={!gate().selected} onClick={() => void extract(selectedPaths(tree().root, selected()), primary(), plural(selectedCount(), 'selected file'))}>Extract {selectedCount()} selected</button>
      </Show>
      <div class="ox-split">
        <button type="button" class="vw-btn vw-btn-primary ox-split-main" disabled={!gate().all} onClick={() => void extract('all', primary(), plural(tree().files, 'file'))}>{primaryLabel()}</button>
        <button type="button" class="vw-btn vw-btn-primary ox-split-toggle" ref={menuButton} aria-label="Extract options" aria-haspopup="dialog" aria-expanded={menu()} disabled={!gate().all} onClick={() => setMenu(!menu())}><Icon name="arrow-down4" size={10} /></button>
      </div>
      <Show when={menu()}>
        <div class="ox-popover" ref={menuPanel} role="dialog" aria-label="Extract options" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } }}>
          <For each={targets()}>{target => (
            <button type="button" class="ox-pop-item" onClick={() => void extract('all', target.kind, plural(tree().files, 'file'))}>
              <Icon name={targetIcons[target.kind]} size={14} />
              <span class="ox-pop-text"><span>{target.label}</span><span class="ox-dim">{target.detail}</span></span>
            </button>
          )}</For>
          <div class="ox-pop-sep" />
          <label class="ox-pop-toggle"><input type="checkbox" class="ox-check" checked={keepStructure()} onChange={e => setKeepStructure(e.currentTarget.checked)} />Keep folder structure</label>
          <label class="ox-pop-toggle"><input type="checkbox" class="ox-check" checked={skipHidden()} onChange={e => setSkipHidden(e.currentTarget.checked)} />Skip hidden files (.DS_Store, __MACOSX)</label>
          <Show when={props.api.canKeepExecutable}><label class="ox-pop-toggle"><input type="checkbox" class="ox-check" checked={keepExecutable()} onChange={e => setKeepExecutable(e.currentTarget.checked)} />Keep executable permission</label></Show>
          <Show when={props.api.canOpenWhenDone !== false}><label class="ox-pop-toggle"><input type="checkbox" class="ox-check" checked={openWhenDone()} onChange={e => setOpenWhenDone(e.currentTarget.checked)} />Open folder when done</label></Show>
          <div class="ox-pop-conflict"><span id="ox-conflict-label">{props.api.canKeepBoth ? 'If the folder exists' : 'If a file exists'}</span><span class="vw-spacer" />
            <div class="ox-segmented" role="radiogroup" aria-labelledby="ox-conflict-label">
              <For each={(props.api.canKeepBoth ? ['ask', 'keepBoth', 'skip', 'replace'] : ['ask', 'skip', 'replace']) as ConflictMode[]}>{mode => <button type="button" role="radio" aria-checked={conflict() === mode} class="ox-seg" onClick={() => setConflict(mode)}>{conflictLabels[mode]}</button>}</For>
            </div>
          </div>
        </div>
      </Show>
    </div>
    <Show when={gate().note}><p class="vw-note" role="note">{gate().note}</p></Show>
    <Show when={props.listing.truncated}><p class="vw-note" role="note">{`Only the first ${plural(props.listing.entries.length, 'entry', 'entries')} are listed. An archive this large cannot be extracted here.`}</p></Show>
    <Show when={tree().unsafe.length}>
      <div class="ox-warning" role="note">
        <Icon name="Warning2" size={13} />
        <div class="ox-warning-body">
          <span>{plural(tree().unsafe.length, 'entry', 'entries')} {hasUnsafeReasons() ? 'cannot be extracted safely' : tree().unsafe.length === 1 ? 'points outside the archive' : 'point outside the archive'} and {tree().unsafe.length === 1 ? 'is' : 'are'} always skipped.</span>
          <details><summary>Show {tree().unsafe.length === 1 ? 'it' : 'them'}</summary><ul class="ox-unsafe-list"><For each={tree().unsafe}>{entry => <li>{entry.path}<Show when={entry.unsafeReason}><span class="ox-dim">{`: ${entry.unsafeReason}`}</span></Show></li>}</For></ul></details>
        </div>
      </div>
    </Show>
    <Switch>
      <Match when={job().phase === 'planning'}><div class="ox-progress" role="status"><span>Preparing to extract {(job() as { label: string }).label}…</span></div></Match>
      <Match when={job().phase === 'confirm'}>{(() => { const j = () => job() as Extract<Job, { phase: 'confirm' }>;
        return <div class="ox-progress" role="alertdialog" aria-label="Files already exist">
          <span>{props.api.canKeepBoth ? `${j().plan.destination} already exists.` : `${plural(j().plan.conflicts.length, 'file')} already exist in ${j().plan.destination}.`}</span><span class="vw-spacer" />
          <Show when={props.api.canKeepBoth}><button type="button" class="vw-btn vw-btn-primary" onClick={() => resolveConflict('keepBoth')}>Keep both</button></Show>
          <button type="button" class="vw-btn vw-btn-outline" onClick={() => resolveConflict('skip')}>{props.api.canKeepBoth ? 'Skip' : 'Skip existing'}</button>
          <button type="button" class="vw-btn vw-btn-outline" onClick={() => resolveConflict('replace')}>Replace</button>
          <button type="button" class="vw-btn" onClick={() => setJob({ phase: 'idle' })}>Cancel</button>
        </div>; })()}</Match>
      <Match when={job().phase === 'running'}>{(() => { const j = () => job() as Extract<Job, { phase: 'running' }>;
        return <div class="ox-progress">
          <span class="ox-progress-text">Extracting {j().label} to {j().destination}</span>
          <span class="ox-bar" role="progressbar" aria-label="Extraction progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent()}><span class="ox-bar-fill" style={{ width: `${progressPercent()}%` }} /></span>
          <span class="ox-mono ox-dim">{progressPercent()}%</span>
          <button type="button" class="vw-btn" disabled={j().cancelling} onClick={() => void cancel()}>{j().cancelling ? 'Cancelling…' : 'Cancel'}</button>
        </div>; })()}</Match>
      <Match when={job().phase === 'done' || job().phase === 'cancelled' || job().phase === 'error'}>{(() => { const j = () => job() as { phase: string; text: string };
        return <div class="ox-progress" classList={{ 'ox-progress-error': j().phase === 'error' }} role={j().phase === 'error' ? 'alert' : 'status'}>
          <span class="ox-progress-text">{j().text}</span>
          <Show when={j().phase === 'done'}><span class="ox-bar" aria-hidden="true"><span class="ox-bar-fill" style={{ width: '100%' }} /></span><span class="ox-mono ox-dim">100%</span></Show>
          <span class="vw-spacer" /><button type="button" class="vw-btn" onClick={() => setJob({ phase: 'idle' })}>Dismiss</button>
        </div>; })()}</Match>
    </Switch>
    <Show when={status()}><p class="vw-note vw-note-error" role="alert">{status()}</p></Show>
    <div class="ox-archive-head" role="presentation">
      <span class="ox-col-check"><Checkbox state={checkState(rootNode(), selected())} label="Select all files" disabled={!tree().files} onToggle={() => setSelected(toggleSelection(selected(), rootNode()))} /></span>
      <span class="ox-col-name">Name</span><span class="ox-col-num">Size</span><span class="ox-col-num ox-col-packed">Packed</span><span class="ox-col-date">Modified</span><span class="ox-col-actions" />
    </div>
    <div class="ox-archive-list" ref={list} role="treegrid" aria-label={`Contents of ${props.name}`} aria-rowcount={rows().length} onScroll={e => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight || 600 })}>
      <Show when={rows().length} fallback={<p class="ox-empty ox-dim">{filter() ? `Nothing matches "${filter()}".` : 'This archive is empty.'}</p>}>
        <div style={{ height: `${rows().length * ROW}px`, position: 'relative' }}>
          <For each={rows().slice(span().start, span().end)}>{(row, i) => {
            const index = () => span().start + i();
            const node = row.node;
            return <div class="ox-row" classList={{ 'ox-row-unsafe': node.unsafe, 'ox-row-hidden': node.hidden }} role="row" data-row={index()} aria-level={row.depth + 1} aria-rowindex={index() + 1}
              aria-expanded={node.dir ? row.open : undefined} aria-selected={node.unsafe ? undefined : checkState(node, selected()) === 'on'} tabindex={focus() === index() ? 0 : -1}
              style={{ top: `${index() * ROW}px` }} onKeyDown={e => onRowKey(e, index())} onFocus={() => setFocus(index())}
              onClick={() => { setFocus(index()); if (node.dir) toggleOpen(node); }} onDblClick={() => void openEntry(node)}
              onContextMenu={e => { e.preventDefault(); setFocus(index()); openRowMenu(node, e.clientX, e.clientY); }}>
              <span class="ox-col-check" role="gridcell"><Checkbox state={checkState(node, selected())} label={`Select ${node.name}`} disabled={node.unsafe || !filesUnder(node).length} onToggle={() => setSelected(toggleSelection(selected(), node))} /></span>
              <span class="ox-col-name" role="gridcell">
                <span class="ox-indent" style={{ width: `${row.depth * 16}px` }} />
                <span class="ox-chev" aria-hidden="true"><Show when={node.dir}><Icon name={row.open ? 'arrow-down4' : 'arrow-right4'} size={10} /></Show></span>
                <FileIcon path={node.unsafe ? 'file' : node.name} directory={node.dir} open={row.open} class="ox-file-icon" />
                <span class="ox-name" title={node.path}>{node.name}</span>
                <Show when={node.unsafe}><span class="vw-sr"> (outside the archive, skipped)</span></Show>
                <Show when={node.encrypted}><span class="ox-dim"> (encrypted)</span></Show>
                <Show when={node.unsafe && node.reason}><span class="vw-sr">{`: ${node.reason}`}</span></Show>
              </span>
              <span class="ox-col-num ox-mono" role="gridcell">{node.dir && !node.size ? '' : formatAssetBytes(node.size)}</span>
              <span class="ox-col-num ox-col-packed ox-mono ox-dim" role="gridcell">{node.dir && !node.packed ? '' : formatAssetBytes(node.packed)}</span>
              <span class="ox-col-date ox-dim" role="gridcell">{formatDate(node.modified)}</span>
              <span class="ox-col-actions" role="gridcell">
                <Show when={canPreview(node)}>
                  <button type="button" class="vw-btn vw-btn-icon" tabindex="-1" aria-label={props.onOpenEntry ? `Open ${node.name} in a tab` : `Preview ${node.name}`} title={props.onOpenEntry ? 'Open in a tab' : 'Preview'} onClick={e => { e.stopPropagation(); void openEntry(node); }}><Icon name="Eye" size={12} /></button>
                </Show>
                <Show when={props.api.canExtract && !node.unsafe && filesUnder(node).length}>
                  <button type="button" class="vw-btn vw-btn-icon" tabindex="-1" aria-label={`Extract ${node.name}`} title="Extract this" disabled={running()} onClick={e => { e.stopPropagation(); void extract(nodeFiles(node), primary(), node.name); }}><Icon name="Import" size={12} /></button>
                </Show>
              </span>
            </div>;
          }}</For>
        </div>
      </Show>
    </div>
    <Show when={preview()}>{p => <section class="ox-preview" aria-label={`Preview of ${p().name}`}>
      <div class="ox-preview-head"><span class="ox-name" title={p().path}>{p().path}</span><span class="vw-spacer" />
        <button type="button" class="vw-btn vw-btn-icon" aria-label="Close preview" title="Close preview" onClick={() => setPreview(undefined)}><Icon name="CloseCircle" size={12} /></button></div>
      <Switch>
        <Match when={p().state === 'loading'}><p class="ox-dim ox-preview-note">Reading {p().name}…</p></Match>
        <Match when={p().state === 'error'}><p class="vw-note vw-note-error" role="alert">{(p() as { message: string }).message}</p></Match>
        <Match when={p().state === 'image'}><img class="ox-preview-image" src={(p() as { url: string }).url} alt={p().name} /></Match>
        <Match when={p().state === 'text'}><pre class="ox-preview-text">{(p() as { text: string }).text}</pre></Match>
      </Switch>
    </section>}</Show>
    <Show when={rowMenu()}>{m => <div class="ox-popover ox-row-menu" ref={rowMenuPanel} role="menu" aria-label={`Actions for ${m().node.name}`} style={{ position: 'fixed', left: `${m().x}px`, top: `${m().y}px` }}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setRowMenu(undefined); focusRow(focus()); } }}>
      <For each={menuItems(m().node)}>{item => <button type="button" role="menuitem" class="ox-pop-item" onClick={() => { setRowMenu(undefined); item.run(); }}><Icon name={item.icon} size={14} /><span class="ox-pop-text"><span>{item.label}</span></span></button>}</For>
    </div>}</Show>
  </div>;
}

export default function ArchiveView(props: ArchiveViewProps) {
  const oversized = () => (props.bytes?.byteLength ?? 0) > ARCHIVE_MAX_BYTES;
  const api = createMemo<ArchiveApi | undefined>(() => oversized() ? undefined : props.api ?? (isZipBytes(props.bytes) ? localZipArchiveApi(props.bytes!) : undefined));
  const [listing, setListing] = createSignal<{ state: 'loading' } | { state: 'ready'; value: ArchiveListing } | { state: 'error'; message: string; tooLarge: boolean }>({ state: 'loading' });
  createEffect(on(api, current => {
    let live = true;
    onCleanup(() => { live = false; });
    if (!current) return;
    setListing({ state: 'loading' });
    current.list().then(value => { if (live) setListing({ state: 'ready', value }); }, cause => { if (live) setListing({ state: 'error', message: cause instanceof Error ? cause.message : String(cause), tooLarge: cause instanceof OfficeError && cause.kind === 'too-large' }); });
  }));
  const format = () => extensionOf(props.name).toUpperCase() || 'this';
  return <Switch>
    <Match when={oversized()}><ViewerState kind="too-large" title="Large archive" text={`Archive preview is limited to ${formatAssetBytes(ARCHIVE_MAX_BYTES)}.`} /></Match>
    <Match when={!api()}><ViewerState kind="unsupported" title="Preview not available here" text={`Listing ${format()} archives needs the desktop app. The browser preview lists ZIP archives only.`}
      actions={props.onOpenWithSystem ? [{ label: 'Open with system app', onClick: props.onOpenWithSystem, primary: true }] : []} /></Match>
    <Match when={listing().state === 'loading'}><ViewerState kind="loading" text={`Reading ${props.name}…`} /></Match>
    <Match when={listing().state === 'error'}>{(() => { const e = () => listing() as { message: string; tooLarge: boolean };
      return <ViewerState kind={e().tooLarge ? 'too-large' : 'damaged'} title={e().tooLarge ? 'Large archive' : 'Cannot open this archive'} text={e().message} />; })()}</Match>
    <Match when={listing().state === 'ready'}><ArchiveBody name={props.name} api={api()!} listing={(listing() as { value: ArchiveListing }).value} onMeta={props.onMeta} onOpenEntry={props.onOpenEntry} onCopyPath={props.onCopyPath} /></Match>
  </Switch>;
}
