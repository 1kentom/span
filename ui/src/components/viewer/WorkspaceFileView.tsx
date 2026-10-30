import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { FileProbe } from '../../bindings';
import { formatAssetBytes } from '../../lib/asset-preview';
import { NOT_TEXT_MESSAGE } from '../../lib/binary-file';
import { officeKindOf, officeLabels } from '../../lib/office/kind';
import { classifyFile, extensionOf, readLimit } from '../../lib/viewer';
import { FileViewer, type ViewerContent } from './FileViewer';
import { TypeIcon, ViewerState, type StateAction } from './ViewerStates';

export interface WorkspaceFileViewProps {
  file: FileProbe;
  /** Reads raw bytes, refusing a file larger than `maxBytes`. */
  readBytes: (path: string, maxBytes: number) => Promise<Uint8Array>;
  onOpenWithSystem?: () => void | Promise<void>;
  onReveal?: () => void | Promise<void>;
  revealLabel?: string;
}

/** Kinds the shared viewer renders natively. Anything else that is not text gets the "Can't show this file" card. */
/** Matches the Rust viewer read ceiling. */
const MAX_READ_BYTES = 128 * 1024 * 1024;
/** Hex shows a prefix, but the read is whole-file, so it stays small. */
const HEX_WHOLE_FILE_BYTES = 16 * 1024 * 1024;
const viewable = new Set(['image', 'svg', 'audio', 'video', 'font']);

/** A workspace file's type, in words, for the card. */
export function fileTypeLabel(name: string): string {
  const office = officeKindOf(name);
  if (office) return officeLabels[office];
  const { kind, label } = classifyFile(name);
  if (label) return label;
  if (kind === 'audio' || kind === 'video' || kind === 'font' || kind === 'image') return kind[0].toUpperCase() + kind.slice(1);
  const ext = extensionOf(name);
  return ext ? `${ext.toUpperCase()} file` : 'Binary file';
}

/**
 * A workspace file that is not UTF-8 text, shown in an editor tab. Documents (Word, Excel, PowerPoint, PDF,
 * archives), images, audio, video and fonts open in the shared file viewer, read only. Everything else shows one
 * card with the file name, size and type and the next steps: open it with the default app, reveal it, or view
 * the raw bytes as hex. Nothing is ever decoded as text.
 */
export function WorkspaceFileView(props: WorkspaceFileViewProps) {
  const [hex, setHex] = createSignal(false);
  const [content, setContent] = createSignal<ViewerContent>({ status: 'loading' });
  const name = () => props.file.name;
  const native = createMemo(() => !!officeKindOf(name()) || viewable.has(classifyFile(name()).kind));
  const showViewer = () => native() || hex();

  createEffect(() => {
    if (!showViewer()) return;
    const { path, size } = props.file;
    const asHex = hex();
    // A document needs its whole container: 0 means too large, and the viewer says so without reading anything.
    const limit = readLimit(name(), '', size, asHex);
    let live = true;
    onCleanup(() => { live = false; });
    if (size > 0 && limit === 0) { setContent({ status: 'ready' }); return; }
    if (asHex && size > HEX_WHOLE_FILE_BYTES) { setContent({ status: 'error', message: `This file is ${formatAssetBytes(size)}. The hex view reads files up to ${formatAssetBytes(HEX_WHOLE_FILE_BYTES)}.` }); return; }
    setContent({ status: 'loading' });
    // The exact size, so a file that grew since it was inspected is refused instead of cut short.
    props.readBytes(path, size || MAX_READ_BYTES).then(bytes => {
      if (live) setContent({ status: 'ready', bytes: asHex ? bytes.subarray(0, limit || bytes.length) : bytes });
    }).catch(cause => { if (live) setContent({ status: 'error', message: cause instanceof Error ? cause.message : String(cause) }); });
  });

  const [failure, setFailure] = createSignal('');
  const run = (label: string, action: () => void | Promise<void>) => {
    setFailure('');
    void Promise.resolve().then(action).catch(cause => setFailure(`${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const actions = (): StateAction[] => [
    ...(props.onOpenWithSystem ? [{ label: 'Open with default app', onClick: () => run('Open with default app', props.onOpenWithSystem!), primary: true }] : []),
    ...(props.onReveal ? [{ label: props.revealLabel ?? 'Reveal', onClick: () => run(props.revealLabel ?? 'Reveal', props.onReveal!) }] : []),
    { label: 'View as hex', onClick: () => setHex(true) },
  ];

  return <section class="workspace-file-view" aria-label={`File ${name()}`}>
    <Show when={showViewer()} fallback={
      <div class="vw">
        <Show when={failure()}><div class="vw-banner vw-banner-error" role="alert">{failure()}</div></Show>
        <div class="vw-body">
        <ViewerState kind="unsupported" title="Can't show this file" text={NOT_TEXT_MESSAGE} icon={<TypeIcon path={name()} />} actions={actions()}>
          <dl class="vw-file-facts">
            <dt>Name</dt><dd title={name()}>{name()}</dd>
            <dt>Size</dt><dd>{formatAssetBytes(props.file.size)}</dd>
            <dt>Type</dt><dd>{fileTypeLabel(name())}</dd>
          </dl>
        </ViewerState>
      </div></div>
    }>
      <FileViewer
        name={name()}
        size={props.file.size || undefined}
        content={content()}
        inWorkspace
        viewAs={hex() ? 'hex' : 'preview'}
        onViewAsChange={value => setHex(value === 'hex')}
        openWith={props.onOpenWithSystem ? { system: props.onOpenWithSystem } : undefined}
        onOpenWithSystem={props.onOpenWithSystem}
        onReveal={props.onReveal}
        revealLabel={props.revealLabel}
      />
    </Show>
  </section>;
}
