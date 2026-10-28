import { For, Show, type JSX } from 'solid-js';
import Icon from '../Icon';
import type { Intake } from './intake';
import '../../styles/attachments.css';

/** Wraps the composer. Shows a visible drop state while files are dragged over it, and lists refusals. */
export function AttachmentDropZone(props: { intake: Intake; /** Message shown instead of the drop prompt when attaching is unavailable. */ unavailable?: string; class?: string; children: JSX.Element }) {
  const { intake } = props;
  return <div class={`att-dropzone ${props.class ?? ''}`} classList={{ 'att-dragging': intake.dragging(), 'att-dragging-blocked': intake.dragging() && !!props.unavailable }}
    onDragEnter={intake.onDragEnter} onDragOver={intake.onDragOver} onDragLeave={intake.onDragLeave} onDrop={intake.onDrop}>
    {props.children}
    <Show when={intake.dragging()}><div class="att-drop-overlay" role="status">{props.unavailable ?? 'Drop files to attach'}</div></Show>
    <AttachmentNotices intake={intake} />
  </div>;
}

/** Accessible list of refusals. Never silent: each rejected item is named with its reason. */
export function AttachmentNotices(props: { intake: Intake }) {
  return <Show when={props.intake.notices().length}>
    <div class="att-notices" role="alert">
      <ul><For each={props.intake.notices()}>{message => <li>{message}</li>}</For></ul>
      <button type="button" class="att-notice-dismiss" aria-label="Dismiss attachment messages" onClick={() => props.intake.dismissNotices()}><Icon name="CloseCircle" size={12} /></button>
    </div>
  </Show>;
}

/** Button that opens a native file chooser. When `unavailable` is set it is disabled and says why. */
export function AttachmentPickerButton(props: { intake: Intake; unavailable?: string; accept?: string; class?: string }) {
  let input!: HTMLInputElement;
  return <>
    <button type="button" class={`att-picker ${props.class ?? ''}`} disabled={!!props.unavailable} aria-label={props.unavailable ? `Attach files, unavailable: ${props.unavailable}` : 'Attach files'} title={props.unavailable ?? 'Attach files'} onClick={() => input.click()}><Icon name="Paperclip2" size={15} /></button>
    <input ref={input} class="att-file-input" type="file" multiple accept={props.accept} tabIndex={-1} aria-hidden="true" disabled={!!props.unavailable}
      onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void props.intake.addFiles(files, 'picked'); }} />
  </>;
}
