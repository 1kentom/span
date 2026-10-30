/**
 * Mount point for the document viewers. Each viewer is a lazy chunk, so mammoth, pdfjs-dist and
 * the parsers download only when a file of that kind opens. FileViewer renders this for the kinds
 * officeKindOf recognises.
 */
import { Match, Suspense, Switch, lazy } from 'solid-js';
import type { ArchiveApi } from '../../../lib/archive-api';
import type { OfficeKind } from '../../../lib/office/kind';
import { ViewerState } from '../ViewerStates';

const DocxView = lazy(() => import('./DocxView'));
const PptxView = lazy(() => import('./PptxView'));
const XlsxView = lazy(() => import('./XlsxView'));
const PdfView = lazy(() => import('./PdfView'));
const ArchiveView = lazy(() => import('../ArchiveView'));

export interface OfficeViewProps {
  kind: OfficeKind;
  name: string;
  bytes: Uint8Array;
  onMeta?: (parts: string[]) => void;
  onOpenWithSystem?: () => void;
  /** Archive backend. Without it, ZIP files are listed in the browser and extraction is disabled. */
  archiveApi?: ArchiveApi;
  onOpenEntry?: (path: string, bytes: Uint8Array) => void;
  onCopyPath?: (path: string) => void;
}

export function OfficeView(props: OfficeViewProps) {
  return <Suspense fallback={<ViewerState kind="loading" text={`Loading the viewer for ${props.name}…`} />}>
    <Switch>
      <Match when={props.kind === 'docx'}><DocxView name={props.name} bytes={props.bytes} onMeta={props.onMeta} onOpenWithSystem={props.onOpenWithSystem} /></Match>
      <Match when={props.kind === 'pptx'}><PptxView name={props.name} bytes={props.bytes} onMeta={props.onMeta} onOpenWithSystem={props.onOpenWithSystem} /></Match>
      <Match when={props.kind === 'xlsx'}><XlsxView name={props.name} bytes={props.bytes} onMeta={props.onMeta} onOpenWithSystem={props.onOpenWithSystem} /></Match>
      <Match when={props.kind === 'pdf'}><PdfView name={props.name} bytes={props.bytes} onMeta={props.onMeta} onOpenWithSystem={props.onOpenWithSystem} /></Match>
      <Match when={props.kind === 'archive'}><ArchiveView name={props.name} bytes={props.bytes} api={props.archiveApi} onMeta={props.onMeta} onOpenEntry={props.onOpenEntry} onCopyPath={props.onCopyPath} onOpenWithSystem={props.onOpenWithSystem} /></Match>
    </Switch>
  </Suspense>;
}
